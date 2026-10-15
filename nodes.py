import json
import math
import os

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
                "auto_link": (["自动", "TextEncodeQwenImage21", "TextEncodeQwenImageEditPlus", "关闭"], {"default": "自动"}),
                "upscale_method": (["nearest-exact", "bilinear", "area", "bicubic", "lanczos"], {"default": "bilinear"}),
                # 0 = 不缩放（保持原分辨率）。>0 时按总像素数等比缩放，可填任意数字。
                "megapixels": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 16.0, "step": 0.01}),
            },
            "optional": {
                # 分辨率对齐步长：宽高都对齐到该数字的整数倍
                "resolution_steps": ("INT", {"default": 32, "min": 1, "max": 256, "advanced": True}),
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

    def _load_one(self, rel_path):
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
        return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}

    def load_audios(self, audio_files, auto_link="自动"):
        files = self._parse_files(audio_files)
        results = []
        for i in range(MAX_AUDIOS):
            if i < len(files):
                try:
                    results.append(self._load_one(files[i]))
                except Exception as e:
                    print(f"[TaiYangMultiAudioLoader] 读取失败 {files[i]}: {e}")
                    results.append(None)
            else:
                # 没音频的槽位返回 None：不参与执行，也不会污染下游参考音频
                results.append(None)
        return tuple(results)


NODE_CLASS_MAPPINGS = {
    "TaiYangMultiImageLoader": TaiYangMultiImageLoader,
    "TaiYangMultiAudioLoader": TaiYangMultiAudioLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TaiYangMultiImageLoader": "Multi Image Loader",
    "TaiYangMultiAudioLoader": "Multi Audio Loader"
}
