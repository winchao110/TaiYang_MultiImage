import json
import math
import os
import uuid

import folder_paths
import numpy as np
import torch
import torchaudio
from comfy.utils import common_upscale
from PIL import Image

MAX_IMAGES = 16
MAX_AUDIOS = 8


class TaiYangMultiImageLoader:
    """多图参考输入节点：16 路 IMAGE 输出，按顺序喂给各多图接入节点（Qwen Image 2.1 / MiniMax H3 等）。

    前端会自动把本节点的输出连到目标节点的 images.image_N 或 ref_images.ref_image_N 槽位，
    空槽位返回 None，避免把 64x64 黑图当成参考图送进模型。
    """

    def __init__(self):
        self.output_dir = folder_paths.get_input_directory()

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_files": ("STRING", {"default": "[]", "multiline": False}),
                # 选项必须与前端 MODE_OPTIONS 一一对应（multi_image.js），
                # 少一项会让面板里选到的目标提交时校验失败
                "auto_link": (["自动", "TextEncodeQwenImage21", "TextEncodeQwenImageEditPlus",
                               "TE_Qwen_Image_2_1_Prompt_Enhancer", "关闭"], {"default": "自动"}),
                "upscale_method": (["nearest-exact", "bilinear", "area", "bicubic", "lanczos"], {"default": "bilinear"}),
                # 0 = 不缩放（保持原分辨率）。>0 时按总像素数等比缩放，可填任意数字。
                "megapixels": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 16.0, "step": 0.01}),
                # 分辨率对齐步长：宽高都对齐到该数字的整数倍。
                # 放 required 而不是 optional+advanced：这个参数要在画布上直接改，
                # 放 optional 时前端可能拿不到 widget，界面会显示错误值。
                "resolution_steps": ("INT", {"default": 32, "min": 1, "max": 256}),
            },
        }

    RETURN_TYPES = tuple(["IMAGE"] * MAX_IMAGES)
    RETURN_NAMES = tuple([f"image_{i + 1}" for i in range(MAX_IMAGES)])
    RETURN_TYPES_AND_NAMES = tuple(zip(RETURN_TYPES, RETURN_NAMES))
    FUNCTION = "load_images"
    CATEGORY = "TaiYang"

    def _parse_files(self, image_files):
        if isinstance(image_files, (list, tuple)):
            raw = list(image_files)
        else:
            try:
                raw = json.loads(image_files or "[]")
            except Exception:
                raw = []
            if not isinstance(raw, list):
                raw = []
        return [f for f in raw if isinstance(f, str) and f.strip()][:MAX_IMAGES]

    def _load_one(self, rel_path):
        # 兼容带子目录的路径，如 "subfolder/xxx.png"
        rel = rel_path.replace("\\", "/").lstrip("/")
        path = os.path.abspath(os.path.join(self.output_dir, rel))
        root = os.path.abspath(self.output_dir)
        if os.path.commonpath([root, path]) != root:
            raise ValueError(f"非法路径: {rel_path}")
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        img = Image.open(path).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None,]

    def _scale_to_total_pixels(self, img, upscale_method, megapixels, resolution_steps):
        """把单张图缩放到「总像素数 = megapixels × 1024²」，等价于内置 ImageScaleToTotalPixels。

        做法与内置节点一致：先按面积比算缩放系数，再把宽高各自对齐到
        resolution_steps 的整数倍（避免缩出奇怪尺寸），最后用 common_upscale 重采样。
        megapixels <= 0 时表示不缩放，原样返回。
        """
        if megapixels is None or megapixels <= 0:
            return img

        # img 是 [B, H, W, C]，common_upscale 要 [B, C, H, W]
        # 注意 movedim(-1,1) 后 shape[2]=H、shape[3]=W，别取反了
        samples = img.movedim(-1, 1)
        total = float(megapixels) * 1024 * 1024
        height = samples.shape[2]
        width = samples.shape[3]
        if height <= 0 or width <= 0:
            return img

        scale_by = math.sqrt(total / (width * height))
        steps = max(1, int(resolution_steps or 32))
        # 对齐到 steps 的整数倍；至少保留 steps，防止极端参数缩成 0
        new_w = max(steps, int(round(width * scale_by / steps)) * steps)
        new_h = max(steps, int(round(height * scale_by / steps)) * steps)

        out = common_upscale(samples, new_w, new_h, upscale_method, "disabled")
        return out.movedim(1, -1)  # 还原成 [B, H, W, C]

    def load_images(self, image_files, auto_link="自动", upscale_method="bilinear",
                    megapixels=0.0, resolution_steps=32):
        files = self._parse_files(image_files)
        results = []
        for i in range(MAX_IMAGES):
            if i < len(files):
                try:
                    img = self._load_one(files[i])
                    img = self._scale_to_total_pixels(img, upscale_method, megapixels, resolution_steps)
                    results.append(img)
                except Exception as e:
                    print(f"[TaiYangMultiImageLoader] 读取失败 {files[i]}: {e}")
                    results.append(None)
            else:
                # 没图的槽位返回 None：不参与执行，也不会污染下游参考图
                results.append(None)
        return tuple(results)


class TaiYangMultiAudioLoader:
    """多音频参考输入节点：多路 AUDIO 输出，按顺序喂给各多音频接入节点。

    前端会自动把本节点的输出连到目标节点的：
      - MiniMaxH3ReferenceToVideo 的 ref_audios.ref_audio_N（autogrow 动态槽）
      - MiniMaxH3MaterialPromptStar7 的 ref_audio_N（schema 固定槽）
    空槽位返回 None，避免把无效音频送进模型。
    """

    def __init__(self):
        self.output_dir = folder_paths.get_input_directory()

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "audio_files": ("STRING", {"default": "[]", "multiline": False}),
                # 每条音频的裁剪区间 [{"n":文件名,"s":起始秒,"e":结束秒}, ...]
                # 前端两条竖线拖动后写入这里，执行时按区间切片。
                "trims": ("STRING", {"default": "[]", "multiline": False}),
                "auto_link": (["自动", "MiniMaxH3ReferenceToVideo", "MiniMaxH3MaterialPromptStar7", "关闭"], {"default": "自动"}),
            },
        }

    RETURN_TYPES = tuple(["AUDIO"] * MAX_AUDIOS)
    RETURN_NAMES = tuple([f"audio_{i + 1}" for i in range(MAX_AUDIOS)])
    RETURN_TYPES_AND_NAMES = tuple(zip(RETURN_TYPES, RETURN_NAMES))
    FUNCTION = "load_audios"
    CATEGORY = "TaiYang"

    def _parse_files(self, audio_files):
        if isinstance(audio_files, (list, tuple)):
            raw = list(audio_files)
        else:
            try:
                raw = json.loads(audio_files or "[]")
            except Exception:
                raw = []
            if not isinstance(raw, list):
                raw = []
        return [f for f in raw if isinstance(f, str) and f.strip()][:MAX_AUDIOS]

    @staticmethod
    def _norm_segment(start, end):
        """归一化单段裁剪区间，非法/整段返回 None，否则 (start, end or None)。

        与前端 normTrim 语义保持一致：end <= start 时视为「到结尾」，
        这样界面上显示的「2.00s → 结尾」和实际送进模型的结果才一致。
        """
        try:
            s = float(start or 0.0)
        except Exception:
            s = 0.0
        if s < 0:
            s = 0.0
        e = None if end is None else end
        if e is not None:
            try:
                e = float(e)
            except Exception:
                e = None
        if e is not None and e <= s:
            e = None
        if s <= 0 and e is None:
            return None  # 整段，不裁剪
        return (s, e)

    def _parse_trims(self, trims, files):
        """把 trims widget 解析成**与 files 按位置对齐**的 [(start,end), ...]。

        前端把裁剪区间存在 trims widget 里，两种格式都要认：
          - 新格式：数组按槽位对齐，元素为 {"s":..,"e":..} / null / [s, e]。
            这是当前前端的格式——**同名音频也能各自独立裁剪**。
          - 旧格式：数组元素为 {"n":文件名,"s":..,"e":..}（按文件名匹配）。
            早先版本按文件名存，这里保留兼容，别让老工作流丢区间。

        返回长度与 files 一致，第 i 项对应第 i 个音频。
        """
        if isinstance(trims, (list, tuple)):
            raw = list(trims)
        else:
            try:
                raw = json.loads(trims or "[]")
            except Exception:
                raw = []
            if not isinstance(raw, list):
                raw = []

        n = len(files)
        out = [None] * n

        # 旧格式：按文件名匹配（老工作流）
        by_name = {}
        for it in raw:
            if isinstance(it, dict) and isinstance(it.get("n"), str) and it.get("n"):
                seg = self._norm_segment(it.get("s"), it.get("e"))
                if seg is not None:
                    by_name[it["n"]] = seg
        if by_name:
            for i, f in enumerate(files):
                if f in by_name:
                    out[i] = by_name[f]
            return out

        # 新格式：按位置对齐
        for i, it in enumerate(raw[:n]):
            if it is None:
                continue
            if isinstance(it, dict):
                out[i] = self._norm_segment(it.get("s"), it.get("e"))
            elif isinstance(it, (list, tuple)) and len(it) >= 1:
                out[i] = self._norm_segment(it[0], it[1] if len(it) > 1 else None)
        return out

    def _load_one(self, rel_path, trim=None):
        # 兼容带子目录的路径，如 "subfolder/xxx.wav"
        rel = rel_path.replace("\\", "/").lstrip("/")
        path = os.path.abspath(os.path.join(self.output_dir, rel))
        root = os.path.abspath(self.output_dir)
        if os.path.commonpath([root, path]) != root:
            raise ValueError(f"非法路径: {rel_path}")
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        # 与 ComfyUI LoadAudio 一致：waveform [C,T] -> unsqueeze -> [1,C,T]
        waveform, sample_rate = torchaudio.load(path)

        # 按前端两条竖线设定的区间裁剪（单位：秒）
        if trim:
            start, end = trim
            total = waveform.shape[-1]
            i0 = max(0, min(total - 1, int(round(start * sample_rate))))
            i1 = total if end is None else max(i0 + 1, min(total, int(round(end * sample_rate))))
            waveform = waveform[..., i0:i1]

        return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}

    def load_audios(self, audio_files, trims="[]", auto_link="自动"):
        files = self._parse_files(audio_files)
        # 裁剪区间按位置对齐：第 i 项对应第 i 个音频（同名音频也各自独立）
        trim_list = self._parse_trims(trims, files)
        results = []
        for i in range(MAX_AUDIOS):
            if i < len(files):
                try:
                    seg = trim_list[i] if i < len(trim_list) else None
                    results.append(self._load_one(files[i], seg))
                except Exception as e:
                    print(f"[TaiYangMultiAudioLoader] 读取失败 {files[i]}: {e}")
                    results.append(None)
            else:
                # 没音频的槽位返回 None：不参与执行，也不会污染下游参考音频
                results.append(None)
        return tuple(results)


# ---------------------------------------------------------------- 面部去高光
# 算法在 face_dehighlight.py（纯 numpy/cv2/torch，不依赖 ComfyUI），这里只做节点封装。
# 两个模型下拉都是每次打开工作流时实时扫盘得到，往目录里丢模型就会出现在下拉里。


def _face_bbox_models():
    """扫 models/ultralytics/bbox/ 下的 .pt / .onnx 作为人脸检测模型候选。"""
    d = os.path.join(folder_paths.models_dir, "ultralytics", "bbox")
    if not os.path.isdir(d):
        return ["face_yolov8m.pt"]
    files = sorted(f for f in os.listdir(d) if f.lower().endswith((".pt", ".onnx")))
    return files or ["face_yolov8m.pt"]


def _face_parse_models():
    """扫 models/RMBG/ 下同时含 config.json 与 preprocessor_config.json 的子目录。"""
    root = os.path.join(folder_paths.models_dir, "RMBG")
    if not os.path.isdir(root):
        return ["segformer_face"]
    out = []
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if not os.path.isdir(p):
            continue
        need = ("config.json", "preprocessor_config.json")
        if all(os.path.exists(os.path.join(p, f)) for f in need):
            out.append(name)
    return out or ["segformer_face"]


def _checkpoint_models():
    """重绘用的 SDXL 底模候选。

    默认挑写实底模（名字里带 epicrealism / realism / real 之类），
    挑不到就退第一个 —— combo 的默认值必须真实存在于列表里，
    否则前端会拿不到值。
    """
    names = list(folder_paths.get_filename_list("checkpoints"))
    if not names:
        return ["（models/checkpoints 里没有底模）"]
    for kw in ("epicrealism", "realism", "realistic", "real"):
        hit = next((n for n in names if kw in n.lower()), None)
        if hit:
            return [hit] + [n for n in names if n != hit]
    return names


def _save_compare_preview(arr, tag, prefix="facedeh"):
    """把一张图写进 temp 目录，供节点内的「原图 / 结果」对比面板读取。

    temp 目录由 ComfyUI 提供静态访问（/view?type=temp），无需额外起服务。
    用 compress_level=1 而不是默认 6：1536² 的图能快好几倍，体积大一点无所谓。
    """
    try:
        name = f"ty_{prefix}_{tag}_{uuid.uuid4().hex[:12]}.png"
        Image.fromarray(arr).save(os.path.join(folder_paths.get_temp_directory(), name), compress_level=1)
        return {"filename": name, "subfolder": "", "type": "temp"}
    except Exception as e:
        print(f"[TaiYang] 对比预览写入失败: {e}")
        return None


class TaiYangFaceDehighlightInpaint:
    """面部去高光 · 重绘版：只把脸部高光那一小块送进 SDXL 局部重画。

    让模型把高光区重画一遍（denoise 0.45 保留原结构），毛孔和皮肤纹理是
    重新生成的，所以叫保纹理。代价是要加载一个 SDXL 底模、要跑采样。

    最早的「只取肤色」纯算法节点已从节点列表移除，但 face_dehighlight.py
    里的算法模块保留着 —— 本节点的遮罩完全靠它的 _face_boxes / _skin_mask。

    参数只留最关键的几项，其余（羽化、遮罩外扩、cfg、采样器、提示词）都按
    原始工作流写死：羽化 4px / 外扩 2px / cfg 5 / dpmpp_2m + karras。
    """

    CATEGORY = "TaiYang"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "高光阈值": ("FLOAT", {
                    "default": 0.75, "min": 0.30, "max": 0.99, "step": 0.01,
                    "display": "slider",
                    "tooltip": "亮度超过它的皮肤像素才算高光。越大 → 选中的范围越小；"
                               "脸上油光面积大就调低，只想去最亮的几点就调高",
                }),
                "底模": (_checkpoint_models(), {
                    "tooltip": "重绘用的 SDXL 底模，位于 models/checkpoints/。"
                               "写实系底模效果最好；换底模会连带换掉它自带的 CLIP 和 VAE",
                }),
                "YOLO模型": (_face_bbox_models(), {
                    "tooltip": "人脸检测模型，位于 models/ultralytics/bbox/。只用来框出脸，防止重绘跑到脸外",
                }),
                "segformer模型": (_face_parse_models(), {
                    "tooltip": "人脸解析模型，位于 models/RMBG/<名字>/。分出皮肤和鼻子，"
                               "眉毛眼睛嘴唇头发都不参与，所以不会把眼睛嘴唇画花",
                }),
                "种子": ("INT", {
                    "default": 123456789, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                    "control_after_generate": True,
                    "tooltip": "同一张图同参数，换个种子重绘结果会有细微差别",
                }),
                "步数": ("INT", {
                    "default": 28, "min": 1, "max": 100, "step": 1,
                    "tooltip": "采样步数。28 是原工作流的值；降噪只有 0.45，实际有效步数约为 步数×0.45",
                }),
                "降噪": ("FLOAT", {
                    "default": 0.45, "min": 0.05, "max": 1.0, "step": 0.01,
                    "display": "slider",
                    "tooltip": "改多少。0.45 = 保纹理（推荐）；调高更干净但会丢毛孔、"
                               "可能把人画成另一个人；调低改不干净",
                }),
            },
        }

    def run(self, image, **kw):
        from .face_dehighlight_inpaint import dehighlight_inpaint

        def num(v, d):
            try:
                f = float(v)
                return f if f == f else float(d)
            except (TypeError, ValueError):
                return float(d)

        threshold = num(kw.get("高光阈值"), 0.75)
        seed = int(num(kw.get("种子"), 123456789))
        steps = int(num(kw.get("步数"), 28))
        denoise = num(kw.get("降噪"), 0.45)

        ckpt_name = kw.get("底模") or ""
        ckpt_path = folder_paths.get_full_path("checkpoints", ckpt_name)
        if not ckpt_path:
            raise FileNotFoundError(
                f"找不到底模「{ckpt_name}」，请确认它在 models/checkpoints/ 下，"
                "或在下拉里换一个"
            )

        yolo_name = kw.get("YOLO模型") or "face_yolov8m.pt"
        yolo_path = os.path.join(folder_paths.models_dir, "ultralytics", "bbox", yolo_name)

        seg_name = kw.get("segformer模型") or "segformer_face"
        seg_dir = os.path.join(folder_paths.models_dir, "RMBG", seg_name)

        outs = []
        before = None
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            if i == 0:
                before = arr
            outs.append(dehighlight_inpaint(
                arr, ckpt_path, yolo_path, seg_dir,
                highlight_threshold=threshold,
                seed=seed + i,          # 批量时每张换种子，免得几张重绘得一模一样
                steps=steps,
                denoise=denoise,
            ))
        batch = np.stack([o.astype(np.float32) / 255.0 for o in outs], axis=0)

        ui = {}
        if before is not None and outs:
            a = _save_compare_preview(before, "before", prefix="dehinp")
            b = _save_compare_preview(outs[0], "after", prefix="dehinp")
            if a and b:
                ui["ty_compare"] = [a, b]

        return {"ui": ui, "result": (torch.from_numpy(batch),)}


# 「图片调整」的 12 个滑杆：(节点上显示的参数名, 算法层关键字, 默认值, 提示)
# 顺序就是节点上从上到下的顺序，按「光调 → 色彩 → 细节 → 效果」分组排。
_ADJUST_PARAMS = [
    ("曝光", "exposure", 4, "整体明暗。每 100 ≈ ±1 档光"),
    ("对比度", "contrast", 0, "以中灰为轴，压/放黑白两端"),
    ("高光", "highlights", 6, "只作用于亮部。负数压高光救回死白，正数提亮高光"),
    ("阴影", "shadows", -14, "只作用于暗部。负数压暗加深层次，正数提亮暗部"),
    ("鲜明度", "brilliance", 11, "低饱和处加饱和 + 中间调提亮，做出通透感；已经很艳的地方少动"),
    ("饱和度", "saturation", 0, "整体加/减彩。拉到 -100 变黑白"),
    ("色温", "temperature", -4, "正数偏暖（加红减蓝），负数偏冷（加蓝减红）"),
    ("色调", "tint", 0, "正数偏品红（减绿），负数偏绿"),
    ("色相", "hue", 0, "整体转色相，±100 = ±180°"),
    ("清晰度", "clarity", 0, "中频局部对比，加通透感（PS / ACR 的清晰度）"),
    ("锐化", "sharpen", 0, "高频锐化（USM），提细节边缘"),
    ("暗角", "vignette", 0, "正数压暗四角，负数四角发光"),
]


class TaiYangImageAdjust:
    """图片调整：一套手机修图滑杆 + 几个 PS 常用参数，共 13 项。

    参数名全部中文，方便对着 PS / 修图软件里的叫法调；前 12 项范围一律 -100 ~ +100，
    0 = 不动，正负对称；第 13 项「效果强度」是 0 ~ 100 的整体强度。
    默认值就是常用配方
    （曝光+4 / 鲜明度+11 / 高光+6 / 阴影-14 / 色温-4，其余 0，效果强度 100）。

    计算顺序 色温 → 色调 → 曝光 → 对比度 → 高光/阴影 → 色相 → 饱和度
    → 鲜明度 → 清晰度 → 锐化 → 暗角 → 效果强度：
    先白平衡和曝光，后面按亮度加权的步骤才有意义；对比度放在高光/阴影之前；
    饱和类放在细节之前，清晰度/锐化只做亮度细节，不会把噪点染成彩点；
    暗角永远最后；效果强度只是最后把结果按比例混回原图，不参与计算。

    为什么叫「效果强度」而不是「透明度」：它不改画面明暗、也不输出 alpha，
    只决定前面 12 项的效果上几成（100 = 全上，0 = 原图）。
    参数本身很轻时（比如默认那套只有 3~4 个灰阶的改动），强度减半后不足 2 个灰阶，
    肉眼本来就分辨不出——这时把强度当「减弱重效果」用才有意义。

    节点面板是「左边原图 + 右边滑块」：跑一次之后原图会被缓存成底图，
    之后拖任意滑块都在前端直接重算重画，不用反复执行节点，方便边拖边看。
    右列顶部还有个预设下拉（原图 / 通用风格 5 种 / 电影调色 3 种 / 类型片调色 5 种 /
    默认配方），点一下整套参数就位，每个参数旁边也能直接填数字。
    下拉下面可以给当前这套参数起名、点「保存」存进「我的预设」（浏览器本地），
    选中后点「删除」即可移除；内置预设不会被删掉。
    输入接 IMAGE、输出接 IMAGE，参数照常写进工作流。
    """

    CATEGORY = "TaiYang"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls):
        spec = {"image": ("IMAGE",)}
        for cn, _en, default, tip in _ADJUST_PARAMS:
            spec[cn] = ("INT", {
                "default": default, "min": -100, "max": 100, "step": 1,
                "display": "slider", "tooltip": tip,
            })
        # 第 13 个参数：效果强度。口径和上面 12 项不同（0 ~ 100，不是 ±100），
        # 所以单独加；放在最后，旧工作流按位置取参数不会被它挤歪。
        spec["效果强度"] = ("INT", {
            "default": 100, "min": 0, "max": 100, "step": 1,
            "display": "slider",
            "tooltip": "前面 12 项的效果整体上几成。100 = 全量生效，0 = 原图；"
                       "它不改明暗、不输出 alpha，只按比例把调整结果混回原图",
        })
        return {"required": spec}

    def run(self, image, **kw):
        from .image_adjust import adjust

        def num(v, d):
            """空字符串 / 非法值一律回落默认，绝不让它抛出去。"""
            try:
                f = float(v)
                return f if f == f else float(d)   # f != f 即 NaN
            except (TypeError, ValueError):
                return float(d)

        # 中文参数名 → 算法层英文关键字，改名不会牵动算法
        args = {en: num(kw.get(cn), default) for cn, en, default, _ in _ADJUST_PARAMS}
        # 兼容旧工作流 / API 调用里可能残留的旧名「透明度」
        args["opacity"] = num(kw.get("效果强度", kw.get("透明度")), 100)

        outs = []
        before = None
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            if i == 0:
                before = arr
            outs.append(adjust(arr, **args))
        batch = np.stack([o.astype(np.float32) / 255.0 for o in outs], axis=0)

        ui = {}
        if before is not None and outs:
            # 原图单独下发一路：前端拿它做「拖滑块即时出效果」的底图，
            # 这样调参数不用反复执行节点。
            src = _save_compare_preview(before, "src", prefix="adjust")
            if src:
                ui["ty_adjust_src"] = [src]
            a = _save_compare_preview(before, "before", prefix="adjust")
            b = _save_compare_preview(outs[0], "after", prefix="adjust")
            if a and b:
                ui["ty_compare"] = [a, b]

        return {"ui": ui, "result": (torch.from_numpy(batch),)}


class TaiYangImageCompare:
    """图片对比：接 A / B 两路图片，节点内叠加显示，鼠标移进去就能扫着比。

    专门用来看「改前 / 改后」的差异，本身不改图——输出直接把 B 图原样递出去，
    所以想存图的话后面接一个 SaveImage 就行；不接也不影响对比。

    两图尺寸不同也能比，但叠加时 A 会被拉到 B 的显示矩形里对齐，
    面板底部会提示尺寸不一致。
    """

    CATEGORY = "TaiYang"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    # 本节点本质是「看图的地方」，和 PreviewImage 一样算输出端。
    # 不加这一行的话：ComfyUI 只执行「输出节点 + 它们的上游」，
    # 输出端口没接下游时整条链子不在执行路径上，run() 根本不会跑，
    # ui.ty_compare 也就永远不回来 —— 面板一直是空白的。
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        # 两路都声明成 optional：它是个「看图的地方」，忘了接线不该让整条队列报错，
        # 更不该把同一张图里其他正常的输出节点一起带崩。
        return {
            "optional": {
                "image_a": ("IMAGE", {
                    "tooltip": "A 图，显示在面板左半边（标签「A」）",
                }),
                "image_b": ("IMAGE", {
                    "tooltip": "B 图，显示在面板右半边（标签「B」），也是本节点的输出",
                }),
            },
        }

    def run(self, image_a=None, image_b=None):
        def first_u8(t):
            x = t[0] if getattr(t, "ndim", 3) == 4 else t
            return (x.detach().cpu().numpy() * 255.0).clip(0, 255).round().astype(np.uint8)

        ui = {}
        if image_a is not None and image_b is not None:
            try:
                a_img = _save_compare_preview(first_u8(image_a), "before", prefix="cmp")
                b_img = _save_compare_preview(first_u8(image_b), "after", prefix="cmp")
                if a_img and b_img:
                    ui["ty_compare"] = [a_img, b_img]
            except Exception as e:
                print(f"[图片对比] 预览生成失败: {e}")

        # 没接 B 就递一张 8×8 占位图，下游接了 SaveImage 也只是多存张小图，不会崩
        out = image_b if image_b is not None else torch.zeros((1, 8, 8, 3))
        return {"ui": ui, "result": (out,)}


# ---------------------------------------------------------------- 小脸涂抹
# 算法在 small_face_erase.py，这里只做节点封装。


class TaiYangSmallFaceErase:
    """把小脸涂成纯色，让大模型只参考主视图那张大脸。

    多视角人像参考图（一张大脸 + 若干张正面/侧面小脸）直接喂给大模型时，
    小脸会把注意力分走。这里按「面积最大的那张算主脸」把其余的整片涂掉。

    全流程纯 CV，不加载任何大模型：YOLO 检脸 + 圆角矩形填色，1 秒内出结果。
    身体、头发、衣服一律不动，只盖住脸。

    为什么不按位置判断谁是小脸：素材里小脸的位置不固定（右上、中上、左侧都可能），
    但面积差得很干净（实测主脸 4.07%，小脸 0.40% / 0.29%），所以直接按面积排序。
    """

    CATEGORY = "TaiYang"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "人脸模型": (_face_bbox_models(), {
                    "tooltip": "人脸检测模型，位于 models/ultralytics/bbox/",
                }),
                "检测阈值": ("FLOAT", {
                    "default": 0.12, "min": 0.02, "max": 0.90, "step": 0.01,
                    "tooltip": "放低才能检出纯侧脸（实测侧脸 conf 0.81）；"
                               "如果画面里的非人脸被误涂，就调高一些",
                }),
                "保留脸数": ("INT", {
                    "default": 1, "min": 0, "max": 8, "step": 1,
                    "tooltip": "按面积从大到小保留前几张脸不涂。"
                               "1 = 只留最大的主脸（常用）；0 = 全涂；2 = 主脸 + 第二大的也留着",
                }),
                "涂抹倍数": ("FLOAT", {
                    "default": 1.8, "min": 1.0, "max": 4.0, "step": 0.1,
                    "tooltip": "小脸框居中放大倍数。YOLO 对纯侧脸框得偏窄，1.5 倍会露鼻子和嘴，"
                               "1.8 倍实测刚好全盖住、头发基本还在；2.2 以上开始吃头发",
                }),
                "填充色": (["自动背景", "纯白", "纯黑", "中灰"], {
                    "default": "自动背景",
                    "tooltip": "自动背景 = 取画布四边像素的中位色，纯色背景素材最贴合、看不出补丁",
                }),
            },
        }

    def run(self, image, **kw):
        from .small_face_erase import erase_small_faces, FILL_CHOICES

        def num(v, d):
            try:
                f = float(v)
                return f if f == f else float(d)
            except (TypeError, ValueError):
                return float(d)

        conf = num(kw.get("检测阈值"), 0.12)
        keep = int(num(kw.get("保留脸数"), 1))
        scale = num(kw.get("涂抹倍数"), 1.8)
        fill = kw.get("填充色") or "自动背景"
        if fill not in FILL_CHOICES:
            fill = "自动背景"

        yolo_name = kw.get("人脸模型") or "face_yolov8m.pt"
        yolo_path = os.path.join(folder_paths.models_dir, "ultralytics", "bbox", yolo_name)
        if not os.path.exists(yolo_path):
            raise FileNotFoundError(
                f"找不到人脸检测模型「{yolo_name}」，请确认它在 models/ultralytics/bbox/ 下"
            )

        outs, masks = [], []
        before = None
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            if i == 0:
                before = arr
            o, m, _nf, _ne = erase_small_faces(
                arr, yolo_path, conf=conf, keep_top=keep, scale=scale, fill=fill,
            )
            outs.append(o)
            masks.append(m)

        batch = np.stack([o.astype(np.float32) / 255.0 for o in outs], axis=0)
        mask = np.stack(masks, axis=0).astype(np.float32)

        # 复用面部去高光的对比面板：左原图 / 右涂抹后
        ui = {}
        if before is not None and outs:
            a = _save_compare_preview(before, "before", prefix="smallface")
            b = _save_compare_preview(outs[0], "after", prefix="smallface")
            if a and b:
                ui["ty_compare"] = [a, b]

        return {"ui": ui, "result": (torch.from_numpy(batch), torch.from_numpy(mask))}


NODE_CLASS_MAPPINGS = {
    "TaiYangMultiImageLoader": TaiYangMultiImageLoader,
    "TaiYangMultiAudioLoader": TaiYangMultiAudioLoader,
    "TaiYangFaceDehighlightInpaint": TaiYangFaceDehighlightInpaint,
    "TaiYangImageAdjust": TaiYangImageAdjust,
    "TaiYangImageCompare": TaiYangImageCompare,
    "TaiYangSmallFaceErase": TaiYangSmallFaceErase
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TaiYangMultiImageLoader": "多图载入",
    "TaiYangMultiAudioLoader": "多音频载入",
    "TaiYangFaceDehighlightInpaint": "面部去高光（重绘·保纹理）",
    "TaiYangImageAdjust": "图片调整",
    "TaiYangImageCompare": "图片对比",
    "TaiYangSmallFaceErase": "小脸涂抹（去参考图杂脸）"
}
