"""小脸涂抹 · 纯算法实现（不依赖 ComfyUI，可脱离节点单独调用）

用途：参考图里同时站着多个人像视角（一张主视图大脸 + 若干张正面/侧面小脸），
送进大模型当参考时，小脸会把模型的注意力分走，主脸还原度下降。
这里把所有"非主视图"的人脸整片涂成纯色，身体和头发照旧不动。

做法：
1. face_yolov8m 检出全部人脸，阈值放宽到 0.12（实测纯侧脸 conf 0.81，能检出）
2. 按框面积降序排，前 keep_top 张算主脸保留，其余全算小脸
   —— 实测主脸占画面 4.07%，小脸 0.40% / 0.29%，差 10 倍，面积比这个判据很干净，
      "位置不固定"也就不用管了
3. 小脸框居中放大 scale 倍。YOLO 对纯侧脸框得偏窄（实测侧脸框 54px 宽，正脸 72px），
   不放大鼻子和嘴会露在框外；1.8 倍是实测"鼻嘴眼全盖住、头发基本还在"的值
4. 圆角矩形 + 高斯羽化，避免硬直角切边
5. 填充色默认取画布四边中位色，纯白/纯色背景素材都能贴合；也可指定纯白/纯黑/中灰

为什么不用色差抠图：实测白背景 + 白水手服的图，衣服和白背景色差小于阈值，
按色差抹会留下白色衣服的鬼影；而这里只涂脸框那一块，根本不碰身体。
（如果以后要"抹掉整个小人"，那才需要 BEN2 这类语义抠图模型。）

对外只暴露一个函数 :func:`erase_small_faces`。
"""

import cv2
import numpy as np

from .face_dehighlight import _face_boxes

__all__ = ["erase_small_faces", "FILL_CHOICES"]

FILL_CHOICES = ["自动背景", "纯白", "纯黑", "中灰"]

_PRESET = {
    "纯白": (255, 255, 255),
    "纯黑": (0, 0, 0),
    "中灰": (128, 128, 128),
}


def _bg_color(rgb):
    """画布四边像素的中位色。多视角人像素材基本都是纯色背景，这个估计很准。"""
    b = max(2, min(rgb.shape[0], rgb.shape[1]) // 100)
    edge = np.concatenate([
        rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
        rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3),
    ])
    return tuple(int(round(v)) for v in np.median(edge, axis=0))


def _round_rect(mask, xa, ya, xb, yb, ratio):
    """在 mask 上画一个圆角实心矩形（原地写入 1.0）。"""
    ww, hh = xb - xa, yb - ya
    r = int(min(ww, hh) * max(0.0, min(ratio, 0.5)))
    if r < 2:
        mask[ya:yb, xa:xb] = 1.0
        return
    r = min(r, ww // 2, hh // 2)
    cv2.rectangle(mask, (xa + r, ya), (xb - r, yb), 1.0, -1)
    cv2.rectangle(mask, (xa, ya + r), (xb, yb - r), 1.0, -1)
    for cx in (xa + r, xb - r):
        for cy in (ya + r, yb - r):
            cv2.circle(mask, (cx, cy), r, 1.0, -1)


def erase_small_faces(rgb, yolo_path, conf=0.12, keep_top=1, scale=1.8,
                      round_ratio=0.25, feather=2.0, fill="自动背景"):
    """把非主视图的人脸涂成纯色。

    参数
    ----
    rgb        : (H, W, 3) uint8 RGB 图
    yolo_path  : face_yolov8m.pt 之类的路径
    conf       : 人脸检测阈值，放宽可检出纯侧脸
    keep_top   : 保留面积最大的前 N 张脸不涂；0 = 全涂
    scale      : 小脸框居中放大倍数
    round_ratio: 圆角半径占短边比例
    feather    : 高斯羽化 sigma（像素），0 = 硬边
    fill       : FILL_CHOICES 之一

    返回
    ----
    (out_rgb, mask_soft, n_faces, n_erased)
    mask_soft : (H, W) float32 0~1，涂抹区域（羽化后），可直接当 inpaint 遮罩用
    """
    h, w = rgb.shape[:2]
    empty = np.zeros((h, w), np.float32)

    try:
        # _face_boxes 按 BGR 喂 YOLO（和 face_dehighlight.py 保持同一口径）
        boxes = _face_boxes(np.ascontiguousarray(rgb[:, :, ::-1]), yolo_path, conf)
    except Exception as e:                                   # noqa: BLE001
        print(f"[小脸涂抹] 人脸检测失败（{e}），原图返回")
        return rgb, empty, 0, 0

    n = len(boxes)
    keep_top = max(0, int(keep_top))
    if n <= keep_top:
        print(f"[小脸涂抹] 检出 {n} 张脸、保留 {keep_top} 张，没有要涂的")
        return rgb, empty, n, 0

    boxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    targets = boxes[keep_top:]

    color = _PRESET.get(fill) or _bg_color(rgb)

    mask = np.zeros((h, w), np.float32)
    for x0, y0, x1, y1 in targets:
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        hw, hh = (x1 - x0) * scale / 2.0, (y1 - y0) * scale / 2.0
        xa = max(0, int(round(cx - hw)))
        ya = max(0, int(round(cy - hh)))
        xb = min(w, int(round(cx + hw)))
        yb = min(h, int(round(cy + hh)))
        if xb <= xa or yb <= ya:
            continue
        _round_rect(mask, xa, ya, xb, yb, round_ratio)

    if feather and feather > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), float(feather))
    mask = np.clip(mask, 0.0, 1.0)

    a = mask[..., None]
    out = rgb.astype(np.float32) * (1.0 - a) + np.array(color, np.float32) * a
    out = np.clip(out + 0.5, 0, 255).astype(np.uint8)

    print(f"[小脸涂抹] 检出 {n} 张脸，涂掉 {len(targets)} 张（保留最大 {keep_top} 张），填充色 {color}")
    return out, mask, n, len(targets)
