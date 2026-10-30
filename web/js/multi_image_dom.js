/**
 * 多图参考节点（TaiYangMultiImageLoader）的 DOM 面板。
 *
 * 为什么要有这个文件：
 *   原实现把整个界面画在 canvas 上（onDrawForeground），点击由 onMouseDown 按坐标判定。
 *   这在 LiteGraph 渲染下没问题，但 **ComfyUI Node 2.0（Vue 节点）根本不画画布**，
 *   节点里就只剩一块空白。所以界面必须改用真实 DOM（addDOMWidget），
 *   这样两种渲染模式都能显示。
 *
 * 分工：
 *   - 业务逻辑（自动连线、输出槽、上传、排序）全在 multi_image.js 里，这里 import 复用，
 *     不复制一份，避免两边行为漂移。
 *   - 本文件只负责“画”和“收输入”：网格、按钮、下拉、拖放。
 *   - multi_image.js 里所有画布交互都会因 node.__tyDomPanel 为 true 而跳过。
 */

import { app } from "../../scripts/app.js";
import {
  MAX_IMAGES,
  MODE_OPTIONS,
  UPSCALE_METHODS,
  DEFAULT_STEPS,
  getWidget,
  getImageFiles,
  setImages,
  getMode,
  getMegapixels,
  setMegapixels,
  getUpscaleMethod,
  setUpscaleMethod,
  getResolutionSteps,
  setResolutionSteps,
  uploadOne,
  syncConnections,
  reorderList,
  scaledSize,
  MODE_OFF,
  toggleAutoLink,
  disconnectAllOutputs,
} from "./multi_image.js";

const NODE_NAME = "TaiYangMultiImageLoader";

const CELL = 130;
const GAP = 10;
const COLS = 4;
const MIN_NODE_W = 560;
const TOP_H = 24;
const CTRL_H = 56;
const PAD = 12;
const VGAP = 8;

const STYLE_ID = "ty-mi-style";
const POLL_MS = 600;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.ty-mi {
  display: flex; flex-direction: column; gap: ${VGAP}px;
  width: 100%; height: 100%; box-sizing: border-box; padding: 6px;
  border-radius: 8px; background: #17181c;
  box-shadow: inset 0 0 0 1px #2c2e36;
  user-select: none; -webkit-user-select: none;
  font-family: inherit;
}
.ty-mi-top { display: flex; align-items: center; gap: 8px; height: ${TOP_H}px; flex: 0 0 ${TOP_H}px; }
.ty-mi-title { font-size: 12px; font-weight: 600; color: #8fd0ff; letter-spacing: .2px; }
.ty-mi-link { font-size: 11.5px; color: #9aa0ab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ty-mi-link.ok { color: #8fe08f; }
.ty-mi-link.warn { color: #ffd479; }
.ty-mi-spacer { flex: 1 1 auto; min-width: 0; }

.ty-mi-grid {
  display: grid; grid-template-columns: repeat(${COLS}, ${CELL}px);
  gap: ${GAP}px; justify-content: center; align-content: start;
  flex: 0 0 auto;
}
.ty-mi-cell {
  position: relative; width: ${CELL}px; height: ${CELL}px;
  border-radius: 6px; background: #0f1013; overflow: hidden;
  box-shadow: inset 0 0 0 1px #2b2e35;
}
.ty-mi-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ty-mi-cell.has { cursor: grab; }
.ty-mi-cell.has:active { cursor: grabbing; }
.ty-mi-cell.empty { background: #121316; box-shadow: inset 0 0 0 1px #24262c; }
.ty-mi-cell.add {
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: #141519; box-shadow: inset 0 0 0 1px #30333b;
  color: #5c636e; font-size: 26px; font-weight: 300; line-height: 1;
}
.ty-mi-cell.add:hover { background: #17202a; color: #8fd0ff; box-shadow: inset 0 0 0 1px #3f6f95; }
.ty-mi-cell.add.off { cursor: not-allowed; opacity: .45; }
.ty-mi-cell.dragging { opacity: .4; }
.ty-mi-cell.over { box-shadow: inset 0 0 0 2px #8fd0ff; }
.ty-mi-idx {
  position: absolute; left: 6px; top: 5px; padding: 1px 5px; border-radius: 4px;
  font-size: 10.5px; line-height: 14px; color: #cfd3db;
  background: rgba(8,9,12,.72);
}
/* 图下方标注「实际送进模型的分辨率」 */
.ty-mi-size {
  position: absolute; left: 5px; bottom: 4px; padding: 1px 5px; border-radius: 4px;
  font-size: 10px; line-height: 13px; color: #d6e4f0;
  background: rgba(8,9,12,.72); font-variant-numeric: tabular-nums;
}
.ty-mi-del {
  position: absolute; right: 4px; top: 4px; width: 18px; height: 18px;
  padding: 0; border: none; border-radius: 50%; cursor: pointer;
  background: rgba(8,9,12,.78); color: #dfe2e8;
  font-size: 13px; line-height: 18px; text-align: center;
  opacity: 0; transition: opacity .12s;
}
.ty-mi-cell.has:hover .ty-mi-del { opacity: 1; }
.ty-mi-del:hover { background: #a33; color: #fff; }

.ty-mi-ctrl { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
.ty-mi-line { display: flex; align-items: center; gap: 6px; height: 24px; }
.ty-mi-lb { font-size: 11px; color: #b7bcc7; white-space: nowrap; }
.ty-mi-num {
  width: 54px; height: 22px; box-sizing: border-box; padding: 0 5px;
  border-radius: 4px; background: #1c1e24; color: #dfe2e8;
  font-size: 11px; font-family: inherit; text-align: right;
  border: 1px solid #2f323a; outline: none;
  -moz-appearance: textfield;
}
.ty-mi-num::-webkit-outer-spin-button,
.ty-mi-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ty-mi-num:focus { border-color: #6b7ce0; background: #22252d; color: #fff; box-shadow: 0 0 0 2px rgba(107,124,224,.18); }
.ty-mi-unit { font-size: 10.5px; color: #6b7079; }
.ty-mi-sel {
  flex: 1 1 0; min-width: 0; height: 24px; padding: 0 4px;
  border-radius: 4px; background: #23252c; color: #dfe2e8;
  font-size: 11px; font-family: inherit; border: 1px solid #34373f;
  outline: none; cursor: pointer;
}
.ty-mi-sel:hover { border-color: #4a4e59; }
.ty-mi-btn {
  flex: 0 0 auto; height: 24px; padding: 0 8px; box-sizing: border-box;
  border-radius: 4px; cursor: pointer; white-space: nowrap;
  font-size: 11px; font-family: inherit; line-height: 1;
  background: #262931; color: #cfd3db; border: 1px solid #353941;
}
.ty-mi-btn:hover { background: #2e323b; border-color: #454a55; color: #fff; }
.ty-mi-btn:active { transform: translateY(1px); }
.ty-mi-btn.pri { border-color: #35506a; color: #b9ddf6; }
.ty-mi-btn.pri:hover { border-color: #3f6f95; background: #1d2a36; color: #d7ecff; }
.ty-mi-btn.danger:hover { border-color: #7a3d47; color: #f2c3c9; }
/* 顶部「关闭 / 开启自动连线」开关：开着时是蓝边，关掉后转橙，一眼能看出状态 */
.ty-mi-auto {
  border-color: #35506a; color: #b9ddf6;
  height: 22px; padding: 0 7px; font-size: 10.5px;
  display: inline-flex; align-items: center; gap: 5px;
}
.ty-mi-auto:hover { border-color: #3f6f95; background: #1d2a36; color: #d7ecff; }
.ty-mi-auto .dot { width: 6px; height: 6px; border-radius: 50%; background: #6fd06f; }
.ty-mi-auto.off { border-color: #6b5636; color: #ffc98a; }
.ty-mi-auto.off:hover { border-color: #8a6d42; background: #2a2318; color: #ffdba8; }
.ty-mi-auto.off .dot { background: #e0a44a; }
`;
  document.head.appendChild(s);
}

function viewUrl(name) {
  return `/api/view?filename=${encodeURIComponent(name)}&type=input`;
}

/** 面板高度：随行数变化（1~4 行），和网格尺寸严丝合缝 */
function panelHeight(count) {
  const slots = Math.min(MAX_IMAGES, Math.max(COLS, count + 1));
  const rows = Math.ceil(slots / COLS);
  return PAD + TOP_H + VGAP + (rows * CELL + (rows - 1) * GAP) + VGAP + CTRL_H;
}

/** 已连线的输出槽个数（同一输出接多个目标只算一个） */
function linkedCount(node) {
  let n = 0;
  for (const out of node.outputs || []) {
    if ((out.links || []).length) n++;
  }
  return n;
}

/** 让节点高度贴合面板：行数变了 / 载入工作流后都要走一次 */
function fitNode(node) {
  try {
    const w = Math.max(MIN_NODE_W, node.size?.[0] || 0);
    const h = node.computeSize ? node.computeSize(w)[1] : node.size?.[1];
    if (!h) return;
    if (Math.abs((node.size?.[0] || 0) - w) > 1 || Math.abs((node.size?.[1] || 0) - h) > 2) {
      node.setSize([w, h]);
    }
  } catch (_) {
    /* 交给前端默认布局 */
  }
}

function build(node) {
  ensureStyle();

  const root = document.createElement("div");
  root.className = "ty-mi";
  root.innerHTML = `
    <div class="ty-mi-top">
      <span class="ty-mi-title">参考图</span>
      <span class="ty-mi-link"></span>
      <span class="ty-mi-spacer"></span>
      <button type="button" class="ty-mi-btn ty-mi-auto" title="关闭后本节点不再自动连线，改由手动拉线">
        <span class="dot"></span><span class="ty-mi-auto-txt">关闭自动连线</span>
      </button>
      <button type="button" class="ty-mi-btn danger ty-mi-clear">清空</button>
    </div>
    <div class="ty-mi-grid"></div>
    <div class="ty-mi-ctrl">
      <div class="ty-mi-line">
        <span class="ty-mi-lb">缩放</span>
        <input type="number" class="ty-mi-num ty-mi-mp" step="0.1" min="0" max="16" title="目标总像素 = 数值 × 1024²，0 = 不缩放">
        <span class="ty-mi-unit">MP</span>
        <span class="ty-mi-lb">对齐</span>
        <input type="number" class="ty-mi-num ty-mi-steps" step="1" min="1" max="256" title="宽高对齐到该数字的整数倍">
      </div>
      <div class="ty-mi-line">
        <select class="ty-mi-sel ty-mi-method" title="缩放插值算法"></select>
        <select class="ty-mi-sel ty-mi-mode" title="自动连线目标"></select>
        <button type="button" class="ty-mi-btn pri ty-mi-add">添加</button>
      </div>
    </div>`;

  const el = {
    root,
    title: root.querySelector(".ty-mi-title"),
    link: root.querySelector(".ty-mi-link"),
    auto: root.querySelector(".ty-mi-auto"),
    autoTxt: root.querySelector(".ty-mi-auto-txt"),
    clear: root.querySelector(".ty-mi-clear"),
    grid: root.querySelector(".ty-mi-grid"),
    mp: root.querySelector(".ty-mi-mp"),
    steps: root.querySelector(".ty-mi-steps"),
    method: root.querySelector(".ty-mi-method"),
    mode: root.querySelector(".ty-mi-mode"),
    add: root.querySelector(".ty-mi-add"),
  };

  for (const m of UPSCALE_METHODS) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    el.method.appendChild(o);
  }
  for (let i = 0; i < MODE_OPTIONS.length; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = MODE_OPTIONS[i];
    el.mode.appendChild(o);
  }

  // 面板里的点击 / 滚轮不能漏给画布，否则会拖动节点或缩放画布
  const swallow = (e) => e.stopPropagation();
  for (const t of [root.querySelector(".ty-mi-top"), root.querySelector(".ty-mi-ctrl")]) {
    t.addEventListener("pointerdown", swallow);
    t.addEventListener("wheel", swallow, { passive: true });
  }
  // 网格的单元格自己要处理 pointerdown（拖拽），这里只挡滚轮
  el.grid.addEventListener("wheel", swallow, { passive: true });

  /* ------------------------------------------------ 文件选择 / 上传 */

  const pickFiles = () => {
    const files = getImageFiles(node);
    if (files.length >= MAX_IMAGES) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
      const picked = Array.from(input.files || []);
      if (!picked.length) return;
      const uploaded = [];
      for (const f of picked) {
        try {
          uploaded.push(await uploadOne(f));
        } catch (err) {
          console.error("[TaiYangMultiImage] 上传失败:", f.name, err);
        }
      }
      if (!uploaded.length) return;
      const next = getImageFiles(node).concat(uploaded).slice(0, MAX_IMAGES);
      setImages(node, next);
      syncConnections(node);
      refresh(node, true);
    };
    input.click();
  };

  /** 把上传好的文件名插到指定位置（外部文件拖进来时用） */
  const insertAt = async (at, files) => {
    const uploaded = [];
    for (const f of files) {
      if (!/^image\//i.test(f.type) && !/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f.name)) continue;
      try {
        uploaded.push(await uploadOne(f));
      } catch (err) {
        console.error("[TaiYangMultiImage] 上传失败:", f.name, err);
      }
    }
    if (!uploaded.length) return;
    const list = getImageFiles(node).slice();
    const pos = Math.max(0, Math.min(at, list.length));
    list.splice(pos, 0, ...uploaded);
    setImages(node, list.slice(0, MAX_IMAGES));
    syncConnections(node);
    refresh(node, true);
  };

  el.add.addEventListener("click", () => {
    if (getImageFiles(node).length >= MAX_IMAGES) return;
    pickFiles();
  });

  // 顶部开关：关闭 = 断开本节点已连出去的线，之后只有手动拉线；
  // 再点一下 = 恢复自动连线，按当前图片重新接一遍。
  el.auto.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAutoLink(node);
    refresh(node, false);
    // 连线数变了，签名立刻对齐，免得轮询下一拍又触发一次重建
    node.__tyMiSig = signature(node);
  });
  el.clear.addEventListener("click", () => {
    if (!getImageFiles(node).length) return;
    setImages(node, []);
    syncConnections(node);
    refresh(node, true);
  });

  /* ------------------------------------------------ 网格 */

  let dragFrom = -1;

  const cellAt = (e) => {
    const c = e.target?.closest?.(".ty-mi-cell");
    if (!c) return -1;
    const i = Number(c.dataset.i);
    return Number.isFinite(i) ? i : -1;
  };

  el.grid.addEventListener("pointerdown", (e) => e.stopPropagation());

  el.grid.addEventListener("dragstart", (e) => {
    const i = cellAt(e);
    const files = getImageFiles(node);
    if (i < 0 || i >= files.length) {
      e.preventDefault();
      return;
    }
    dragFrom = i;
    e.dataTransfer.setData("text/plain", String(i));
    e.dataTransfer.effectAllowed = "move";
    e.target.classList.add("dragging");
  });

  el.grid.addEventListener("dragend", (e) => {
    dragFrom = -1;
    for (const c of el.grid.querySelectorAll(".dragging, .over")) {
      c.classList.remove("dragging", "over");
    }
  });

  el.grid.addEventListener("dragover", (e) => {
    e.preventDefault();
    const cell = e.target?.closest?.(".ty-mi-cell");
    for (const c of el.grid.querySelectorAll(".over")) c.classList.remove("over");
    if (cell && !cell.classList.contains("empty")) cell.classList.add("over");
    e.dataTransfer.dropEffect = "move";
  });

  el.grid.addEventListener("dragleave", (e) => {
    const cell = e.target?.closest?.(".ty-mi-cell");
    if (cell) cell.classList.remove("over");
  });

  el.grid.addEventListener("drop", async (e) => {
    e.preventDefault();
    for (const c of el.grid.querySelectorAll(".over, .dragging")) c.classList.remove("over", "dragging");

    // ① 从资源管理器拖进来的文件：上传后插到落点
    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length) {
      const at = Math.max(0, Math.min(cellAt(e), getImageFiles(node).length));
      await insertAt(at, Array.from(dropped));
      return;
    }

    // ② 节点内部拖动：调整顺序
    const files = getImageFiles(node);
    const from = dragFrom >= 0 ? dragFrom : Number(e.dataTransfer?.getData("text/plain"));
    const to = cellAt(e);
    dragFrom = -1;
    if (!Number.isFinite(from) || from < 0 || from >= files.length) return;
    if (to < 0 || to >= files.length || to === from) return;
    setImages(node, reorderList(files, from, to));
    syncConnections(node);         // 顺序变了，下游 image_N 要跟着换
    refresh(node, true);
  });

  el.grid.addEventListener("click", (e) => {
    const i = cellAt(e);
    const files = getImageFiles(node);
    if (i < 0) return;

    // 删除按钮
    if (e.target?.classList?.contains("ty-mi-del")) {
      e.stopPropagation();
      const next = files.slice();
      next.splice(i, 1);
      setImages(node, next);
      syncConnections(node);
      refresh(node, true);
      return;
    }
    // 加号格
    if (i === files.length) pickFiles();
  });

  el.grid.addEventListener("dblclick", (e) => {
    const i = cellAt(e);
    const files = getImageFiles(node);
    if (i < 0 || i >= files.length) return;
    window.open(viewUrl(files[i]), "_blank");
  });

  /* ------------------------------------------------ 参数控件 */

  el.mp.addEventListener("change", () => {
    const v = Number(el.mp.value);
    setMegapixels(node, Number.isFinite(v) ? Math.max(0, Math.min(16, v)) : 0);
    refresh(node, false);
  });
  el.steps.addEventListener("change", () => {
    const v = Number(el.steps.value);
    setResolutionSteps(node, Number.isFinite(v) ? Math.max(1, Math.min(256, Math.round(v))) : DEFAULT_STEPS);
    refresh(node, false);
  });
  el.method.addEventListener("change", () => {
    setUpscaleMethod(node, el.method.value);
  });
  el.mode.addEventListener("change", () => {
    // 手动指定过目标就清掉，改回自动发现（和原来点模式条的行为一致）
    if (node._qwenManualTarget) {
      node._qwenManualTarget = null;
      if (node.properties) delete node.properties.auto_link_target;
    }
    const w = getWidget(node, "auto_link");
    // 写**字符串**：后端是 combo，收索引会校验失败
    const idx = Number(el.mode.value);
    if (w) w.value = MODE_OPTIONS[idx] ?? MODE_OPTIONS[0];
    // 下拉选「关闭」和点顶部开关是一个意思：已连的线断干净，改手动
    if (idx === MODE_OFF) disconnectAllOutputs(node);
    else syncConnections(node);
    refresh(node, false);
  });

  node.__tyMiEl = el;
  return el;
}

/* ------------------------------------------------------------ 刷新 */

/** 重建网格与状态文字。full=false 只更新文字和控件，不重建 DOM（避免拖拽中被打断） */
function refresh(node, full = true) {
  const el = node.__tyMiEl;
  if (!el) return;
  const files = getImageFiles(node);
  const linked = linkedCount(node);
  const off = getMode(node) === MODE_OFF;

  el.title.textContent = `参考图 ${files.length}/${MAX_IMAGES}`;
  if (off) {
    // 关掉自动连线以后就别再报「还有 N 张未连接」了 —— 那是自动连线的口径，
    // 手动连线时本来就轮不到它管，报出来只会让人以为出了错。
    el.link.textContent = files.length === 0
      ? "自动连线已关闭 · 先加图片"
      : "自动连线已关闭 · 请手动拉线";
    el.link.className = "ty-mi-link";
  } else {
    el.link.textContent = files.length === 0
      ? "还没有图片，点「添加」或把图片拖进来"
      : linked >= files.length
        ? `✓ 已连接${node._qwenManualTarget ? " " + node._qwenManualTarget : ""}`
        : `还有 ${files.length - linked} 张未连接`;
    el.link.className = "ty-mi-link"
      + (files.length === 0 ? "" : linked >= files.length ? " ok" : " warn");
  }

  // 开关文案与配色跟着状态走；初始（auto_link=自动）就是「关闭自动连线」
  if (el.autoTxt) el.autoTxt.textContent = off ? "开启自动连线" : "关闭自动连线";
  el.auto?.classList.toggle("off", off);
  if (el.auto) {
    el.auto.title = off
      ? "点一下恢复自动连线，按当前图片接回下游"
      : "关闭后本节点不再自动连线，已连的线会断开，改由手动拉线";
  }

  if (full) {
    const slots = Math.min(MAX_IMAGES, Math.max(COLS, Math.ceil((files.length + 1) / COLS) * COLS));
    el.grid.textContent = "";
    for (let i = 0; i < slots; i++) {
      const cell = document.createElement("div");
      cell.className = "ty-mi-cell";
      cell.dataset.i = String(i);

      if (i < files.length) {
        cell.classList.add("has");
        cell.draggable = true;
        cell.title = `${files[i]}\n拖动可调顺序，双击看大图`;
        const img = document.createElement("img");
        img.src = viewUrl(files[i]);
        img.alt = files[i];
        img.draggable = false;
        const idx = document.createElement("span");
        idx.className = "ty-mi-idx";
        idx.textContent = String(i + 1);
        const size = document.createElement("span");
        size.className = "ty-mi-size";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "ty-mi-del";
        del.textContent = "×";
        del.title = "移除这张";
        // 图片尺寸只有加载完才知道；拿到就把「实际送入尺寸」标上去
        img.addEventListener("load", () => updateSizes(node));
        cell.append(img, idx, size, del);
      } else if (i === files.length) {
        cell.classList.add("add");
        if (files.length >= MAX_IMAGES) {
          cell.classList.add("off");
          cell.textContent = "满";
          cell.title = `最多 ${MAX_IMAGES} 张`;
        } else {
          cell.textContent = "＋";
          cell.title = "添加图片（可多选）";
        }
      } else {
        cell.classList.add("empty");
      }
      el.grid.appendChild(cell);
    }
    fitNode(node);
  }

  // 控件值回填（用户正在输入的时候不要抢）
  const mp = getMegapixels(node);
  if (document.activeElement !== el.mp) el.mp.value = mp > 0 ? String(mp) : "0";
  const steps = getResolutionSteps(node);
  if (document.activeElement !== el.steps) el.steps.value = String(steps);
  el.method.value = getUpscaleMethod(node);
  el.mode.value = String(getMode(node));
  el.add.disabled = files.length >= MAX_IMAGES;
  updateSizes(node);
}

/** 每张图下方标「实际送进模型的分辨率」，随缩放/对齐参数一起变 */
function updateSizes(node) {
  const el = node.__tyMiEl;
  if (!el) return;
  const mp = getMegapixels(node);
  const steps = getResolutionSteps(node);
  for (const cell of el.grid.querySelectorAll(".ty-mi-cell.has")) {
    const img = cell.querySelector("img");
    const tag = cell.querySelector(".ty-mi-size");
    if (!img || !tag) continue;
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) continue;      // 还没加载完，等 load 事件再来
    const [w, h] = scaledSize(w0, h0, mp, steps);
    tag.textContent = `${w} × ${h}`;
  }
}

/** 轮询签名：图片列表 / 连线数 / 手动目标 / 参数任一变就刷新 */
function signature(node) {
  return JSON.stringify([
    getImageFiles(node),
    linkedCount(node),
    node._qwenManualTarget || "",
    getMegapixels(node),
    getResolutionSteps(node),
    getUpscaleMethod(node),
    getMode(node),
    MAX_IMAGES,
  ]);
}

function watch(node) {
  if (node.__tyMiTimer) clearInterval(node.__tyMiTimer);
  node.__tyMiSig = signature(node);
  node.__tyMiFiles = JSON.stringify(getImageFiles(node));
  node.__tyMiTimer = setInterval(() => {
    // 节点被删 / 面板已拆：自己收工，别留着空转
    if (!node.__tyMiEl) {
      clearInterval(node.__tyMiTimer);
      node.__tyMiTimer = 0;
      return;
    }
    const sig = signature(node);
    if (sig === node.__tyMiSig) return;
    node.__tyMiSig = sig;

    // 只有图片列表变了才重建网格；改参数只更新文字和控件，免得打断输入
    const filesSig = JSON.stringify(getImageFiles(node));
    const layoutChanged = filesSig !== node.__tyMiFiles;
    node.__tyMiFiles = filesSig;
    refresh(node, layoutChanged);
  }, POLL_MS);
}

app.registerExtension({
  name: "TaiYang.MultiImage.DomPanel",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    // 这个钩子必须排在 multi_image.js 的 onNodeCreated 之后：
    // 那个文件先被 import，包装时自然在内层，先跑业务初始化，再建面板。
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated?.apply(this, arguments);
      const node = this;

      // 同步先打标记：同一帧里 if 尺寸钳制 / 自绘判定都会读它，
      // 不能等到下一帧才置位，否则首帧会先把节点拽成自绘那套尺寸
      node.__tyDomPanel = true;

      // 面板放到下一轮再建：ComfyUI 加载 js 的顺序不保证，
      // 万一本文件先于 multi_image.js 包装，同步建面板就会读到还没初始化的节点
      setTimeout(() => {
        if (node.__tyMiEl) return;
        try {
          const el = build(node);
          node.addDOMWidget("multi_image_panel", "TY_MULTI_IMAGE", el.root, {
            serialize: false,
            hideOnZoom: false,
            getHeight: () => panelHeight(getImageFiles(node).length),
            getMinHeight: () => panelHeight(0),
            getMaxHeight: () => panelHeight(MAX_IMAGES),
          });
          refresh(node, true);
          watch(node);
        } catch (e) {
          // 建面板失败就把节点还给自绘，至少不是一块空白
          node.__tyDomPanel = false;
          console.error("[TaiYangMultiImage] DOM 面板创建失败", e);
        }
      }, 0);

      return r;
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure?.apply(this, arguments);
      const node = this;
      requestAnimationFrame(() => {
        if (!node.__tyMiEl) return;
        refresh(node, true);
        node.__tyMiSig = signature(node);
      });
      return r;
    };

    const origRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this.__tyMiTimer) clearInterval(this.__tyMiTimer);
      this.__tyMiTimer = 0;
      this.__tyMiEl = null;
      return origRemoved?.apply(this, arguments);
    };
  },
});

// 导出给测试用（ComfyUI 加载这个模块时会忽略多余导出）
export { build, refresh, panelHeight, signature, watch, viewUrl, linkedCount, fitNode };
