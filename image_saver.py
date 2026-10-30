"""TaiYang 图片保存 / 载入 —— 一个预览区搞定「存上游、载本地、删图、往下传」。

和 ComfyUI 自带的「保存图像」比，多了这几件事：
  ① 保存结果走自己的通道（ui.ty_saved）回给前端，所以节点里只有一个预览区，
     不会再被原生预览挤出一个多余的区域；
  ② 可以从本地载入图片（前端传到 input/TaiYang 下），也可以把不要的图从节点里移除；
  ③ 节点里的这些图能作为 IMAGE 往下游传 —— 接了上游就原样透传上游那批。
其它一律不做：不写 PNG 元数据、不生成缩略图、不进素材库。
"""

import base64
import json
import logging
import os
import re
import time

import numpy as np
import torch
from PIL import Image

import folder_paths

from aiohttp import web
from server import PromptServer

DEFAULT_SUBFOLDER = "TaiYang"
DEFAULT_PREFIX = "TaiYang_%Y-%m-%d-%H-%M-%S"
LIST_WIDGET = "图片清单"
LOG_PREFIX = "[图片保存]"

# Windows 文件名里不能出现的字符
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_sub(subfolder):
    """只留目录内部的相对路径，挡掉 .. 之类越界。"""
    sub = str(subfolder or "").replace("\\", "/").strip()
    parts = [p for p in sub.split("/") if p not in ("", ".", "..")]
    return "/".join(_BAD_CHARS.sub("_", p) for p in parts)


def _make_prefix(raw):
    """把 %Y-%m-%d 这类时间占位符换成实际时间；认不出来就原样用。"""
    text = str(raw or "").strip() or DEFAULT_PREFIX
    try:
        text = time.strftime(text)
    except Exception:
        pass
    return _BAD_CHARS.sub("_", text) or "TaiYang"


def _unique_path(folder, stem, ext=".png"):
    path = os.path.join(folder, stem + ext)
    n = 1
    while os.path.exists(path):
        path = os.path.join(folder, "%s_%d%s" % (stem, n, ext))
        n += 1
    return path


# ---------------------------------------------------------------------------
# 节点里那几张图：清单 -> 张量
# ---------------------------------------------------------------------------

_TYPE_GETTER = {
    "input": "get_input_directory",
    "temp": "get_temp_directory",
    "output": "get_output_directory",
}


def _parse_items(raw):
    """清单可能是 JSON 字符串，也可能已经是 list。"""
    data = raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "ignore")
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except Exception:
            return []
    if not isinstance(data, list):
        return []
    items = []
    for it in data:
        if isinstance(it, dict) and it.get("filename"):
            items.append({
                "filename": str(it.get("filename")),
                "subfolder": str(it.get("subfolder") or ""),
                "type": str(it.get("type") or "output"),
            })
    return items


def _items_from_workflow(extra_pnginfo, unique_id):
    """兜底：前端控件值没送到时，从工作流的 node.properties 里捞清单。"""
    try:
        wf = (extra_pnginfo or {}).get("workflow") or {}
        for node in wf.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                props = node.get("properties") or {}
                return _parse_items(props.get("ty_images") or [])
    except Exception:
        pass
    return []


def _resolve(item):
    """清单里的一条 -> 磁盘上的绝对路径；越界或不存在都返回 None。"""
    name = os.path.basename(str(item.get("filename") or ""))
    if not name:
        return None
    getter = getattr(folder_paths, _TYPE_GETTER.get(item.get("type"), "get_output_directory"), None)
    try:
        base = getter() if callable(getter) else folder_paths.get_output_directory()
    except Exception:
        base = folder_paths.get_output_directory()
    base = os.path.abspath(base)
    path = os.path.abspath(os.path.join(base, _safe_sub(item.get("subfolder")), name))
    try:
        if os.path.commonpath([base, path]) != base:
            return None
    except Exception:
        return None
    return path if os.path.isfile(path) else None


def _load_images(items):
    """把清单里的图读成一批 IMAGE 张量；一张都读不到返回 None。"""
    arrays = []
    for item in items:
        path = _resolve(item)
        if not path:
            logging.warning("%s 找不到这张图，跳过：%s", LOG_PREFIX, item)
            continue
        try:
            with Image.open(path) as im:
                arrays.append(np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0)
        except Exception as exc:
            logging.warning("%s 这张图读不出来，跳过：%s（%s）", LOG_PREFIX, path, exc)
    if not arrays:
        return None

    size = {a.shape[:2] for a in arrays}
    height = max(a.shape[0] for a in arrays)
    width = max(a.shape[1] for a in arrays)
    if len(size) > 1:
        logging.info("%s 几张图尺寸不一样，统一按最大尺寸 %dx%d 左上对齐，空出来的地方填黑。",
                     LOG_PREFIX, width, height)
    out = np.zeros((len(arrays), height, width, 3), dtype=np.float32)
    for i, arr in enumerate(arrays):
        out[i, :arr.shape[0], :arr.shape[1]] = arr
    return torch.from_numpy(out)


def _empty_image():
    """节点里一张图都没有时往下游给的东西：一张 64x64 黑图，免得下游断流。"""
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


class TaiYangImageSaver:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文件名前缀": ("STRING", {"default": DEFAULT_PREFIX,
                                    "tooltip": "接上游存图时用的文件名。可以用 %Y %m %d %H %M %S 这些时间占位符，"
                                               "同名自动加序号，不会覆盖。"}),
                "保存位置": ("STRING", {"default": DEFAULT_SUBFOLDER,
                                   "tooltip": "存在 output 下面的哪个文件夹。留空 = 直接存在 output 根目录。"}),
                LIST_WIDGET: ("STRING", {"default": "[]",
                                         "tooltip": "内部用：记录节点里现在这几张图，前端自动维护，不用手动改。"}),
            },
            "optional": {
                "图片": ("IMAGE", {"tooltip": "接上游：连了就把上游的图存下来、并原样往下传；"
                                             "不连就用节点里自己载入的图。"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图片",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "TaiYang"
    DESCRIPTION = ("一个预览区：接着上游就把图存下来并往下传；不接上游就显示节点里自己载入的图。"
                   "「载入图片」从本地挑图放进节点，「移除」把当前这张从节点里拿掉（硬盘上的文件不动），"
                   "节点里的图可以直接接给下游节点。"
                   "「返回」切到九宫格一次看完所有图，点某一格回到大图；新存、新载入、新截的图都排在后面。"
                   "「全景查看」把图当 360 全景环视，看到满意的角度可以截图存成新图（固定 4:3）。")
    SEARCH_ALIASES = ["taiyang", "save", "保存", "存图", "导出", "output", "载入", "预览", "图片"]

    def _save(self, images, prefix_raw, sub_raw):
        out_dir = folder_paths.get_output_directory()
        sub = _safe_sub(sub_raw)
        prefix = (sub + "/" if sub else "") + _make_prefix(prefix_raw)

        height, width = int(images.shape[1]), int(images.shape[2])
        full_folder, stem, counter, subfolder, _ = folder_paths.get_save_image_path(
            prefix, out_dir, width, height
        )

        results = []
        for image in images:
            arr = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            name = "%s_%05d_.png" % (stem, counter)
            img.save(os.path.join(full_folder, name), "PNG", compress_level=4)
            results.append({"filename": name, "subfolder": subfolder, "type": "output"})
            counter += 1
        return results

    def run(self, 文件名前缀=DEFAULT_PREFIX, 保存位置=DEFAULT_SUBFOLDER, **kwargs):
        incoming = kwargs.get("图片")
        if incoming is not None and len(incoming.shape) == 4 and incoming.shape[0] > 0:
            saved = self._save(incoming, 文件名前缀, 保存位置)
            return {"ui": {"ty_saved": saved}, "result": (incoming,)}

        # 没接上游：把节点里自己载入 / 之前存下的图往下传
        items = _parse_items(kwargs.get(LIST_WIDGET))
        if not items:
            items = _items_from_workflow(kwargs.get("extra_pnginfo"), kwargs.get("unique_id"))
        images = _load_images(items)
        if images is None:
            logging.info("%s 节点里还没有图片：点「载入图片」挑几张，或者把上游的图接进来。", LOG_PREFIX)
            return {"ui": {"ty_saved": []}, "result": (_empty_image(),)}
        return {"ui": {"ty_saved": []}, "result": (images,)}


# ---------------------------------------------------------------------------
# 前端「全景查看 → 截图保存」用的一条接口
# ---------------------------------------------------------------------------
_route_ready = False


def _register_routes():
    global _route_ready
    if _route_ready:
        return
    # 独立跑脚本（不经过 ComfyUI 启动流程）时 instance 还不存在，跳过即可
    srv = getattr(PromptServer, "instance", None)
    if srv is None:
        return

    @srv.routes.post("/taiyang/save_shot")
    async def taiyang_save_shot(request):
        try:
            post = await request.json()
        except Exception:
            return web.json_response({"error": "body 不是合法 JSON"}, status=400)

        data = str(post.get("data") or "")
        if data.startswith("data:"):
            data = data.split(",", 1)[-1]
        if not data:
            return web.json_response({"error": "没有图片数据"}, status=400)
        try:
            raw = base64.b64decode(data)
        except Exception as exc:
            return web.json_response({"error": "图片数据解不开：%s" % exc}, status=400)

        out_dir = folder_paths.get_output_directory()
        sub = _safe_sub(post.get("subfolder") or DEFAULT_SUBFOLDER) or DEFAULT_SUBFOLDER
        folder = os.path.join(out_dir, sub)
        os.makedirs(folder, exist_ok=True)

        stem = _make_prefix(post.get("filename") or "全景截图_%Y-%m-%d-%H-%M-%S")
        path = _unique_path(folder, stem)
        with open(path, "wb") as fh:
            fh.write(raw)

        return web.json_response({
            "filename": os.path.basename(path),
            "subfolder": sub.replace(os.sep, "/"),
            "type": "output",
        })

    _route_ready = True


_register_routes()


NODE_CLASS_MAPPINGS = {"TaiYangImageSaver": TaiYangImageSaver}
NODE_DISPLAY_NAME_MAPPINGS = {"TaiYangImageSaver": "图片保存/载入"}
