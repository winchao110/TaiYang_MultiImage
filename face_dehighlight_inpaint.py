"""面部去高光 · SDXL 局部重绘版（保纹理）

和 :mod:`face_dehighlight`（纯算法取色回填）是两条不同的路：

* 纯算法版：直接把高光区的颜色换掉，快、不依赖大模型，但肤质细节是"抹"出来的
* 本模块：只把人脸高光那小块**送进 SDXL 重画**（denoise 0.45，保留原结构），
  毛孔、绒毛、皮肤纹理都是模型重新生成的，所以叫"保纹理"

链路与工作流 ``面部去高光_皮肤鼻子精确版保纹理.json`` 一一对应：

    LoadImage
      ├─ YOLO 人脸框 ─────────────┐
      ├─ segformer 皮肤+鼻子 ── ∩ ─┤
      └─ 亮度 Y > 阈值(0.75) ───── ∩ ──► 遮罩
                                          ↓
                              GrowMaskWithBlur(expand=2, blur=4)
                                          ↓
      VAEEncode → SetLatentNoiseMask → KSampler(28 步 / cfg 5 / dpmpp_2m+karras / denoise 0.45)
                                          ↓
                                    VAEDecode ──► 按遮罩贴回原图

对外只暴露 :func:`dehighlight_inpaint`。
"""

import os

import cv2
import numpy as np
import torch

from .face_dehighlight import _clamp, _face_boxes, _skin_mask

__all__ = ["dehighlight_inpaint"]

# 工作流里写死的提示词。改这两个常量就等于改工作流里的两个 CLIPTextEncode。
POSITIVE = (
    "matte skin, natural skin texture, realistic pores, even soft lighting, no shine, "
    "uniform facial lighting, retain original facial features"
)
NEGATIVE = (
    "shiny skin, oily highlight, specular reflection, plastic skin, greasy forehead, "
    "blown highlights, whitened teeth, deformed lips, changed eyes"
)

SAMPLER = "dpmpp_2m"
SCHEDULER = "karras"
CFG = 5.0

# 底模缓存。和 face_dehighlight 一样只留一份：SDXL 全套（UNet+CLIP+VAE）
# 少说 6~7GB，留着两份在 22G 卡上必炸。
_CKPT_CACHE = {}


def _load_checkpoint(path):
    """加载 SDXL 底模，返回 (model, clip, vae)。"""
    key = os.path.abspath(path)
    if key not in _CKPT_CACHE:
        import folder_paths

        import comfy.sd

        out = comfy.sd.load_checkpoint_guess_config(
            path,
            output_vae=True,
            output_clip=True,
            output_clipvision=False,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        _CKPT_CACHE.clear()
        _CKPT_CACHE[key] = (out[0], out[1], out[2])
    return _CKPT_CACHE[key]


def build_mask(rgb, yolo_model, segformer_model, threshold=0.75, expand=2, blur=4.0):
    """生成重绘遮罩，返回 0~1 的 float32 (H, W)；没有需要重绘的地方返回 None。

    与工作流的三处 MaskComposite 等价：
        face_bbox ∩ skin_nose = ③′
        ③′ ∩ (亮度 > 阈值)     = 最终遮罩
    再照 GrowMaskWithBlur 的取值（expand=2 / blur_radius=4）外扩柔化。
    """
    h, w = rgb.shape[:2]

    boxes = _face_boxes(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), yolo_model)
    if not boxes:
        return None

    face = np.zeros((h, w), np.uint8)
    for x0, y0, x1, y1 in boxes:
        cv2.rectangle(face, (int(x0), int(y0)), (int(x1), int(y1)), 1, -1)

    try:
        skin = _skin_mask(rgb, segformer_model).astype(np.uint8)
    except Exception as e:
        # 解析模型挂了也别让整条流程崩：退回「脸框内偏亮的区域都算皮肤」
        print(f"[去高光·重绘] 肤色解析失败({e})，退回按亮度估皮肤")
        skin = (rgb.astype(np.float32).mean(axis=2) > 76).astype(np.uint8)

    base = face & skin

    img = rgb.astype(np.float32) / 255.0
    lum = 0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2]
    mask = base & (lum > threshold).astype(np.uint8)

    if mask.sum() == 0:
        return None

    if expand > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand * 2 + 1, expand * 2 + 1))
        mask = cv2.dilate(mask, k)

    m = mask.astype(np.float32)
    if blur > 0:
        # 工作流 blur_radius=4 / lerp_alpha=1 / decay_factor=1，
        # 化简下来就是「纯高斯模糊」，sigma 取半径。
        m = cv2.GaussianBlur(m, (0, 0), float(blur))
    return np.clip(m, 0.0, 1.0)


def _resize_to(arr, h, w):
    """VAE 编解码会按 8 取整，尺寸可能差一两个像素，贴回去之前对齐。"""
    if arr.shape[0] == h and arr.shape[1] == w:
        return arr
    return cv2.resize(arr, (w, h), interpolation=cv2.INTER_LINEAR)


def dehighlight_inpaint(
    rgb,
    ckpt_path,
    yolo_model,
    segformer_model,
    highlight_threshold=0.75,
    seed=123456789,
    steps=28,
    denoise=0.45,
    expand=2,
    blur=4.0,
):
    """SDXL 局部重绘去掉人脸高光，返回 uint8 RGB 数组 (H, W, 3)。

    没检测到人脸 / 皮肤上没有高光时原样返回（不浪费一次采样）。
    """
    highlight_threshold = _clamp(highlight_threshold, 0.30, 1.0, 0.75)
    steps = int(round(_clamp(steps, 1, 200, 28)))
    denoise = _clamp(denoise, 0.0, 1.0, 0.45)

    mask = build_mask(
        rgb, yolo_model, segformer_model,
        threshold=highlight_threshold, expand=expand, blur=blur,
    )
    if mask is None:
        print("[去高光·重绘] 皮肤区域没找到高光，原图返回"
              "（可调低高光阈值；一直这样请检查 segformer 模型）")
        return rgb

    h, w = rgb.shape[:2]
    src = torch.from_numpy(rgb.astype(np.float32) / 255.0).unsqueeze(0)   # [1,H,W,3]

    # 采样相关的东西全在这里 import：模块本身要能在没有 ComfyUI 的环境里被 import 而不炸
    from nodes import common_ksampler

    model, clip, vae = _load_checkpoint(ckpt_path)

    # 注意 vae.encode 返回的是裸 tensor（VAEEncode 节点才把它包成 {"samples": ...}）
    latent = {"samples": vae.encode(src)}
    # 原尺寸遮罩直接挂上去，common_ksampler → comfy.sample 会自己插值到 latent 尺寸
    latent["noise_mask"] = torch.from_numpy(mask).unsqueeze(0).unsqueeze(0)

    positive = clip.encode_from_tokens_scheduled(clip.tokenize(POSITIVE))
    negative = clip.encode_from_tokens_scheduled(clip.tokenize(NEGATIVE))

    out = common_ksampler(
        model, int(seed), steps, CFG, SAMPLER, SCHEDULER,
        positive, negative, latent, denoise=denoise,
    )[0]

    decoded = vae.decode(out["samples"])
    dec = decoded[0].detach().cpu().numpy()
    dec = np.clip(_resize_to(dec, h, w), 0.0, 1.0)

    base = rgb.astype(np.float32) / 255.0
    cover = mask[..., None]
    final = base * (1.0 - cover) + dec * cover

    return (final.clip(0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
