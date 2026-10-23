/**
 * TaiYang · 面部去高光 —— 原图 / 结果 对比面板（DOM 版）
 *
 * 用 addDOMWidget 把一块真实 DOM 塞进节点，而不是在 canvas 上自绘。
 * 这样 ComfyUI 新旧两种节点渲染（包括 Node 2.0 / Vue 节点）都能正常显示，
 * 图片也能按节点实际宽度铺开，看得清。
 *
 * 交互：**不用拖**。鼠标进入面板就直接跟随——
 *   X 决定左右分界（1px 黑线），Y 决定圆形把手的上下位置。
 *
 * 图像由后端 run() 写到 temp 目录后经 ui.ty_compare 下发，这里只负责显示与跟随。
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAMES = [
  "TaiYangFaceDehighlightInpaint",   // 面部去高光（重绘·保纹理）
  "TaiYangImageAdjust",              // 图片调整
  "TaiYangImageCompare",             // 图片对比
  "TaiYangSmallFaceErase",           // 小脸涂抹
];
const WIDGET_NAME = "compare_view";   // 只作内部标识，不参与序列化
const WIDGET_TYPE = "TY_COMPARE_DOM";
const PANEL_H = 440;                  // 面板高度（px）
const MIN_NODE_W = 420;               // 建节点时至少这么宽，否则图太小
const KNOB_R = 14;                    // 把手半径，用于贴边时收一下，别被裁掉

// 这些节点才挂「原图/结果」叠加对比面板。
// 图片调整有自己的左右分栏面板（左边图、右边滑块，拖滑块实时预览），见 image_adjust_panel.js，
// 但它的参数兜底仍然由本文件的 NUMERIC_DEFAULTS / healNumericWidgets 负责。
const PANEL_NODES = [
  "TaiYangFaceDehighlightInpaint",   // 面部去高光（重绘·保纹理）
  "TaiYangImageCompare",             // 图片对比
  "TaiYangSmallFaceErase",           // 小脸涂抹
];

// 各节点的角标与空状态文案（图片对比用 A / B，另外两个是原图 / 结果）
const LABELS = {
  TaiYangImageCompare: ["A", "B"],
};
const EMPTY_HINT = {
  TaiYangImageCompare:
    "接上 A / B 两张图即可对比<b>鼠标移进来即可左右上下来回扫</b>",
  TaiYangSmallFaceErase:
    "接上参考图运行即可<b>非主视图的小脸会被涂成纯色</b>",
};

/* ------------------------------------------------------------------ 样式 */

const STYLE_ID = "ty-cmp-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.ty-cmp {
  position: relative; width: 100%; height: 100%; box-sizing: border-box;
  background: #141519; border-radius: 8px;
  /* 用内阴影画描边而不是 border：
     border 会让「内容区原点和尺寸」与 getBoundingClientRect 差 1px，
     鼠标换算和线条定位就会对不齐。内阴影不占布局，坐标完全一致。 */
  box-shadow: inset 0 0 0 1px #2c2e36;
  overflow: hidden; user-select: none; -webkit-user-select: none;
  touch-action: none; cursor: crosshair;
  display: flex; align-items: center; justify-content: center;
}
.ty-cmp > img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: contain; pointer-events: none; display: block;
}
.ty-cmp-b { z-index: 1; }              /* 结果（底层） */
.ty-cmp-a { z-index: 2; right: auto; bottom: auto; }  /* 位置/尺寸由 JS 按 B 的矩形摆 */

/* 分割线：1px 纯黑，没有任何发光。left/top/height 全部用百分比，
   这样画布缩放（DOM widget 会被整体 scale）时也不会跟鼠标错位。 */
.ty-cmp-line {
  position: absolute; width: 1px; margin-left: -0.5px; background: #000;
  z-index: 3; pointer-events: none; display: none;
}

/* 圆形把手：跟随鼠标上下走 */
.ty-cmp-knob {
  position: absolute; width: ${KNOB_R * 2}px; height: ${KNOB_R * 2}px;
  margin-left: ${-KNOB_R}px; margin-top: ${-KNOB_R}px;
  border-radius: 50%; background: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,.45);
  display: none; align-items: center; justify-content: center; gap: 4px;
  z-index: 4; pointer-events: none;
}
.ty-cmp-knob i {
  display: block; width: 0; height: 0;
  border-top: 5px solid transparent; border-bottom: 5px solid transparent;
}
.ty-cmp-knob i.l { border-right: 6px solid #16181d; }
.ty-cmp-knob i.r { border-left: 6px solid #16181d; }

.ty-cmp-tag {
  position: absolute; top: 8px; z-index: 4; pointer-events: none;
  padding: 2px 9px; border-radius: 9px; background: rgba(0,0,0,.66);
  color: #f2f3f5; font-size: 11px; line-height: 16px; font-weight: 600;
  letter-spacing: .5px;
}
.ty-cmp-tag-l { left: 8px; }
.ty-cmp-tag-r { right: 8px; }
.ty-cmp-hint {
  position: absolute; inset: 0; z-index: 5; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; color: #767b85; font-size: 12px; line-height: 18px; text-align: center;
  padding: 0 16px;
}
.ty-cmp-hint b { color: #4b4f58; font-weight: 400; font-size: 11px; }
.ty-cmp-hint.err { color: #c0705f; }

/* A / B 宽高比不一致时的提醒（叠加对比会横向错位） */
.ty-cmp-warn {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 8px;
  z-index: 5; pointer-events: none; display: none;
  padding: 2px 9px; border-radius: 9px;
  background: rgba(138, 84, 18, .88); color: #ffe6c4;
  font-size: 10px; line-height: 16px; font-weight: 600; white-space: nowrap;
}
`;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ 工具 */

function viewUrl(img) {
  if (!img || !img.filename) return "";
  const q = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "temp",
  });
  return `/view?${q.toString()}&rand=${Math.random()}`;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const IMG_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;

/** 一张图的稳定标识（不带 &rand，才能拿来做「这张读不到」的黑名单） */
const rawKey = (img) =>
  img?.filename ? `${img.type || "temp"}:${img.subfolder || ""}/${img.filename}` : "";

/**
 * 从某个输入槽往上摸一张「现在就能读到的图」。
 *
 * 为什么需要这个：节点面板的图本来只靠 run() 下发，也就是**必须跑一遍**。
 * 但 A/B 常常直接接的是 LoadImage —— 文件名就摆在它的 widget 里，
 * 完全没必要等出图。这条兜底让「接上线就能对比」成立，
 * 也顺带解决了缓存命中时后端不再重发 ui、面板变空的问题。
 *
 * 取不到（上游是采样器这类，前端没有文件名）就返回 null，交给 onExecuted。
 */
function upstreamImage(node, slotName) {
  try {
    const idx = (node.inputs || []).findIndex((s) => s?.name === slotName);
    if (idx < 0 || node.inputs[idx].link == null) return null;
    const src = node.getInputNode ? node.getInputNode(idx) : null;
    if (!src) return null;

    // ① 上游自带预览（执行过 / 本身就是预览节点）
    const cached = src.imgs?.[0] || src.images?.[0];
    if (cached?.filename) return cached;

    // ② LoadImage 这类：图片名在字符串 widget 里，实际落在 input 目录
    for (const w of src.widgets || []) {
      if (w?.type === "button") continue;
      const v = typeof w?.value === "string" ? w.value.trim() : "";
      if (!v || !IMG_EXT.test(v)) continue;
      const cut = v.lastIndexOf("/");   // 子目录时值是 "sub/a.jpg"
      return cut >= 0
        ? { filename: v.slice(cut + 1), subfolder: v.slice(0, cut), type: "input" }
        : { filename: v, subfolder: "", type: "input" };
    }
  } catch (_) {
    /* 取不到就走 onExecuted */
  }
  return null;
}

/** 给 A / B 各自补一次上游图；缺哪个补哪个，已有的（执行结果）不覆盖 */
function tryUpstreamPair(node) {
  const st = node.__cmp;
  if (!st) return false;
  const bad = st.bad || (st.bad = new Set());
  let dirty = false;
  if (!st.a) {
    const a = upstreamImage(node, "image_a");
    if (a && !bad.has(rawKey(a))) { st.a = { raw: a, url: viewUrl(a) }; dirty = true; }
  }
  if (!st.b) {
    const b = upstreamImage(node, "image_b");
    if (b && !bad.has(rawKey(b))) { st.b = { raw: b, url: viewUrl(b) }; dirty = true; }
  }
  if (dirty) {
    st.failed = false;
    paint(node);
  }
  return dirty;
}

/**
 * 算出 object-fit: contain 之后图像在面板里的**相对矩形**（0~1 分数）。
 *
 * 全部用分数而不是像素，是因为 DOM widget 会跟画布一起被 CSS transform 缩放：
 * getBoundingClientRect() 拿到的是缩放后的屏幕尺寸，clientWidth 是布局尺寸，
 * 两者混用会让"图占面板的比例"算错，表现出来的现象就是**线比鼠标跑得快**。
 * 只要鼠标比例和线条位置都走同一套分数，缩放多少都不影响对齐。
 *
 * 图还没加载完（naturalWidth 为 0）时返回 ok:false，调用方退回整块面板。
 */
function imgFrac(root, img) {
  const W = root.clientWidth;
  const H = root.clientHeight;
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  if (!nw || !nh || !W || !H) return { fx: 0, fy: 0, fw: 1, fh: 1, ok: false };
  const s = Math.min(W / nw, H / nh);
  const w = nw * s;
  const h = nh * s;
  return { fx: (W - w) / 2 / W, fy: (H - h) / 2 / H, fw: w / W, fh: h / H, ok: true };
}

/* ------------------------------------------------------------------ 面板 */

function buildRoot(node, nodeName) {
  const [tagA, tagB] = LABELS[nodeName] || ["原图", "结果"];
  const emptyHint = EMPTY_HINT[nodeName]
    || "运行后在此显示 原图 / 结果 对比<b>鼠标移进来即可左右上下来回扫</b>";

  const root = document.createElement("div");
  root.className = "ty-cmp";
  root.innerHTML = `
    <img class="ty-cmp-b" alt="" draggable="false" />
    <img class="ty-cmp-a" alt="" draggable="false" />
    <div class="ty-cmp-line"></div>
    <div class="ty-cmp-knob"><i class="l"></i><i class="r"></i></div>
    <div class="ty-cmp-tag ty-cmp-tag-l">${tagA}</div>
    <div class="ty-cmp-tag ty-cmp-tag-r">${tagB}</div>
    <div class="ty-cmp-warn">A / B 宽高比不同，叠加按 B 对齐</div>
    <div class="ty-cmp-hint">${emptyHint}</div>
  `;
  node.__tyHint = emptyHint;

  root.style.height = PANEL_H + "px";
  root.style.minHeight = PANEL_H + "px";

  const st = node.__cmp;

  // 鼠标一动就跟着走，不需要按下去
  const follow = (e) => {
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 只用「相对整块面板的比例」换算，跟缩放无关
    const mx = (e.clientX - r.left) / r.width;
    const my = (e.clientY - r.top) / r.height;
    const f = imgFrac(root, root.querySelector(".ty-cmp-b"));
    if (f.ok) {
      st.ratio = clamp01((mx - f.fx) / f.fw);
      st.knobY = clamp01((my - f.fy) / f.fh);
    } else {
      st.ratio = clamp01(mx);
      st.knobY = clamp01(my);
    }
    paint(node);
  };

  root.addEventListener("pointermove", (e) => {
    if (!st.a || !st.b) return;
    follow(e);
    // 不让画布把这次移动当成拖节点
    e.stopPropagation();
  });

  root.addEventListener("pointerenter", (e) => {
    if (!st.a || !st.b) return;
    follow(e);
  });

  // 触摸屏没有 hover，按下即定位；同时阻止顺带拖动整个节点
  root.addEventListener("pointerdown", (e) => {
    if (!st.a || !st.b) return;
    follow(e);
    e.preventDefault();
    e.stopPropagation();
  });

  // 阻止右键菜单 / 拖拽事件冒泡到画布
  root.addEventListener("contextmenu", (e) => e.stopPropagation());
  root.addEventListener("dragstart", (e) => e.preventDefault());

  // 图加载完才知道真实尺寸，需要按真实矩形重算一次
  root.querySelector(".ty-cmp-b").addEventListener("load", () => paint(node));

  // 读不到图（temp 被清理 / 上游换了图）→ 丢掉这一侧，退回空状态；
  // 坏掉的图记进 bad，避免「重设 src → 再 error」来回打转。
  for (const [key, sel] of [["a", ".ty-cmp-a"], ["b", ".ty-cmp-b"]]) {
    root.querySelector(sel).addEventListener("error", () => {
      const s = node.__cmp;
      const src = root.querySelector(sel).getAttribute("src");
      if (!s || !src) return;
      const img = s[key]?.raw;
      const k = rawKey(img);
      s.bad = s.bad || new Set();
      if (!k || s.bad.has(k)) { paint(node); return; }
      s.bad.add(k);
      s[key] = null;
      s.failed = true;
      paint(node);
      tryUpstreamPair(node);
    });
  }

  // 节点被拉宽拉高时，图像矩形变了，线也要跟着重算
  try {
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => paint(node));
      ro.observe(root);
      node.__cmpRO = ro;
    }
  } catch (_) {
    /* 没有 ResizeObserver 就靠 paint 的调用时机 */
  }

  return root;
}

function paint(node) {
  const el = node.__cmpEl;
  if (!el) return;
  const st = node.__cmp || {};
  const a = el.querySelector(".ty-cmp-a");
  const b = el.querySelector(".ty-cmp-b");
  const line = el.querySelector(".ty-cmp-line");
  const knob = el.querySelector(".ty-cmp-knob");
  const hint = el.querySelector(".ty-cmp-hint");
  const warn = el.querySelector(".ty-cmp-warn");
  const tagL = el.querySelector(".ty-cmp-tag-l");
  const tagR = el.querySelector(".ty-cmp-tag-r");
  if (!a || !b || !line || !knob || !hint) return;

  // 黑名单里的图（404 / temp 被清理）当作没有，别拿它去铺面板
  const usable = (v) => !!v?.url && !(st.bad && st.bad.has(rawKey(v.raw)));
  const hasA = usable(st.a);
  const hasB = usable(st.b);
  const has = hasA && hasB;

  if (hasA && a.getAttribute("src") !== st.a.url) a.src = st.a.url;
  if (hasB && b.getAttribute("src") !== st.b.url) b.src = st.b.url;
  if (!hasA) a.removeAttribute("src");
  if (!hasB) b.removeAttribute("src");

  hint.style.display = has ? "none" : "flex";
  if (!has) {
    hint.classList.remove("err");
    hint.innerHTML = st.failed
      ? "对比图已失效（temp 目录被清理），重跑一次即可"
      : (node.__tyHint || "运行后在此显示 原图 / 结果 对比<b>鼠标移进来即可左右上下来回扫</b>");
  }

  // A / B 宽高比不同时，叠加对比只能按 B 的矩形对齐，提示一句免得以为是画错了
  if (warn) {
    const ra = a.naturalWidth && a.naturalHeight ? a.naturalWidth / a.naturalHeight : 0;
    const rb = b.naturalWidth && b.naturalHeight ? b.naturalWidth / b.naturalHeight : 0;
    warn.style.display = has && ra && rb && Math.abs(ra - rb) / rb > 0.005 ? "block" : "none";
  }

  const f = imgFrac(el, b);
  const H = el.clientHeight;
  const ratio = clamp01(st.ratio ?? 0.5);
  const knobY = clamp01(st.knobY ?? 0.5);

  // 分界线落在图像（而不是整块面板）的范围内，全部用 0~1 分数
  const splitF = f.fx + f.fw * ratio;

  // A 图强行摆到 B 的显示矩形上：
  // 两张图尺寸 / 比例不同时，各按 object-fit: contain 居中会出现两个不同的矩形，
  // 结果是「线按 B 算、A 却偏在别处」，扫起来完全错位。
  // 这里让 A 填满 B 的那块矩形（fill 会有一点比例失真，换严格对齐，值了）。
  if (f.ok) {
    a.style.left = (f.fx * 100).toFixed(4) + "%";
    a.style.top = (f.fy * 100).toFixed(4) + "%";
    a.style.width = (f.fw * 100).toFixed(4) + "%";
    a.style.height = (f.fh * 100).toFixed(4) + "%";
    a.style.objectFit = "fill";
  } else {
    a.style.left = "0";
    a.style.top = "0";
    a.style.width = "100%";
    a.style.height = "100%";
    a.style.objectFit = "contain";
  }

  // clip-path 的百分比相对 A 自己的盒；A 的盒现在已经等于 B 的矩形，
  // 所以直接按 ratio 裁，不再需要面板坐标换算。
  a.style.clipPath = `inset(0 ${((1 - ratio) * 100).toFixed(4)}% 0 0)`;

  const lineOn = has && f.fw > 0;
  line.style.display = lineOn ? "block" : "none";
  knob.style.display = lineOn ? "flex" : "none";

  if (lineOn) {
    line.style.left = (splitF * 100).toFixed(4) + "%";
    line.style.top = (f.fy * 100).toFixed(4) + "%";
    line.style.height = (f.fh * 100).toFixed(4) + "%";

    // 把手跟随鼠标上下，贴边时往里收一个半径，别被面板裁掉
    let ky = f.fy + f.fh * knobY;
    const pad = H ? KNOB_R / H : 0;
    const lo = f.fy + pad;
    const hi = f.fy + f.fh - pad;
    if (hi > lo) ky = Math.min(hi, Math.max(lo, ky));

    knob.style.left = (splitF * 100).toFixed(4) + "%";
    knob.style.top = (ky * 100).toFixed(4) + "%";
  }

  tagL.style.display = has && ratio > 0.12 ? "block" : "none";
  tagR.style.display = has && ratio < 0.88 ? "block" : "none";
}

/**
 * 把一对 A / B 图装到节点上。
 *
 * 两条路都走这里：`api` 的 `executed` 事件（主通道）和 `onExecuted`（旧通道兼容）。
 * 同一对图重复进来直接跳过 —— 重设 src 会让浏览器重新解码一次，画面会闪。
 */
function applyCompare(node, pair) {
  if (!node || !node.__cmpEl) return false;          // 不是挂面板的节点
  if (!Array.isArray(pair) || pair.length < 2) return false;
  const [before, after] = pair;
  if (!before?.filename || !after?.filename) return false;

  const st = node.__cmp || (node.__cmp = { ratio: 0.5, knobY: 0.5 });
  if (st.a?.raw?.filename === before.filename && st.b?.raw?.filename === after.filename) {
    return false;
  }

  st.a = { raw: before, url: viewUrl(before) };
  st.b = { raw: after, url: viewUrl(after) };
  st.failed = false;
  st.bad = new Set();          // 新图进来，之前的 404 记录作废

  // 存进 properties：工作流存盘后再打开，哪怕 temp 已清也能先亮出上次的图
  node.properties = node.properties || {};
  node.properties["对比_原图"] = before;
  node.properties["对比_结果"] = after;

  paint(node);
  node.setDirtyCanvas?.(true, true);
  return true;
}

/* -------------------------------------------------- 数值参数兜底（防 int("") ） */

/**
 * 后端 execution.py 对 INT 输入做 int(val)、对 FLOAT 做 float(val)。
 * 前端只要送来空字符串，转换就抛 ValueError，**整个 prompt 判为非法**，
 * 节点代码还没开始执行就被拦下了——所以只能在前端兜住。
 *
 * 实际触发场景：工作流是在旧版本（参数少）时存的，新增的参数没有存值，
 * 加载后 widget.value 是 ""，一提交就报「饱和度值无法转换到 int」。
 *
 * 兜底分三处：onConfigure（加载旧工作流）、onNodeCreated（新拖节点）、
 * graphToPrompt（最后一道，提交前逐个数字参数体检）。
 */
const NUMERIC_DEFAULTS = {
  TaiYangFaceDehighlightInpaint: {
    高光阈值: 0.75, 种子: 123456789, 步数: 28, 降噪: 0.45,
  },
  TaiYangSmallFaceErase: {
    检测阈值: 0.12, 保留脸数: 1, 涂抹倍数: 1.8,
  },
  TaiYangImageAdjust: {
    曝光: 4, 对比度: 0, 高光: 6, 阴影: -14, 鲜明度: 11, 饱和度: 0,
    色温: -4, 色调: 0, 色相: 0, 清晰度: 0, 锐化: 0, 暗角: 0,
    效果强度: 100,
  },
};

/** 能不能当成数字用；返回数字或 null（null = 需要回填默认值） */
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 取某个参数的默认值：先问 widget 自己，再退到内置表 */
function defaultOf(node, nodeName, key) {
  const w = (node?.widgets || []).find((x) => x?.name === key);
  const d = w?.options?.default;
  if (typeof d === "number" && Number.isFinite(d)) return d;
  const m = NUMERIC_DEFAULTS[nodeName]?.[key];
  return typeof m === "number" ? m : 0;
}

/** 就地修好节点上的空值 widget，返回修了几个 */
/** 取某个 widget 的合法范围（没有就返回 null） */
function rangeOf(w) {
  const o = w?.options || {};
  const has = typeof o.min === "number" || typeof o.max === "number";
  return has ? { min: o.min, max: o.max } : null;
}

/**
 * 这个值要不要替换：
 * 空值 / 非数字 → 用默认值；超出 min~max → 也用默认值。
 *
 * 后者是刻意选的「回默认」而不是「钳到边界」：滑杆本身拖不出越界值，
 * 能越界只可能是旧工作流按位置错位塞进来的（比如「填充明暗」拿到旧的 feather 10），
 * 钳成边界值反而是个假数据，回默认才对。
 */
function badValue(w, v) {
  if (v === null) return true;
  const r = rangeOf(w);
  if (!r) return false;
  if (typeof r.min === "number" && v < r.min) return true;
  if (typeof r.max === "number" && v > r.max) return true;
  return false;
}

/** 就地修好节点上的空值 / 越界 widget，返回修了几个 */
function healNumericWidgets(node, nodeName) {
  let fixed = 0;
  for (const w of node.widgets || []) {
    if (!w || !rangeOf(w)) continue;          // 只碰带范围的滑杆 / 数字框
    const v = toNumber(w.value);
    if (!badValue(w, v)) continue;
    const d = defaultOf(node, nodeName, w.name);
    w.value = d;
    try {
      // 让控件自己刷新显示（部分渲染下不刷新会显示空白）
      w.callback?.(d, app.canvas, node);
    } catch (_) {
      /* 回调签名各版本不同，失败不影响值 */
    }
    fixed++;
  }
  if (fixed) console.warn(`[TaiYang] ${nodeName}：${fixed} 个空值 / 越界参数已回填默认值`);
  return fixed;
}

/** 提交前体检：把 prompt.output 里我们节点的不合法数字参数修成默认值 */
function fixPromptOutput(output) {
  if (!output || typeof output !== "object") return 0;
  let fixed = 0;
  for (const [id, entry] of Object.entries(output)) {
    const ct = entry?.class_type;
    const keys = NUMERIC_DEFAULTS[ct];
    if (!keys || !entry.inputs) continue;
    const node = app.graph?.getNodeById?.(Number(id));
    for (const [k, v] of Object.entries(entry.inputs)) {
      if (!(k in keys)) continue;          // 只碰数值参数，模型名之类不动
      if (Array.isArray(v)) continue;      // 连线
      if (typeof v === "boolean") continue;

      const w = (node?.widgets || []).find((x) => x?.name === k);
      const n = toNumber(v);
      if (badValue(w, n)) {
        // 空值、非数字、或者超出 min~max（旧工作流按位置错位塞进来的）→ 回默认
        const d = defaultOf(node, ct, k);
        if (v !== d) {
          entry.inputs[k] = d;
          fixed++;
        }
      } else if (typeof v !== "number") {
        entry.inputs[k] = n;               // "4" / "0.0" 统一转真数字
        fixed++;
      }
    }
  }
  if (fixed) console.warn(`[TaiYang] 提交前修正了 ${fixed} 个参数值`);
  return fixed;
}

/** 包一层 graphToPrompt，作为最后一道闸 */
let promptGuarded = false;
function guardPrompt() {
  if (promptGuarded) return true;
  const wrap = (obj, key) => {
    if (!obj || typeof obj[key] !== "function" || obj[key].__tyWrapped) return false;
    const orig = obj[key];
    const wrapped = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        fixPromptOutput(res?.output ?? res?.prompt);
      } catch (e) {
        console.warn("[TaiYang] prompt 兜底失败", e);
      }
      return res;
    };
    wrapped.__tyWrapped = true;
    obj[key] = wrapped;
    return true;
  };
  // 1.55 前端把它挂在 app 上（app.graphToPrompt(rootGraph)），旧版挂在 app.graph 上，两处都兼容
  const ok = wrap(app, "graphToPrompt") || wrap(app.graph, "graphToPrompt");
  promptGuarded = ok;
  return ok;
}

/* ------------------------------------------------------------------ 尺寸 */

function fitNode(node) {
  try {
    if (node.size[0] < MIN_NODE_W) node.setSize([MIN_NODE_W, node.size[1]]);
    const need = node.computeSize ? node.computeSize(node.size[0])[1] : 0;
    if (need > node.size[1] + 2) node.setSize([node.size[0], need]);
  } catch (e) {
    /* 算不出来就交给前端默认布局 */
  }
}

/* ------------------------------------------------------------------ 注册 */

app.registerExtension({
  name: "TaiYang.FaceDehighlight.ComparePanel",

  // 提交前兜底：把空字符串 / 非数字的数值参数修正掉
  setup() {
    // graphToPrompt 可能比 setup 晚挂上，没包成就延后重试两次
    if (!guardPrompt()) {
      setTimeout(guardPrompt, 800);
      setTimeout(guardPrompt, 3000);
    }

    // 主通道：后端每执行完一个节点都会发 websocket `executed`，detail 里带着
    // {node, display_node, output, prompt_id}。
    //
    // 为什么不用 node.onExecuted 就够：Node 2.0（Vue 节点）下那个钩子不一定被调用，
    // 前端 1.55 自己有 nodeOutputs + onNodeOutputsUpdated 一套新分发，官方
    // PreviewAny / Preview3D 也都是「改 onExecuted + 额外挂 onNodeOutputsUpdated」双写。
    // 只挂 onExecuted 的结果就是：面板一直停留在 properties 里存的上一次的图。
    try {
      api.addEventListener("executed", (ev) => {
        const d = ev?.detail;
        if (!d?.output) return;
        const id = d.display_node ?? d.node;
        const node =
          app.graph?.getNodeById?.(Number(id)) ||
          app.graph?.getNodeById?.(id);
        if (node) applyCompare(node, d.output.ty_compare);
      });
    } catch (e) {
      console.warn("[TaiYang] executed 事件订阅失败，退回 onExecuted", e);
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.includes(nodeData.name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;

      // 图片调整不在这里建对比面板，只做参数兜底
      if (!PANEL_NODES.includes(nodeData.name)) {
        requestAnimationFrame(() => healNumericWidgets(node, nodeData.name));
        return r;
      }

      node.__cmp = { a: null, b: null, ratio: 0.5, knobY: 0.5, failed: false, bad: new Set() };

      try {
        ensureStyle();
        const root = buildRoot(node, nodeData.name);
        node.__cmpEl = root;

        // DOM widget：新旧渲染都支持，Node 2.0 下也能正常显示
        node.__cmpWidget = node.addDOMWidget(WIDGET_NAME, WIDGET_TYPE, root, {
          serialize: false,      // 不写进 workflow 的 widgets_values
          hideOnZoom: false,
          getHeight: () => PANEL_H,
          getMinHeight: () => PANEL_H,
          getMaxHeight: () => PANEL_H,
        });

        paint(node);
      } catch (e) {
        console.error("[TaiYang] 对比面板创建失败", e);
      }

      requestAnimationFrame(() => {
        healNumericWidgets(node, nodeData.name);
        fitNode(node);
        tryUpstreamPair(node);
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);

      // 旧版工作流存下来的 widgets_values 个数和现在的控件数对不上 ——
      // 说明参数被后来加过（去高光从 6 个加到 7 个、图片调整从 5 个加到 12 个），
      // 前端只能按位置硬塞，结果就是「填充明暗」拿到旧 feather 的 10 这种越界值，
      // 提交时直接被后端以 value_bigger_than_max 拒掉。
      // 与其将错就错，不如整组回默认，让用户看到的就是正确配方。
      const vals = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
      const total = (this.widgets || []).filter(
        (w) => w && w.serialize !== false && w.options?.serialize !== false
      ).length;
      if (vals && total && vals.length < total) {
        for (const w of this.widgets || []) {
          if (!w || !rangeOf(w)) continue;      // 只重置滑杆 / 数字框
          w.value = defaultOf(this, nodeData.name, w.name);
          try {
            w.callback?.(w.value, app.canvas, this);
          } catch (_) {
            /* 同上 */
          }
        }
        console.warn(
          `[TaiYang] 旧版工作流（存了 ${vals.length} 个值，当前 ${total} 个控件），` +
          "已把参数重置为默认值"
        );
      }

      healNumericWidgets(this, nodeData.name);

      // 图片调整只有参数兜底，面板由 image_adjust_panel.js 管，不要在这里改尺寸
      if (!PANEL_NODES.includes(nodeData.name)) return r;

      const a = this.properties?.["对比_原图"];
      const b = this.properties?.["对比_结果"];
      this.__cmp = this.__cmp || { ratio: 0.5, knobY: 0.5, bad: new Set() };
      if (a?.filename && b?.filename) {
        this.__cmp.a = { raw: a, url: viewUrl(a) };
        this.__cmp.b = { raw: b, url: viewUrl(b) };
      }
      requestAnimationFrame(() => {
        fitNode(this);
        // 老工作流里存的 temp 图可能早被清了，先按上游补一次再亮相
        tryUpstreamPair(this);
        paint(this);
      });
      return r;
    };

    // 换线 / 接线时立刻按新上游重取，不用等运行
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, slot, connected) {
      const r = onConnectionsChange?.apply(this, arguments);
      if (!PANEL_NODES.includes(nodeData.name)) return r;
      if (type !== 1) return r;                       // 1 = 输入槽
      const name = this.inputs?.[slot]?.name;
      if (name !== "image_a" && name !== "image_b") return r;
      const st = this.__cmp;
      if (!st) return r;

      // 这一侧原来的图作废（可能是上一次执行的结果），重新摸上游
      st[name === "image_a" ? "a" : "b"] = null;
      if (connected) st.bad = new Set();              // 重新接的图，允许再试一次
      requestAnimationFrame(() => {
        paint(this);
        tryUpstreamPair(this);
      });
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      if (!PANEL_NODES.includes(nodeData.name)) return;
      // 和 setup() 里的 executed 订阅走同一个函数，重复进来会被去重
      applyCompare(this, message?.ty_compare);
    };
  },
});
