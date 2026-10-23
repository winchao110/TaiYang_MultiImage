/**
 * TaiYang · 图片调整 —— 左图右滑块的实时预览面板
 *
 * 布局：左边是图片预览，右边是 12 个参数滑块。
 * 拖右边的滑块，左边的图**立刻**变成调整后的样子，不用反复执行节点。
 *
 * 怎么做到的：
 *   节点跑过一次后，后端把「原图」写到 temp 并通过 ui.ty_adjust_src 下发；
 *   前端把它读进 canvas，之后每动一次滑块，就在浏览器里重算一遍这 12 项调整
 *   并重画 canvas。算法与 image_adjust.py 一一对应（同样的顺序、同样的系数），
 *   所以预览看到的就是后端会产出的结果（差别只在预览按档位降采样过，
 *   档位可选 512 / 720 / 1080 / 1440，图上方那个下拉就是）。
 *
 * 原生参数 widget 仍然保留（序列化、API 调用都靠它），只是被压成 0 高度，
 * 视觉上由右侧这列滑块代替。
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "TaiYangImageAdjust";
const PANEL_H = 492;              // 面板高度（预览档位行 24 + 预设行 26 + 13 行滑杆 + 存预设行 24 + 间距）
const MIN_NODE_W = 680;           // 建节点时的最小宽度，太窄图就没了
const CTRL_W = 198;               // 右侧控制列宽度（名字 + 滑杆 + 数值框）

// 预览分辨率档位（按**最长边**算）。默认 720 —— 1080 / 1440 在 4K 图上算得慢，拖起来会卡，
// 想要细节时手动往上拨。拖动过程还会再降到档位的 55%，保证跟手。
const QUALITY_LEVELS = [512, 720, 1080, 1440];
const QUALITY_DEFAULT = 720;
const QUALITY_STORE = "taiyang_adjust_quality_v1";

// 顺序 = 面板里从上到下的顺序。第三项是「缺省值」，用于工作流里没这个控件时的兜底。
const PARAMS = [
  ["曝光", "exposure", 0], ["对比度", "contrast", 0], ["高光", "highlights", 0],
  ["阴影", "shadows", 0], ["鲜明度", "brilliance", 0], ["饱和度", "saturation", 0],
  ["色温", "temperature", 0], ["色调", "tint", 0], ["色相", "hue", 0],
  ["清晰度", "clarity", 0], ["锐化", "sharpen", 0], ["暗角", "vignette", 0],
  // 效果强度口径不同：0 ~ 100，缺省 100（全量生效）。它不改明暗、不输出 alpha，
  // 只决定前面 12 项的效果整体上几成。
  ["效果强度", "opacity", 100],
];

const PRESET_DEFAULT = "为什么我的照片比你好看∩_∩";

// 预设：点一下整套参数就位。第一项归零（原图），最后一项就是节点默认配方。
// 效果强度不参与预设 —— 它管的是「效果上几成」，选了风格再拨它微调才对。
// 第 3 列是下拉里的分组名，同名的凑成一个 optgroup；留空 = 直接列在最外层。
const PRESETS = [
  ["原图", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ""],
  // ——— 通用风格 ———
  ["青橙电影感", [3, 15, -10, -20, 20, -15, 10, -30, 15, 25, 8, 15], "通用风格"],
  ["清透美颜感", [5, -5, -15, 25, 10, -10, 5, 5, 0, 10, 3, 0], "通用风格"],
  ["复古胶片感", [0, 8, -20, 15, -10, -20, 20, -10, 5, 15, 10, 20], "通用风格"],
  ["赛博朋克风", [-2, 25, 10, -40, 35, 10, -20, 25, -20, 30, 12, 10], "通用风格"],
  ["日系小清新", [8, -10, -5, 20, -5, -25, -10, -5, 0, 5, 2, -5], "通用风格"],
  // ——— 电影调色（好莱坞 / 杜比 / 柯达 2383）———
  ["好莱坞写实电影感", [2, 18, -15, -25, 25, -20, 12, -15, 10, 30, 10, 20], "电影调色"],
  ["杜比视界 HDR 级", [0, 28, -20, 10, 35, -10, 5, -10, 5, 35, 12, 15], "电影调色"],
  ["柯达 2383 胶片电影", [-2, 12, -25, 5, 10, -25, 25, -20, 15, 20, 8, 25], "电影调色"],
  // ——— 类型片调色 ———
  ["悬疑惊悚暗调", [-8, 30, -30, -45, 15, -35, -15, 20, -25, 25, 15, 35], "类型片调色"],
  ["赛博科幻电影", [-5, 25, 15, -35, 40, -15, -25, 30, -30, 35, 18, 15], "类型片调色"],
  ["港式复古电影", [3, 10, -10, 0, 15, -15, 35, -30, 25, 15, 5, 18], "类型片调色"],
  ["古风水墨电影", [0, 8, -5, 15, -10, -45, -10, -15, 20, 20, 6, 10], "类型片调色"],
  ["末日废土电影", [-3, 22, -20, -20, 30, -30, 20, 10, -10, 30, 15, 28], "类型片调色"],
  [PRESET_DEFAULT, [4, 0, 6, -14, 11, 0, -4, 0, 0, 0, 0, 0], ""],
];

const CUSTOM_LABEL = "自定义（已微调）";
const CUSTOM_GROUP = "我的预设";      // 自己存的预设归到这一组
const STORE_KEY = "taiyang_adjust_presets_v1";
const NAME_MAX = 24;                  // 预设名长度上限，太长了下拉显示不下

/* 自己存的预设：放 localStorage，跨节点、跨工作流、刷新都在。
   浏览器禁了本地存储（隐私模式）时退化成模块级内存，本次会话内照样能用。 */
let MEM_CUSTOM = null;

function loadCustom() {
  if (MEM_CUSTOM) return MEM_CUSTOM;
  MEM_CUSTOM = [];
  try {
    const arr = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (Array.isArray(arr)) {
      MEM_CUSTOM = arr
        .filter((p) => p && typeof p.name === "string" && Array.isArray(p.vals))
        .map((p) => ({
          name: p.name.trim().slice(0, NAME_MAX),
          // 一律补/裁成 12 项并夹到 -100~100：坏数据不许带塌整个下拉
          vals: Array.from({ length: 12 }, (_, i) => {
            const v = Number(p.vals[i]);
            return Number.isFinite(v) ? Math.max(-100, Math.min(100, Math.round(v))) : 0;
          }),
        }))
        .filter((p) => p.name);
    }
  } catch (_) {
    /* 隐私模式 / 存储被禁：留在内存里 */
  }
  return MEM_CUSTOM;
}

/** 写回 localStorage；返回 false 表示只留在内存（浏览器不让存） */
function saveCustom(arr) {
  MEM_CUSTOM = arr;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(arr));
    return true;
  } catch (_) {
    return false;
  }
}

/** 丢掉内存缓存，下次读走 localStorage（别处改了预设库时用） */
function resetCustomCache() {
  MEM_CUSTOM = null;
}

const STYLE_ID = "ty-adj-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.ty-adj {
  display: flex; width: 100%; height: 100%; box-sizing: border-box;
  gap: 8px; padding: 6px; border-radius: 8px;
  background: #141519; box-shadow: inset 0 0 0 1px #2c2e36;
  user-select: none; -webkit-user-select: none;
}
.ty-adj-left {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; gap: 6px;
}
/* 预览分辨率档位（图上方那行） */
.ty-adj-quality {
  flex: 0 0 24px; height: 24px;
  display: flex; align-items: center; gap: 6px;
  color: #8b909b; font-size: 11px; white-space: nowrap;
}
.ty-adj-quality select { width: 84px; }
.ty-adj-view {
  position: relative; flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; justify-content: center;
  background: #0d0e11; border-radius: 6px; overflow: hidden;
}
.ty-adj-cv { display: block; max-width: 100%; max-height: 100%; }
/* 效果强度角标：只在强度 < 100 时出现，让「拖了有没有生效」一眼看得见 */
.ty-adj-badge {
  position: absolute; left: 7px; top: 7px; z-index: 3;
  display: none; flex-direction: column; gap: 1px;
  padding: 3px 7px 4px; border-radius: 5px; max-width: calc(100% - 14px);
  background: rgba(9,10,13,.74);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.07);
  color: #e6e8ee; font-size: 10.5px; line-height: 15px;
  pointer-events: none; white-space: nowrap; overflow: hidden;
}
.ty-adj-badge.on { display: flex; }
.ty-adj-badge b {
  font-size: 11.5px; font-weight: 600; color: #fff;
  font-variant-numeric: tabular-nums; letter-spacing: .2px;
}
.ty-adj-badge small {
  color: #9aa0ab; font-size: 10px; line-height: 13px;
  white-space: normal; display: block;
}
/* 底部浮动提示：保存 / 删除成没成、为什么没成，2 秒后自己淡出 */
.ty-adj-toast {
  position: absolute; left: 50%; bottom: 10px; z-index: 4;
  max-width: calc(100% - 18px); box-sizing: border-box;
  padding: 5px 10px; border-radius: 5px;
  background: rgba(9,10,13,.9); box-shadow: inset 0 0 0 1px #2f323a;
  color: #dfe2e8; font-size: 11px; line-height: 1.35; text-align: center;
  opacity: 0; transform: translate(-50%, 6px);
  transition: opacity .16s ease, transform .16s ease;
  pointer-events: none;
}
.ty-adj-toast.show { opacity: 1; transform: translate(-50%, 0); }
.ty-adj-toast.ok { box-shadow: inset 0 0 0 1px #2e5a3a; color: #bfe7cd; }
.ty-adj-toast.bad { box-shadow: inset 0 0 0 1px #5d3138; color: #f2c3c9; }
.ty-adj-hint {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px;
  color: #767b85; font-size: 12px; line-height: 18px; text-align: center;
  padding: 0 14px; pointer-events: none;
}
.ty-adj-hint small { color: #4b4f58; font-size: 11px; }
.ty-adj-ctrl {
  flex: 0 0 ${CTRL_W}px; width: ${CTRL_W}px;
  display: flex; flex-direction: column; gap: 6px;
  padding: 1px 2px 1px 0; min-width: 0;
}
/* 预设下拉 */
.ty-adj-preset { flex: 0 0 26px; height: 26px; display: flex; align-items: center; }
.ty-adj-preset select,
.ty-adj-quality select {
  height: 24px; padding: 0 6px; border-radius: 5px;
  background: #23252c; color: #dfe2e8; font-size: 11.5px; font-family: inherit;
  border: 1px solid #34373f; outline: none; cursor: pointer;
  appearance: none; -webkit-appearance: none;
  /* 右侧小三角 */
  background-image: linear-gradient(45deg, transparent 50%, #8b909b 50%),
                    linear-gradient(135deg, #8b909b 50%, transparent 50%);
  background-position: calc(100% - 11px) 10px, calc(100% - 7px) 10px;
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}
.ty-adj-preset select { width: 100%; }
.ty-adj-preset select:hover,
.ty-adj-quality select:hover { border-color: #4a4e59; }
.ty-adj-preset select option,
.ty-adj-quality select option { background: #23252c; color: #dfe2e8; }
.ty-adj-preset select optgroup { background: #23252c; color: #8b909b; font-size: 11px; }

/* 预设名 + 保存 / 删除 */
.ty-adj-save { flex: 0 0 24px; height: 24px; display: flex; align-items: center; gap: 4px; }
.ty-adj-save input.ty-adj-name {
  flex: 1 1 auto; min-width: 0; height: 22px; box-sizing: border-box;
  padding: 0 5px; border-radius: 4px;
  background: #1c1e24; color: #dfe2e8; font-size: 11px; font-family: inherit;
  border: 1px solid #2f323a; outline: none;
}
.ty-adj-save input.ty-adj-name::placeholder { color: #565b64; }
.ty-adj-save input.ty-adj-name:hover { border-color: #41454f; }
.ty-adj-save input.ty-adj-name:focus {
  border-color: #6b7ce0; background: #22252d; color: #fff;
  box-shadow: 0 0 0 2px rgba(107,124,224,.18);
}
.ty-adj-btn {
  flex: 0 0 auto; height: 22px; padding: 0 6px; box-sizing: border-box;
  border-radius: 4px; cursor: pointer; white-space: nowrap;
  font-size: 11px; font-family: inherit; line-height: 1;
  background: #262931; color: #cfd3db; border: 1px solid #353941;
}
.ty-adj-btn:hover { background: #2e323b; border-color: #454a55; color: #fff; }
.ty-adj-btn:active { transform: translateY(1px); }
.ty-adj-btn.ok:hover { border-color: #3d7a52; color: #bfe7cd; }
.ty-adj-btn.del:hover { border-color: #7a3d47; color: #f2c3c9; }

.ty-adj-rows {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column; justify-content: space-between;
}
.ty-adj-row { display: flex; align-items: center; gap: 4px; height: 26px; }
.ty-adj-row > span:first-child {
  flex: 0 0 38px; width: 38px; font-size: 11px; color: #b7bcc7;
  letter-spacing: .3px; white-space: nowrap;
}
.ty-adj-row input[type=range] {
  flex: 1 1 auto; min-width: 0; height: 14px; margin: 0;
  -webkit-appearance: none; appearance: none; background: transparent; cursor: ew-resize;
}
.ty-adj-row input[type=range]::-webkit-slider-runnable-track {
  height: 3px; border-radius: 2px; background: #34373f;
}
.ty-adj-row input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 11px; height: 11px; margin-top: -4px; border-radius: 50%;
  background: #e8eaee; box-shadow: 0 1px 3px rgba(0,0,0,.5); border: none;
}
.ty-adj-row input[type=range]:active::-webkit-slider-thumb { background: #fff; }
/* 数值框：既能看也能直接填 */
.ty-adj-row input.ty-adj-num {
  flex: 0 0 40px; width: 40px; height: 19px; box-sizing: border-box;
  padding: 0 3px; text-align: right; border-radius: 4px;
  background: #1c1e24; color: #dfe2e8; font-size: 10.5px; font-family: inherit;
  border: 1px solid #2f323a; outline: none;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.ty-adj-row input.ty-adj-num::-webkit-outer-spin-button,
.ty-adj-row input.ty-adj-num::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0;
}
.ty-adj-row input.ty-adj-num:hover { border-color: #41454f; }
.ty-adj-row input.ty-adj-num:focus {
  border-color: #6b7ce0; background: #22252d; color: #fff;
  box-shadow: 0 0 0 2px rgba(107,124,224,.18);
}
.ty-adj-row input.ty-adj-num.zero { color: #6b7079; }
`;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------ 像素算法
 * 与 image_adjust.py 完全同序同系数：
 * 色温 → 色调 → 曝光 → 对比度 → 高光/阴影 → 色相 → 饱和度 → 鲜明度
 * → 清晰度 → 锐化 → 暗角
 * ------------------------------------------------------------------ */

const smoothstep = (a, b, x) => {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

/** 沿单轴做滑动窗口均值（O(n)），src/dst 都是单通道 Float32Array */
function blurAxis(src, dst, w, h, r, horiz) {
  const len = horiz ? w : h;
  const lines = horiz ? h : w;
  const step = horiz ? 1 : w;
  const inv = 1 / (2 * r + 1);
  const last = len - 1;
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w : l;
    let sum = 0;
    // 边界用 edge clamp：越界的采样点取最近的有效像素
    for (let i = -r; i <= r; i++) sum += src[base + (i < 0 ? 0 : i > last ? last : i) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum * inv;
      const add = i + r + 1;
      const sub = i - r;
      sum += src[base + (add > last ? last : add) * step]
           - src[base + (sub < 0 ? 0 : sub) * step];
    }
  }
}

/** 可分离盒式模糊，跑两遍接近高斯 */
function boxBlur(src, w, h, r, passes = 2) {
  if (r < 1) return src;
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    blurAxis(a, b, w, h, r, true);
    blurAxis(b, a, w, h, r, false);
  }
  return a;
}

const LUMA = [0.2126, 0.7152, 0.0722];

/** 把 RGBA 像素按参数调整一遍，返回新的 RGBA */
function applyAdjust(src, w, h, p) {
  const n = w * h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    R[i] = src[j] / 255;
    G[i] = src[j + 1] / 255;
    B[i] = src[j + 2] / 255;
  }

  const e = p.exposure, c = p.contrast, hg = p.highlights, sh = p.shadows;
  const br = p.brilliance, sa = p.saturation, tp = p.temperature, tn = p.tint;
  const hu = p.hue, cl = p.clarity, sp = p.sharpen, vg = p.vignette;

  // ① 色温
  if (tp) {
    const kr = 1 + 0.28 * tp, kg = 1 + 0.02 * tp, kb = 1 - 0.28 * tp;
    for (let i = 0; i < n; i++) { R[i] *= kr; G[i] *= kg; B[i] *= kb; }
  }
  // ② 色调
  if (tn) {
    const kr = 1 + 0.06 * tn, kg = 1 - 0.14 * tn, kb = 1 + 0.06 * tn;
    for (let i = 0; i < n; i++) { R[i] *= kr; G[i] *= kg; B[i] *= kb; }
  }
  // ③ 曝光
  if (e) {
    const k = Math.pow(2, e);
    for (let i = 0; i < n; i++) { R[i] *= k; G[i] *= k; B[i] *= k; }
  }
  // ④ 对比度
  if (c) {
    const k = 1 + 0.50 * c;
    for (let i = 0; i < n; i++) {
      R[i] = (R[i] - 0.5) * k + 0.5;
      G[i] = (G[i] - 0.5) * k + 0.5;
      B[i] = (B[i] - 0.5) * k + 0.5;
    }
  }

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = R[i] * LUMA[0] + G[i] * LUMA[1] + B[i] * LUMA[2];

  // ⑤ 高光 / 阴影
  if (hg) {
    if (hg > 0) {
      for (let i = 0; i < n; i++) {
        const wt = smoothstep(0.45, 1.0, lum[i]) * 0.35 * hg;
        R[i] += wt * (1 - R[i]); G[i] += wt * (1 - G[i]); B[i] += wt * (1 - B[i]);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const k = 1 + 0.45 * hg * smoothstep(0.40, 1.0, lum[i]);
        R[i] *= k; G[i] *= k; B[i] *= k;
      }
    }
  }
  if (sh) {
    if (sh > 0) {
      for (let i = 0; i < n; i++) {
        const wt = (1 - smoothstep(0.0, 0.55, lum[i])) * 0.50 * sh;
        R[i] += wt * (1 - R[i]); G[i] += wt * (1 - G[i]); B[i] += wt * (1 - B[i]);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const k = 1 + 0.75 * sh * (1 - smoothstep(0.0, 0.60, lum[i]));
        R[i] *= k; G[i] *= k; B[i] *= k;
      }
    }
  }

  // ⑥ 色相（标准 hueRotate 矩阵）
  if (hu) {
    const ang = (hu * 180) * Math.PI / 180;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const m = [
      0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
    ];
    for (let i = 0; i < n; i++) {
      const r = R[i], g = G[i], b = B[i];
      R[i] = r * m[0] + g * m[1] + b * m[2];
      G[i] = r * m[3] + g * m[4] + b * m[5];
      B[i] = r * m[6] + g * m[7] + b * m[8];
    }
  }

  // ⑦ 饱和度
  if (sa) {
    const k = Math.max(0, 1 + sa);
    for (let i = 0; i < n; i++) {
      const l = R[i] * LUMA[0] + G[i] * LUMA[1] + B[i] * LUMA[2];
      R[i] = l + (R[i] - l) * k;
      G[i] = l + (G[i] - l) * k;
      B[i] = l + (B[i] - l) * k;
    }
  }

  // ⑧ 鲜明度：低饱和处加彩 + 中间调轻提亮
  if (br) {
    for (let i = 0; i < n; i++) {
      const r = R[i], g = G[i], b = B[i];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx - mn;
      let sw = 1 - sat / 0.35;
      sw = sw < 0 ? 0 : sw > 1 ? 1 : sw;
      const l = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
      const k = 1 + 0.75 * br * sw;
      let nr = l + (r - l) * k, ng = l + (g - l) * k, nb = l + (b - l) * k;
      const mid = 1 - Math.abs(l * 2 - 1);
      const k2 = 1 + 0.12 * br * mid;
      R[i] = nr * k2; G[i] = ng * k2; B[i] = nb * k2;
    }
  }

  // ⑨ 清晰度：中频局部对比，只加在亮度上
  if (cl) {
    const r = Math.max(4, Math.round(Math.min(w, h) * 0.012));
    const mx = new Float32Array(n);
    for (let i = 0; i < n; i++) mx[i] = R[i] * LUMA[0] + G[i] * LUMA[1] + B[i] * LUMA[2];
    const low = boxBlur(mx, w, h, r, 2);
    for (let i = 0; i < n; i++) {
      const d = (mx[i] - low[i]) * 0.90 * cl;
      R[i] += d; G[i] += d; B[i] += d;
    }
  }

  // ⑩ 锐化：高频 USM
  if (sp) {
    const r = Math.max(1, Math.round(Math.min(w, h) * 0.0015));
    const br_ = boxBlur(R, w, h, r, 1);
    const bg_ = boxBlur(G, w, h, r, 1);
    const bb_ = boxBlur(B, w, h, r, 1);
    for (let i = 0; i < n; i++) {
      R[i] += (R[i] - br_[i]) * 0.90 * sp;
      G[i] += (G[i] - bg_[i]) * 0.90 * sp;
      B[i] += (B[i] - bb_[i]) * 0.90 * sp;
    }
  }

  // ⑪ 暗角
  if (vg) {
    const inv = Math.SQRT1_2;
    const ys = new Float32Array(h);
    for (let y = 0; y < h; y++) ys[y] = (h > 1 ? y / (h - 1) * 2 - 1 : 0);
    for (let y = 0; y < h; y++) {
      const yy = ys[y] * ys[y];
      for (let x = 0; x < w; x++) {
        const xx = (w > 1 ? x / (w - 1) * 2 - 1 : 0);
        const d = Math.sqrt(xx * xx + yy) * inv;
        const wt = smoothstep(0.35, 1.0, d);
        const i = y * w + x;
        if (vg > 0) {
          const k = 1 - 0.65 * vg * wt;
          R[i] *= k; G[i] *= k; B[i] *= k;
        } else {
          const wt2 = -0.50 * vg * wt;
          R[i] += wt2 * (1 - R[i]); G[i] += wt2 * (1 - G[i]); B[i] += wt2 * (1 - B[i]);
        }
      }
    }
  }

  // ⑫ 效果强度：最后一步，纯混合 —— 结果按比例混回原图
  //    （不参与前面的计算，所以「强度 30%」= 效果只上三成，而不是把图调淡）
  const op = Number.isFinite(p.opacity) ? Math.max(0, Math.min(1, p.opacity)) : 1;

  const out = new Uint8ClampedArray(n * 4);
  if (op >= 0.999) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      out[j] = R[i] * 255;
      out[j + 1] = G[i] * 255;
      out[j + 2] = B[i] * 255;
      out[j + 3] = src[j + 3];
    }
  } else {
    const iv = 1 - op;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      out[j] = src[j] * iv + R[i] * 255 * op;
      out[j + 1] = src[j + 1] * iv + G[i] * 255 * op;
      out[j + 2] = src[j + 2] * iv + B[i] * 255 * op;
      out[j + 3] = src[j + 3];
    }
  }
  return out;
}

/* ------------------------------------------------------------ 面板 */

function viewUrl(img) {
  const q = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "temp",
  });
  return `/view?${q.toString()}`;
}

/* ---- 预览分辨率档位（存在 localStorage，所有节点共用） ---- */

function readQualityStore() {
  try {
    const v = Number(localStorage.getItem(QUALITY_STORE));
    return QUALITY_LEVELS.includes(v) ? v : QUALITY_DEFAULT;
  } catch (_) {
    return QUALITY_DEFAULT;
  }
}

function writeQualityStore(cap) {
  try {
    localStorage.setItem(QUALITY_STORE, String(cap));
  } catch (_) {
    /* 隐私模式写不了就算了，不影响本次预览 */
  }
}

function collect(node) {
  const p = {};
  for (const [, en, def] of PARAMS) p[en] = def / 100;
  for (const w of node.widgets || []) {
    const hit = PARAMS.find(([cn]) => cn === w.name);
    if (!hit) continue;
    const v = Number(w.value);
    p[hit[1]] = Number.isFinite(v) ? v / 100 : hit[2] / 100;
  }
  return p;
}

/** 当前 12 项数值（效果强度不参与预设），用于反查预设 */
function valuesOf(node) {
  return PARAMS.slice(0, 12).map(([cn]) => {
    const w = (node.widgets || []).find((x) => x.name === cn);
    const v = Number(w?.value);
    return Number.isFinite(v) ? Math.round(v) : 0;
  });
}

/** 数值 → 预设名；一个都不像就返回 null */
function matchPreset(vals) {
  for (const [name, arr] of PRESETS) {
    if (arr.every((v, i) => v === vals[i])) return name;
  }
  // 自己存的也能被认出来，重开工作流照样显示名字
  for (const p of loadCustom()) {
    if (p.vals.every((v, i) => v === vals[i])) return p.name;
  }
  return null;
}

/** 按名字取一套 12 项数值：先内置，再自己存的 */
function findPreset(name) {
  const hit = PRESETS.find(([n]) => n === name);
  if (hit) return hit[1];
  const mine = loadCustom().find((p) => p.name === name);
  return mine ? mine.vals : null;
}

/* 下拉的实际结构：[{ label, items }]，label 为空表示直接挂在 select 上。
   顺序固定为「原图 → 通用风格 → 电影调色 → 类型片调色 → 我的预设 → 默认配方」，
   第一项永远是原图、最后一项永远是那个默认配方，自己存的插在倒数第二。 */
function presetLayout() {
  const out = [];
  let box = null;
  let label = null;
  for (const [name, vals, group = ""] of PRESETS) {
    if (name === PRESET_DEFAULT) continue;                // 最后单独放
    if (!group) {
      out.push({ label: "", items: [[name, vals]] });
      box = null;
      label = null;
      continue;
    }
    if (!box || label !== group) {
      box = { label: group, items: [] };
      label = group;
      out.push(box);
    }
    box.items.push([name, vals]);
  }

  const mine = loadCustom();
  if (mine.length) out.push({ label: CUSTOM_GROUP, items: mine.map((p) => [p.name, p.vals]) });

  const def = PRESETS.find(([n]) => n === PRESET_DEFAULT);
  if (def) out.push({ label: "", items: [[def[0], def[1]]] });
  return out;
}

/** 重建下拉选项（首次挂载 / 保存 / 删除都走这里） */
function rebuildPresets(node) {
  const sel = node.__adjPreset;
  if (!sel) return;
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  for (const { label, items } of presetLayout()) {
    let box = sel;
    if (label) {
      box = document.createElement("optgroup");
      box.label = label;
      sel.appendChild(box);
    }
    for (const [name] of items) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      box.appendChild(o);
    }
  }
}

/** 参数一变就刷新下拉显示：命中预设就显示预设名，否则显示「自定义」 */
function reflectPreset(node) {
  const sel = node.__adjPreset;
  if (!sel) return;
  const vals = valuesOf(node);
  const past = sel.querySelector('option[value="__custom__"]');   // 上次挂上去的「自定义」项
  const cur = sel.value && sel.value !== "__custom__" ? findPreset(sel.value) : null;

  // 当前选中的预设数据没变就保持选中：两套数值完全相同的预设
  // （比如存了两遍同样的参数）否则会互相抢名字，选中项自己跳走
  if (cur && cur.every((v, i) => v === vals[i])) {
    if (past) past.remove();
    return;
  }

  const name = matchPreset(vals);
  if (name) {
    if (past) past.remove();
  } else if (!past) {
    const o = document.createElement("option");
    o.value = "__custom__";
    o.textContent = CUSTOM_LABEL;
    sel.appendChild(o);
  }
  sel.value = name || "__custom__";
}

/** 应用预设：12 项一起写进原生 widget + 滑块 + 数值框，然后重画 */
function applyPreset(node, name) {
  const vals = findPreset(name);
  if (!vals) return;
  for (const r of node.__adjRows || []) {
    const idx = PARAMS.findIndex(([cn]) => cn === r.name);
    if (idx < 0 || idx >= 12) continue;          // 效果强度不在预设里
    const v = vals[idx];
    if (r.widget) r.widget.value = v;
    r.slider.value = String(v);
    r.num.value = String(v);
    r.num.classList.toggle("zero", v === 0);
  }
  reflectPreset(node);
  schedule(node);
}

/* 底部浮动提示：2 秒后自己淡出，不占布局 */
function toast(node, text, kind) {
  const el = node.__adjToast;
  if (!el) return;
  el.textContent = text;
  el.className = "ty-adj-toast show" + (kind ? " " + kind : "");
  clearTimeout(node.__adjToastTimer);
  node.__adjToastTimer = setTimeout(() => {
    el.className = "ty-adj-toast" + (kind ? " " + kind : "");
  }, 2000);
}

/** 把当前 12 项存成预设；跟自己存过的重名就直接覆盖 */
function saveCurrentAsPreset(node) {
  const box = node.__adjName;
  const vals = valuesOf(node);
  const mine = loadCustom();

  let name = (box?.value || "").trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
  if (!name) {
    // 没起名就自动编号 —— 别让「保存」变成一个会失败的动作
    let i = 1;
    while (mine.some((p) => p.name === `我的预设 ${i}`)
      || PRESETS.some(([n]) => n === `我的预设 ${i}`)) i++;
    name = `我的预设 ${i}`;
  }
  if (PRESETS.some(([n]) => n === name)) {
    toast(node, `「${name}」是内置预设，换个名字再存`, "bad");
    return false;
  }
  if (name === "__custom__") {          // 这个值被「自定义（已微调）」占着
    toast(node, "这个名字被系统占用了，换一个", "bad");
    return false;
  }

  const at = mine.findIndex((p) => p.name === name);
  const replaced = at >= 0;
  if (replaced) mine[at] = { name, vals };
  else mine.push({ name, vals });

  const persisted = saveCustom(mine);
  rebuildPresets(node);
  if (node.__adjPreset) node.__adjPreset.value = name;   // 存完就选中这一项
  if (box) box.value = name;
  toast(node, (replaced ? "已更新「" : "已保存「") + name + "」"
    + (persisted ? "" : "（浏览器不让存本地，仅本次有效）"), "ok");
  return true;
}

/** 删掉下拉里当前选中的自定义预设；参数保持不动，只是不再对应收藏 */
function deleteSelectedPreset(node) {
  const name = node.__adjPreset?.value || "";
  const mine = loadCustom();
  const at = mine.findIndex((p) => p.name === name);

  if (at < 0) {
    if (PRESETS.some(([n]) => n === name)) toast(node, `「${name}」是内置预设，不能删`, "bad");
    else toast(node, "当前不是已保存的预设，没有可删的", "bad");
    return false;
  }

  mine.splice(at, 1);
  const persisted = saveCustom(mine);
  rebuildPresets(node);
  reflectPreset(node);                                   // 参数没动，只重新认一次名字
  if (node.__adjName && node.__adjName.value.trim() === name) node.__adjName.value = "";
  toast(node, `已删除「${name}」` + (persisted ? "" : "（仅本次有效）"), "ok");
  return true;
}

function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "ty-adj";

  const view = document.createElement("div");
  view.className = "ty-adj-view";
  const cv = document.createElement("canvas");
  cv.className = "ty-adj-cv";
  const hint = document.createElement("div");
  hint.className = "ty-adj-hint";
  hint.innerHTML = "把图片接到 image 上，右边滑块直接出效果<small>也可以先跑一次，原图会被缓存下来</small>";
  const badge = document.createElement("div");
  badge.className = "ty-adj-badge";
  node.__adjBadge = badge;
  const toastEl = document.createElement("div");
  toastEl.className = "ty-adj-toast";
  node.__adjToast = toastEl;
  view.append(cv, badge, toastEl, hint);

  // ---- 图上方：预览分辨率档位
  const left = document.createElement("div");
  left.className = "ty-adj-left";
  const qualRow = document.createElement("div");
  qualRow.className = "ty-adj-quality";
  const qualLabel = document.createElement("span");
  qualLabel.textContent = "预览";
  const qualSel = document.createElement("select");
  for (const lv of QUALITY_LEVELS) {
    const o = document.createElement("option");
    o.value = String(lv);
    o.textContent = lv + "p";
    qualSel.appendChild(o);
  }
  qualSel.value = String(readQualityStore());
  qualSel.title = "预览分辨率（按最长边算）。越高越清楚、越吃 CPU；拖动时会自动降到约 55% 保证跟手";
  node.__adjQuality = qualSel;
  // 下拉展开时别让画布把点击当成拖动节点
  qualSel.addEventListener("pointerdown", (e) => e.stopPropagation());
  qualSel.addEventListener("change", () => {
    const cap = Number(qualSel.value);
    writeQualityStore(cap);
    const st = node.__adj;
    if (!st?.origImg) return;          // 还没取到图，等加载完会按新档位建
    buildSources(st, st.origImg, cap);
    render(node, true);
  });
  qualRow.append(qualLabel, qualSel);
  left.append(qualRow, view);

  const ctrl = document.createElement("div");
  ctrl.className = "ty-adj-ctrl";

  // ---- 预设下拉（第一项原图 = 全部归 0，最后一项 = 节点默认配方，自己存的插在中间）
  const presetRow = document.createElement("div");
  presetRow.className = "ty-adj-preset";
  const sel = document.createElement("select");
  node.__adjPreset = sel;
  rebuildPresets(node);
  // 下拉展开时别让画布把点击当成移动节点
  sel.addEventListener("pointerdown", (e) => e.stopPropagation());
  sel.addEventListener("change", () => {
    if (sel.value === "__custom__") return;      // 只是状态标记，点了不动参数
    // 选到自己存的预设就把它名字填进框里，方便直接改名另存 / 覆盖
    if (node.__adjName) node.__adjName.value = findPreset(sel.value) ? sel.value : "";
    applyPreset(node, sel.value);
  });
  presetRow.appendChild(sel);

  // ---- 预设名 + 保存 / 删除
  const saveRow = document.createElement("div");
  saveRow.className = "ty-adj-save";
  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.className = "ty-adj-name";
  nameIn.placeholder = "新预设名";
  nameIn.maxLength = NAME_MAX;
  nameIn.title = "给当前这套参数起个名字，点「保存」加进下拉";
  const btnSave = document.createElement("button");
  btnSave.type = "button";
  btnSave.className = "ty-adj-btn ok";
  btnSave.textContent = "保存";
  btnSave.title = "把当前 12 项参数存成预设（跟自己存过的重名就覆盖）";
  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "ty-adj-btn del";
  btnDel.textContent = "删除";
  btnDel.title = "删掉下拉里当前选中的那个预设（内置的不能删）";
  node.__adjName = nameIn;

  btnSave.addEventListener("click", () => saveCurrentAsPreset(node));
  btnDel.addEventListener("click", () => deleteSelectedPreset(node));
  // 框里敲回车 = 点保存
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveCurrentAsPreset(node);
    }
  });
  // 按钮 / 输入框上的点击和滚轮都别漏给画布
  for (const el of [nameIn, btnSave, btnDel]) {
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  }
  saveRow.append(nameIn, btnSave, btnDel);

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "ty-adj-rows";
  node.__adjRows = [];

  for (const [cn, , def] of PARAMS) {
    const w = (node.widgets || []).find((x) => x.name === cn);
    const min = Number(w?.options?.min ?? (cn === "效果强度" ? 0 : -100));
    const max = Number(w?.options?.max ?? 100);
    const raw = Number(w?.value ?? w?.options?.default ?? def);
    const init = Number.isFinite(raw) ? Math.round(raw) : def;

    const row = document.createElement("div");
    row.className = "ty-adj-row";

    const label = document.createElement("span");
    label.textContent = cn;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = "1";
    slider.value = String(init);

    // 数值框：和滑块是一个东西的两种输入方式，改哪边都算
    const num = document.createElement("input");
    num.type = "number";
    num.className = "ty-adj-num";
    num.min = String(min);
    num.max = String(max);
    num.step = "1";
    num.value = String(init);
    num.classList.toggle("zero", init === 0);

    /** 三处一起同步：原生 widget（序列化/后端用）+ 滑块 + 数值框 */
    const commit = (v, from) => {
      const val = Math.max(min, Math.min(max, Math.round(v)));
      if (w) w.value = val;
      if (from !== "slider") slider.value = String(val);
      if (from !== "num") num.value = String(val);
      num.classList.toggle("zero", val === 0);
      reflectPreset(node);
      schedule(node);
    };

    slider.addEventListener("input", () => commit(Number(slider.value), "slider"));
    slider.addEventListener("pointerdown", (e) => e.stopPropagation());

    // 边打边生效，但不抢用户手里的字（打到一半是空 / 负号就先不管）
    num.addEventListener("input", () => {
      const raw2 = num.value.trim().replace(/^\+/, "");
      if (raw2 === "" || raw2 === "-" || raw2 === ".") return;
      const v = Number(raw2);
      if (!Number.isFinite(v)) return;
      const val = Math.max(min, Math.min(max, Math.round(v)));
      if (w) w.value = val;
      slider.value = String(val);
      num.classList.toggle("zero", val === 0);
      reflectPreset(node);
      schedule(node);
    });
    // 失焦 / 回车：把框里的字规整成夹取后的整数（此时要连框一起写回，所以不传 from）
    const tidy = () => {
      const t = num.value.trim().replace(/^\+/, "");
      const v = Number(t);
      commit(t === "" || !Number.isFinite(v) ? Number(w?.value ?? init) : v);
    };
    num.addEventListener("blur", tidy);
    num.addEventListener("change", tidy);
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        num.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // 原生步进发生在 keydown 之后，等一拍再同步
        setTimeout(() => num.dispatchEvent(new Event("input")), 0);
      }
    });
    // 别让画布把点击输入框当成移动节点
    num.addEventListener("pointerdown", (e) => e.stopPropagation());

    // 滚轮别漏到画布上去缩放节点图
    for (const el of [slider, num]) {
      el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    }

    row.append(label, slider, num);
    rowsWrap.appendChild(row);
    node.__adjRows.push({ name: cn, slider, num, widget: w, min, max });
  }

  ctrl.append(presetRow, saveRow, rowsWrap);
  root.append(left, ctrl);
  reflectPreset(node);
  return { root, cv, hint };
}

function schedule(node) {
  if (node.__adjRaf) return;
  node.__adjRaf = requestAnimationFrame(() => {
    node.__adjRaf = 0;
    // 先把低清档的结果顶上去，拖动才不会一顿一顿的
    render(node, false);
    // 手停下来再补一帧高清（连续拖动会不断重置，只在真停下来时才跑）
    clearTimeout(node.__adjHiTimer);
    node.__adjHiTimer = setTimeout(() => {
      node.__adjHiTimer = 0;
      // 这 160ms 里节点可能已经被删了，别对着脱离文档的画布白算一帧
      if (!node.__adj?.canvas?.isConnected) return;
      render(node, true);
    }, 160);
  });
}

/**
 * 画一帧。
 *
 * @param hi true = 用高分辨率源（1440，清晰）；false = 用拖动档（720，跟手）
 *
 * 两档的源在 loadSource 里都准备好了：高清扫像素多、算法慢（十几项逐像素），
 * 拖滑块时跑不动；而拖动过程糊一点没人看得出，停下来 160ms 后自动补高清。
 */
function render(node, hi) {
  const st = node.__adj;
  if (!st || !st.src || !st.w) return;
  const t0 = performance.now();
  const p = collect(node);

  if (hi || !st.lo) {
    const out = applyAdjust(st.src, st.w, st.h, p);
    st.imgData.data.set(out);
    st.ctx.putImageData(st.imgData, 0, 0);
  } else {
    const lo = st.lo;
    const out = applyAdjust(lo.src, lo.w, lo.h, p);
    if (!st.loImgData || st.loImgData.width !== lo.w) {
      st.loImgData = lo.ctx.createImageData(lo.w, lo.h);
    }
    st.loImgData.data.set(out);
    lo.ctx.putImageData(st.loImgData, 0, 0);
    // 放大回主画布：GPU 采样，比在小画布上直接显示清楚得多，也不会闪
    st.ctx.drawImage(lo.canvas, 0, 0, st.w, st.h);
  }

  node.__adjMs = Math.round(performance.now() - t0);
  node.__adjHi = !!hi;
  updateBadge(node, p);
}

/** 当前 12 项配方的「轻重」：绝对值之和。用来判断强度变化到底看不看得出来。 */
function recipeWeight(node) {
  let s = 0;
  for (const [cn] of PARAMS.slice(0, 12)) {
    const w = (node.widgets || []).find((x) => x.name === cn);
    const v = Number(w?.value);
    if (Number.isFinite(v)) s += Math.abs(v);
  }
  return s;
}

/* 预览左上角的强度角标：只在强度 < 100 时出现。
   轻配方下「效果减半」本身就只有 1~2 个灰阶，肉眼必然看不出 ——
   与其让人怀疑没生效，不如直接把原因写在图上。 */
function updateBadge(node, p) {
  const el = node.__adjBadge;
  if (!el) return;
  const op = Math.round((Number.isFinite(p.opacity) ? p.opacity : 1) * 100);
  if (op >= 100) {
    el.classList.remove("on");
    return;
  }
  const head = op === 0 ? "原图 · 效果 0%" : "效果强度 " + op + "%";
  let html = `<b>${head}</b>`;
  if (op > 0 && op < 95 && recipeWeight(node) < 90) {
    html += "<small>当前配方本身很轻，强度变化本来就小</small>";
  }
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
  el.classList.add("on");
}

/**
 * 按档位把原图重采样成「高清」和「拖动」两档像素，存在 st 上。
 *
 * @param cap 档位（最长边像素）。原图比档位小就保持原尺寸，绝不放大 ——
 *            放大不会更清楚，只是白烧 CPU。
 */
function buildSources(st, im, cap) {
  const nat = Math.max(im.naturalWidth, im.naturalHeight);
  const fit = (c) => {
    const s = Math.min(1, c / nat);
    return [
      Math.max(1, Math.round(im.naturalWidth * s)),
      Math.max(1, Math.round(im.naturalHeight * s)),
    ];
  };

  const [w, h] = fit(cap);
  st.w = w;
  st.h = h;
  st.canvas.width = w;
  st.canvas.height = h;
  st.ctx = st.canvas.getContext("2d", { willReadFrequently: true });
  st.ctx.imageSmoothingQuality = "high";
  st.ctx.drawImage(im, 0, 0, w, h);
  st.imgData = st.ctx.getImageData(0, 0, w, h);
  st.src = new Uint8ClampedArray(st.imgData.data);   // 原始像素，永远从它重新算

  // 拖动档单独用一张离屏 canvas：主画布要一直保持高清尺寸，
  // 拖动时算小图再放大贴上去，尺寸不跳、也不会闪。
  // 取档位的 55%（不低于 512）：档位越高，拖动时的省力越明显。
  const lcap = Math.min(cap, Math.max(512, Math.round(cap * 0.55)));
  const [lw, lh] = fit(lcap);
  st.lo = null;
  st.loImgData = null;
  if (lw < w || lh < h) {
    const loCanvas = document.createElement("canvas");
    loCanvas.width = lw;
    loCanvas.height = lh;
    const loCtx = loCanvas.getContext("2d", { willReadFrequently: true });
    loCtx.imageSmoothingQuality = "high";
    loCtx.drawImage(im, 0, 0, lw, lh);
    st.lo = {
      w: lw, h: lh, canvas: loCanvas, ctx: loCtx,
      src: new Uint8ClampedArray(loCtx.getImageData(0, 0, lw, lh).data),
    };
  }
}

/** 把图片读进来，按当前档位建好两档像素 */
function loadSource(node, img, onFail) {
  const url = viewUrl(img);
  const im = new Image();
  im.onload = () => {
    const st = node.__adj;
    st.origImg = im;          // 留着原始位图，切换档位时直接从它重采样，不用再下载
    st.url = url;
    buildSources(st, im, readQualityStore());
    st.hint.style.display = "none";
    render(node, true);
    node.setDirtyCanvas?.(true, true);
  };
  im.onerror = () => {
    if (onFail) return onFail();
    const st = node.__adj;
    st.hint.style.display = "flex";
    st.hint.textContent = "预览图已失效（temp 被清理），重跑一次即可";
  };
  im.src = url;
}

/* -------------------------------------------- 上游取图（省掉「先跑一次」）

   节点还没跑过时，反正上游多半是个 LoadImage —— 直接拿它的文件名去 /view 取，
   拖滑块就能出效果，不用为了看一眼先点一次运行。
   来源按可靠度排：上游执行后缓存的 imgs > 上游节点 widget 里的文件名；
   调用方（onConfigure）还会先试上次运行留在 properties 里的图。
   任何一条失败都自动试下一条，全都失败就安静地等运行。 */

const IMG_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

function upstreamCandidates(node) {
  const out = [];
  try {
    const slot = (node.inputs || []).findIndex((s) => s?.name === "image");
    const idx = slot >= 0 ? slot : 0;
    const srcNode = node.getInputNode ? node.getInputNode(idx) : null;
    if (!srcNode) return out;

    // ① 上游执行过就会带 imgs（/view 直接能读）
    const cached = srcNode.imgs?.[0] || srcNode.images?.[0];
    if (cached?.filename) out.push(cached);

    // ② LoadImage 这类节点：图片名就在字符串 widget 里，走 input 目录
    for (const w of srcNode.widgets || []) {
      if (w?.type === "button") continue;
      const v = typeof w?.value === "string" ? w.value.trim() : "";
      if (!v || !IMG_EXT.test(v)) continue;
      // 子目录里的图，value 会是 "sub/photo.jpg"，得拆成 subfolder + filename
      const cut = v.lastIndexOf("/");
      out.push(cut >= 0
        ? { filename: v.slice(cut + 1), subfolder: v.slice(0, cut), type: "input" }
        : { filename: v, subfolder: "", type: "input" });
    }
  } catch (_) {
    /* 取不到就等运行 */
  }
  return out;
}

/** force=false 时，当前底图已经就是这张就不再重读 */
function tryUpstream(node, force) {
  const st = node.__adj;
  if (!st) return;
  const list = upstreamCandidates(node);
  if (!list.length) return;

  const step = (i) => {
    if (i >= list.length) return;
    const c = list[i];
    if (st.src && !force && st.url === viewUrl(c)) return;
    loadSource(node, c, () => step(i + 1));
  };
  step(0);
}

/** 工作流加载后把原生 widget 的值同步到右侧滑块 / 数值框，并刷新预设显示 */
function syncSliders(node) {
  for (const r of node.__adjRows || []) {
    const raw = Number(r.widget?.value);
    const v = Number.isFinite(raw) ? Math.round(raw) : Number(r.slider.value);
    r.slider.value = String(v);
    r.num.value = String(v);
    r.num.classList.toggle("zero", v === 0);
  }
  reflectPreset(node);
}

function fitNode(node) {
  try {
    if (node.size[0] < MIN_NODE_W) node.setSize([MIN_NODE_W, node.size[1]]);
    const need = node.computeSize ? node.computeSize(node.size[0])[1] : 0;
    if (need > node.size[1] + 2) node.setSize([node.size[0], need]);
  } catch (_) {
    /* 交给前端默认布局 */
  }
}

/* 别的标签页 / 窗口改了预设库时，跟着刷新所有已挂载节点的下拉，
   不然一边删了、另一边还留着，点删除只会得到「没有可删的」。 */
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORE_KEY) return;
    resetCustomCache();
    const list = app?.graph?._nodes || app?.graph?.nodes || [];
    for (const n of list) {
      if (!n.__adjPreset) continue;
      rebuildPresets(n);
      reflectPreset(n);
    }
  });
}

app.registerExtension({
  name: "TaiYang.ImageAdjust.Panel",

  // 主通道：后端每执行完一个节点都会发 websocket `executed`。
  // 不能只靠 node.onExecuted —— Node 2.0（Vue 节点）下那个钩子不一定被调用，
  // 面板就会一直停在 properties 里存的上一次的原图上。
  setup() {
    try {
      api.addEventListener("executed", (ev) => {
        const d = ev?.detail;
        const src = d?.output?.ty_adjust_src?.[0];
        if (!src?.filename) return;
        const id = d.display_node ?? d.node;
        const node =
          app.graph?.getNodeById?.(Number(id)) ||
          app.graph?.getNodeById?.(id);
        if (!node?.__adj) return;
        if (node.__adj.lastSrcName === src.filename) return;   // 两条通道只生效一次
        node.__adj.lastSrcName = src.filename;
        node.properties = node.properties || {};
        node.properties["调整_原图"] = src;
        loadSource(node, src);
      });
    } catch (e) {
      console.warn("[TaiYang] 图片调整：executed 事件订阅失败", e);
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;

      try {
        ensureStyle();
        node.__adj = { src: null, w: 0, h: 0, canvas: null, ctx: null, imgData: null, hint: null };
        node.__adjRows = [];

        const { root, cv, hint } = buildPanel(node);
        node.__adj.canvas = cv;
        node.__adj.hint = hint;
        node.__adjEl = root;

        // 原生滑块压成 0 高度：值还在、照样序列化，只是不重复显示
        for (const w of node.widgets || []) {
          if (PARAMS.some(([cn]) => cn === w.name)) {
            w.computeSize = () => [0, -4];
            if (w.options) w.options.hidden = true;
          }
        }

        node.addDOMWidget("adjust_view", "TY_ADJUST_PANEL", root, {
          serialize: false,
          hideOnZoom: false,
          getHeight: () => PANEL_H,
          getMinHeight: () => PANEL_H,
          getMaxHeight: () => PANEL_H,
        });
        root.style.height = PANEL_H + "px";
        root.style.minHeight = PANEL_H + "px";
      } catch (e) {
        console.error("[TaiYang] 图片调整面板创建失败", e);
      }

      requestAnimationFrame(() => {
        fitNode(node);
        tryUpstream(node, false);
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => {
        syncSliders(this);
        fitNode(this);
        // 上次的预览图存在 properties 里，temp 没被清理就能直接恢复
        const saved = this.properties?.["调整_原图"];
        if (saved?.filename && !this.__adj?.src) loadSource(this, saved, () => tryUpstream(this, true));
        else if (!this.__adj?.src) tryUpstream(this, true);
      });
      return r;
    };

    // 接线一通就去上游要图：换掉源图也能立刻跟着换底图
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected) {
      const r = onConnectionsChange?.apply(this, arguments);
      if (connected && (type === undefined || type === 1)) setTimeout(() => tryUpstream(this, true), 0);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const src = message?.ty_adjust_src?.[0];
      if (!src?.filename) return;
      if (this.__adj?.lastSrcName === src.filename) return;   // executed 通道已经处理过
      this.properties = this.properties || {};
      this.properties["调整_原图"] = src;
      if (this.__adj) {
        this.__adj.lastSrcName = src.filename;
        loadSource(this, src);
      }
    };
  },
});
