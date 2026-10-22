"""面部去高光 · 纯算法实现（不依赖 ComfyUI，可脱离节点单独调用）

思路与 PS 里的「通道选高光 + 吸管取周边肤色 + 填充」一致，但取色**只取肤色**：

1. YOLO 找到人脸框
2. Segformer 人脸解析分出 skin / nose（眉毛、眼睛、嘴唇、头发、鼻孔全排除）
3. 亮度阈值选出高光区
4. 取样禁区 = 脸内非皮肤区 ∪ 高光区；在禁区里做若干轮「模糊回填」，
   让纯肤色从四周渗进来，把眉黑、唇红挤干净，得到一张只有肤色的底片
5. 底片按羽化后的高光蒙版贴回原图，再按 fill_strength 混一点原图保住质感

对外只暴露一个函数 :func:`dehighlight`。
"""

import os

import cv2
import numpy as np
import torch

__all__ = ["dehighlight"]


# ---------------------------------------------------------------- 模型缓存
_YOLO_CACHE = {}
_SEG_CACHE = {}


def _device():
    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_yolo(model_path):
    key = os.path.abspath(model_path)
    if key not in _YOLO_CACHE:
        from ultralytics import YOLO

        _YOLO_CACHE.clear()
        _YOLO_CACHE[key] = YOLO(model_path)
    return _YOLO_CACHE[key]


def _load_segformer(model_dir):
    key = os.path.abspath(model_dir)
    if key not in _SEG_CACHE:
        from transformers import AutoModelForSemanticSegmentation, SegformerImageProcessor

        # local_files_only=True 很重要：不加的话 transformers 会去 huggingface.co
        # 核对版本 / 补配置文件，本机 HF 不通时会卡在重试上直到超时，表现为「进程不动」。
        kw = {"local_files_only": True}
        proc = SegformerImageProcessor.from_pretrained(model_dir, **kw)
        net = AutoModelForSemanticSegmentation.from_pretrained(model_dir, **kw)
        net.eval()
        net.to(_device())
        _SEG_CACHE.clear()
        _SEG_CACHE[key] = (proc, net)
    return _SEG_CACHE[key]


# ---------------------------------------------------------------- 各步骤
def _face_boxes(bgr, model_path, conf=0.35):
    """返回 [(x0, y0, x1, y1), ...]，没检测到返回空列表"""
    model = _load_yolo(model_path)
    res = model.predict(bgr, conf=conf, verbose=False)
    if not res:
        return []
    boxes = res[0].boxes
    if boxes is None or len(boxes) == 0:
        return []
    return [tuple(map(float, b)) for b in boxes.xyxy.cpu().numpy()]


def _skin_mask(rgb, model_dir):
    """skin + nose 的布尔掩码（True = 可取色的皮肤）"""
    proc, net = _load_segformer(model_dir)
    from PIL import Image

    pil = Image.fromarray(rgb)
    inputs = proc(images=pil, return_tensors="pt").to(_device())
    with torch.no_grad():
        logits = net(**inputs).logits
    logits = torch.nn.functional.interpolate(
        logits, size=(rgb.shape[0], rgb.shape[1]), mode="bilinear", align_corners=False
    )
    pred = logits.argmax(dim=1)[0].cpu().numpy()
    # 1 = skin, 2 = nose（鼻梁高光落在 nose 类上，必须一起算）
    return np.isin(pred, (1, 2))


def _clamp(v, lo, hi, default):
    """把参数夹到 [lo, hi]；空串 / None / NaN / 非数字一律回落 default。

    这层不能省：参数一旦越界（旧工作流按位置错位、或直接调 API），
    feather 会让高斯核尺寸平方级膨胀、rounds 会让循环跑上万次，
    两种都能把内存吃光并卡死，而不是简单报个错。
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        f = float(default)
    if not np.isfinite(f):
        f = float(default)
    return max(lo, min(hi, f))


def _feather(mask_u8, radius):
    """把 0/1 掩码羽化成 0~1 的软掩码，radius≈ComfyUI 里 mask_blur 的口径

    半径必须做硬上限：高斯核尺寸是 (2r+1)²，r 一旦跑到几千，
    OpenCV 会申请 上百 MB 乃至 GB 级缓冲区，进程直接卡死在分配上
    （旧工作流参数错位成怪值、或前端送了超大数时就是这个后果）。
    """
    r = float(radius) if radius is not None else 0.0
    if not np.isfinite(r) or r <= 0:
        return mask_u8.astype(np.float32)
    r = min(r, 128.0)
    k = max(3, int(r) * 2 + 1)
    return cv2.GaussianBlur(mask_u8.astype(np.float32), (k, k), r / 2.0).clip(0, 1)


def dehighlight(
    rgb,
    yolo_model,
    segformer_model,
    highlight_threshold=0.80,
    fill_strength=0.80,
    feather=10,
    rounds=3,
    fill_brightness=0.0,
    diff_sigma=8.0,
    plate_sigma=5.0,
):
    """去掉人脸高光，返回处理后的图。

    :param rgb: uint8 RGB 数组 (H, W, 3)
    :param yolo_model: 人脸检测模型路径（face_yolov8m.pt）
    :param segformer_model: 人体解析模型目录（segformer_face）
    :param highlight_threshold: 高光阈值 0~1，越**大**选中的高光范围越**小**
    :param fill_strength: 填充强度 0~1
    :param feather: 高光区羽化半径
    :param rounds: 肤色扩散轮数
    :param fill_brightness: 填充明暗 -1 ~ +1。负 = 用更暗的肤色填（加深、更有层次），
        正 = 用更亮的肤色填（自然提亮、避免填完发灰）；0 = 完全按周边肤色
    :return: uint8 RGB 数组 (H, W, 3)；未检测到人脸 / 无高光时原样返回
    """
    h, w = rgb.shape[:2]

    # 参数先夹到安全区间，越界值绝不往下传（见 _clamp 的说明）
    highlight_threshold = _clamp(highlight_threshold, 0.30, 1.00, 0.80)
    fill_strength = _clamp(fill_strength, 0.0, 1.0, 0.80)
    feather = int(round(_clamp(feather, 0, 200, 10)))
    rounds = int(round(_clamp(rounds, 1, 10, 3)))
    fill_brightness = _clamp(fill_brightness, -1.0, 1.0, 0.0)
    diff_sigma = _clamp(diff_sigma, 0.5, 32.0, 8.0)
    plate_sigma = _clamp(plate_sigma, 0.5, 32.0, 5.0)

    img = rgb.astype(np.float32) / 255.0
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    boxes = _face_boxes(bgr, yolo_model)
    if not boxes:
        print("[去高光] 未检测到人脸，原图返回")
        return rgb

    face = np.zeros((h, w), np.uint8)
    for x0, y0, x1, y1 in boxes:
        cv2.rectangle(face, (int(x0), int(y0)), (int(x1), int(y1)), 1, -1)

    try:
        skin = _skin_mask(rgb, segformer_model).astype(np.uint8)
    except Exception as e:  # 解析失败就退回"整张脸都算皮肤"
        print(f"[去高光] 肤色解析失败({e})，退回按亮度排暗区")
        skin = (img.mean(axis=2) > 0.30).astype(np.uint8)

    skin &= face

    # 皮肤掩码修整：先闭运算填掉痣 / 皱纹造成的小洞，再外扩 3px 容忍分割边缘误差。
    # 不修的话，洞里的高光会漏填留下亮点，轮廓处又会漏掉一圈亮边。
    _k3 = np.ones((3, 3), np.uint8)
    skin_pad = cv2.morphologyEx(skin, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    skin_pad = cv2.dilate(skin_pad, _k3, iterations=3)

    # 高光 = 亮度超阈值 ∩ 人脸框 ∩ 皮肤。
    #
    # 第三项不能省：YOLO 给的是**矩形框**，框里的头发、衣领、背景边缘一样有亮部。
    # 一旦这些亮部被当成高光，羽化就会把填充推出矩形的四条边，
    # 背景上直接出现一个灰色方块（白人白发 + 白背景时特别明显）。
    lum = 0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2]
    hi = ((lum > highlight_threshold) & (face > 0) & (skin_pad > 0)).astype(np.uint8)

    if hi.sum() == 0:
        print("[去高光] 皮肤区域内没找到高光，原图返回"
              "（可调低阈值；若一直这样，检查 segformer_face 模型是否装对）")
        return rgb

    # 取样禁区 = 脸内非皮肤 ∪ 高光
    donor = ((face == 1) & (skin == 0)) | (hi == 1)
    donor = donor.astype(np.uint8)
    donor_soft = _feather(donor, 3)[..., None]

    # 只在禁区里反复模糊回填，让肤色渗进来
    work = img.copy()
    for _ in range(max(1, rounds)):
        blurred = cv2.GaussianBlur(work, (0, 0), diff_sigma)
        work = work * (1.0 - donor_soft) + blurred * donor_soft
    plate = cv2.GaussianBlur(work, (0, 0), plate_sigma)

    # 填充明暗：只调底片（最终填进去的那个颜色），原图不参与。
    #
    # 关键点：不能整块均匀地压暗/提亮，那样会在大面积高光上留下一块生硬的灰斑
    # （影棚硬光下高光常常覆盖半张脸）。这里按「该像素超出阈值的程度」加权：
    # 高光越强的地方调得越多，刚过阈值的地方几乎不动，过渡自然。
    # 正数向白推，有天然上限不会溢出成死白；负数乘性压暗，不会把肤色压平。
    if fill_brightness:
        span = max(1e-6, 1.0 - highlight_threshold)
        wgt = np.clip((lum - highlight_threshold) / span, 0.0, 1.0)
        plate_lum = 0.299 * plate[..., 0] + 0.587 * plate[..., 1] + 0.114 * plate[..., 2]
        if fill_brightness > 0:
            target = plate_lum + (1.0 - plate_lum) * (0.70 * fill_brightness * wgt)
        else:
            target = plate_lum * (1.0 + 0.70 * fill_brightness * wgt)
        # 加性偏移代替等比缩放：不引入除法（plate_lum 为 0 时不会炸出巨大值），
        # 少两个临时大数组，RGB 等量加减，色相同样保持。
        plate = np.clip(plate + (target - plate_lum)[..., None], 0.0, 1.0)

    # 羽化后的高光蒙版
    hi_soft = _feather(
        cv2.dilate(hi, np.ones((5, 5), np.uint8), iterations=1), max(1, feather)
    )

    # 最终覆盖 = 高光蒙版 ∩ 皮肤软轮廓。
    # 双保险：把羽化溢出到皮肤之外的部分削掉，让填充范围始终是**皮肤的轮廓**，
    # 而不是人脸检测框那个矩形——矩形边一旦露出就是图里那种灰色方块。
    cover = (hi_soft * _feather(skin_pad, max(2, feather // 2)))[..., None]

    fill = img * (1.0 - cover) + plate * cover
    blended = img * (1.0 - fill_strength) + fill * fill_strength
    final = img * (1.0 - cover) + blended * cover

    return (final.clip(0, 1) * 255.0 + 0.5).astype(np.uint8)
