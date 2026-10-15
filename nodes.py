import json
import os

import folder_paths
import numpy as np
import torch
from PIL import Image

MAX_IMAGES = 16


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

    def load_images(self, image_files, auto_link="自动"):
        files = self._parse_files(image_files)
        results = []
        for i in range(MAX_IMAGES):
            if i < len(files):
                try:
                    results.append(self._load_one(files[i]))
                except Exception as e:
                    print(f"[TaiYangMultiImageLoader] 读取失败 {files[i]}: {e}")
                    results.append(None)
            else:
                # 没图的槽位返回 None：不参与执行，也不会污染下游参考图
                results.append(None)
        return tuple(results)


NODE_CLASS_MAPPINGS = {
    "TaiYangMultiImageLoader": TaiYangMultiImageLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TaiYangMultiImageLoader": "Multi Image Loader"
}
