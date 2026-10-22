"""图片调整：一套手机修图滑杆 + 几个 Photoshop 常用参数。

纯 numpy 实现，不依赖 opencv / pillow，可脱离 ComfyUI 单独测试。

参数口径参照手机修图软件与 PS 的「图像 > 调整」，全部 -100 ~ +100，0 为不动，正负对称：

    基础光调   曝光  Exposure      整体明暗（每 100 = ±1 档光）
               对比度 Contrast     以中灰为轴压/放黑白两端
               高光  Highlights    只作用于亮部
               阴影  Shadows       只作用于暗部
    色彩       鲜明度 Brilliance   灰的地方加饱和 + 中间调提亮，做通透感
               饱和度 Saturation   整体加/减彩
               色温  Temperature   正数偏暖（加红减蓝），负数偏冷
               色调  Tint          正数偏品红（减绿），负数偏绿
               色相  Hue           整体转色相，±100 = ±180°
    细节       清晰度 Clarity      中频局部对比（PS 的 Camera Raw 清晰度）
               锐化  Sharpen       高频锐化（USM）
    效果       暗角  Vignette      四角压暗，负数变四角发光
    全局       效果强度 Opacity   0 ~ 100，前面 12 项整体上几成（100 = 全量，0 = 原图）

计算顺序（顺序本身就是算法的一部分）：
    色温 → 色调 → 曝光 → 对比度 → 高光/阴影 → 色相 → 饱和度 → 鲜明度 → 清晰度 → 锐化 → 暗角 → 效果强度

先白平衡和曝光，后面按亮度加权的步骤才有意义；对比度放在高光/阴影之前，
不然两端被压过之后再拉对比会把细节吃掉；饱和类放细节之前，
清晰度/锐化只做亮度细节，不会把噪点染成彩点；暗角永远最后，
效果强度更是最后一步——它只是把「改完的结果」按比例混回原图，不参与任何计算。

注意「效果强度」不等于「画面透明度」：它不改明暗、不输出 alpha。
参数本身很轻时（比如默认配方只有 3~4 个灰阶的改动），强度减半后不足 2 个灰阶，
肉眼分辨不出——这是数学必然，不是失灵。它真正有用的场景是「重效果减弱一点」。
"""

import numpy as np

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _smoothstep(a, b, x):
    """标准 smoothstep：a 处为 0，b 处为 1，中间平滑过渡。"""
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _blur1d(a, r, axis):
    """沿单一轴做窗口均值（盒式模糊），用前缀和实现，O(n)。"""
    if r < 1:
        return a
    n = a.shape[axis]
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    cs = np.cumsum(p, axis=axis, dtype=np.float32)
    hi = [slice(None)] * a.ndim
    lo = [slice(None)] * a.ndim
    hi[axis] = slice(2 * r + 1, 2 * r + 1 + n)
    lo[axis] = slice(0, n)
    return (cs[tuple(hi)] - cs[tuple(lo)]) / np.float32(2 * r + 1)


def _box(a, r, passes=2):
    """可分离盒式模糊；跑两遍已经很接近高斯，代价只有两倍。"""
    for _ in range(passes):
        a = _blur1d(a, r, 0)
        a = _blur1d(a, r, 1)
    return a


def _hue_matrix(deg):
    """标准色相旋转矩阵（同 SVG feColorMatrix 的 hueRotate）。"""
    c = np.cos(np.deg2rad(deg))
    s = np.sin(np.deg2rad(deg))
    return np.array([
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ], dtype=np.float32)


def adjust(arr, exposure=0.0, contrast=0.0, highlights=0.0, shadows=0.0,
           brilliance=0.0, saturation=0.0, temperature=0.0, tint=0.0, hue=0.0,
           clarity=0.0, sharpen=0.0, vignette=0.0, opacity=100.0):
    """对 uint8 图像做调整，返回同形状 uint8。

    arr: (H, W, 3) 或 (H, W, 4)，RGB(A)。
    所有调整参数 -100 ~ 100；opacity 0 ~ 100。全部为 0（且 opacity=100）时原样返回（逐像素相等）。
    """
    src = np.asarray(arr)
    if src.ndim != 3 or src.shape[-1] < 3:
        raise ValueError(f"expect HxWx3 array, got {src.shape}")

    def _num(val):
        """参数夹到 -100 ~ 100；空串 / None / NaN 一律当 0。

        越界不夹的话，曝光会算出 2**100 这种值、清晰度/锐化的系数也会放大百倍，
        图会直接烂掉；极端值还会让后续矩阵运算跑出 inf，白白多算一遍大数组。
        """
        try:
            f = float(val)
        except (TypeError, ValueError):
            return 0.0
        if not np.isfinite(f):
            return 0.0
        return max(-100.0, min(100.0, f))

    v = {k: _num(val) / 100.0 for k, val in (
        ("exposure", exposure), ("contrast", contrast), ("highlights", highlights),
        ("shadows", shadows), ("brilliance", brilliance), ("saturation", saturation),
        ("temperature", temperature), ("tint", tint), ("hue", hue),
        ("clarity", clarity), ("sharpen", sharpen), ("vignette", vignette),
    )}

    # 效果强度单独夹到 0 ~ 100（不是 -100 ~ 100），空串 / None 当 100（全量生效）
    try:
        op = float(opacity)
        if not np.isfinite(op):
            op = 100.0
    except (TypeError, ValueError):
        op = 100.0
    op = max(0.0, min(100.0, op)) / 100.0

    # 全 0 直接原样返回，避免来回量化把像素改掉
    if not any(v.values()):
        return src.copy()

    x = src[..., :3].astype(np.float32) / 255.0
    h, w = x.shape[:2]

    # ---- ① 色温：红/蓝反向增益，绿几乎不动
    t = v["temperature"]
    if t:
        x *= np.array([1.0 + 0.28 * t, 1.0 + 0.02 * t, 1.0 - 0.28 * t], np.float32)

    # ---- ② 色调：品红 <-> 绿，压/抬绿通道
    tt = v["tint"]
    if tt:
        x *= np.array([1.0 + 0.06 * tt, 1.0 - 0.14 * tt, 1.0 + 0.06 * tt], np.float32)

    # ---- ③ 曝光：2^EV，每 100 当一档光
    e = v["exposure"]
    if e:
        x *= np.float32(2.0 ** e)

    # ---- ④ 对比度：以中灰 0.5 为轴向两端撑开
    c = v["contrast"]
    if c:
        x = (x - 0.5) * np.float32(1.0 + 0.50 * c) + 0.5

    lum = x @ LUMA

    # ---- ⑤ 高光 / 阴影：按亮度平滑加权，只碰各自那一段
    hg = v["highlights"]
    if hg:
        if hg > 0:
            # 提亮高光：往白靠，天然有上限，不会溢出成死白
            weight = _smoothstep(0.45, 1.0, lum)[..., None]
            x = x + (0.35 * hg) * weight * (1.0 - x)
        else:
            # 压高光：按比例压暗，越亮压得越多
            weight = _smoothstep(0.40, 1.0, lum)[..., None]
            x = x * (1.0 + 0.45 * hg * weight)

    sh = v["shadows"]
    if sh:
        if sh > 0:
            # 提亮阴影：往白推，但被 (1-x) 限制，不会把暗部糊成灰
            weight = (1.0 - _smoothstep(0.0, 0.55, lum))[..., None]
            x = x + (0.50 * sh) * weight * (1.0 - x)
        else:
            # 压暗阴影：乘性，越暗压得越多（收黑）
            weight = (1.0 - _smoothstep(0.0, 0.60, lum))[..., None]
            x = x * (1.0 + 0.75 * sh * weight)

    # ---- ⑥ 色相：整体旋转，±100 = ±180°
    hu = v["hue"]
    if hu:
        x = x @ _hue_matrix(hu * 180.0).T

    # ---- ⑦ 饱和度：围绕亮度拉/压彩度
    sa = v["saturation"]
    if sa:
        lum2 = x @ LUMA
        x = lum2[..., None] + (x - lum2[..., None]) * np.float32(max(0.0, 1.0 + sa))

    # ---- ⑧ 鲜明度：低饱和处加饱和（保肤色）+ 中间调轻微提亮
    br = v["brilliance"]
    if br:
        mx = x.max(axis=-1)
        mn = x.min(axis=-1)
        sat = mx - mn                                   # 0~1 粗略饱和度
        sat_w = np.clip(1.0 - sat / 0.35, 0.0, 1.0)     # 越灰吃满，已经很艳的地方不动
        lum3 = x @ LUMA
        x = lum3[..., None] + (x - lum3[..., None]) * (1.0 + 0.75 * br * sat_w[..., None])

        mid = 1.0 - np.abs(lum3 * 2.0 - 1.0)            # 中间调权重，两端为 0
        x = x * (1.0 + 0.12 * br * mid[..., None])

    # ---- ⑨ 清晰度：中频局部对比，只加在亮度上，不动色彩
    cl = v["clarity"]
    if cl:
        radius = max(4, int(min(h, w) * 0.012))
        lum4 = x @ LUMA
        x = x + (0.90 * cl) * (lum4 - _box(lum4, radius))[..., None]

    # ---- ⑩ 锐化：高频 USM，作用在 RGB 上（会带一点边缘彩边，这是锐化本身的样子）
    sp = v["sharpen"]
    if sp:
        radius = max(1, int(min(h, w) * 0.0015))
        base = _box(x, radius, passes=1)
        x = x + (0.90 * sp) * (x - base)

    # ---- ⑪ 暗角：径向渐变，正数压四角，负数四角发光
    vg = v["vignette"]
    if vg:
        yy = (np.arange(h, dtype=np.float32) / max(1, h - 1) * 2.0 - 1.0)[:, None]
        xx = (np.arange(w, dtype=np.float32) / max(1, w - 1) * 2.0 - 1.0)[None, :]
        d = np.sqrt(xx * xx + yy * yy) / np.float32(np.sqrt(2.0))
        weight = _smoothstep(0.35, 1.0, d)[..., None]
        if vg > 0:
            x = x * (1.0 - 0.65 * vg * weight)
        else:
            x = x + (-0.50 * vg) * weight * (1.0 - x)

    out = (np.clip(x, 0.0, 1.0) * 255.0).round().clip(0, 255).astype(np.uint8)

    # ---- ⑫ 效果强度：最后一步，纯混合 —— 把调整结果按比例混回原图
    #      （不参与任何前面的计算，所以「强度 30%」= 效果只上三成，而不是把图调淡）
    if op < 0.999:
        orig = src[..., :3].astype(np.float32)
        out = (orig * (1.0 - op) + out.astype(np.float32) * op).round().clip(0, 255).astype(np.uint8)

    if src.shape[-1] > 3:
        out = np.concatenate([out, src[..., 3:]], axis=-1)
    return out
