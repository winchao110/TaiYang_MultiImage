/**
 * 多音频参考节点（TaiYangMultiAudioLoader）的 DOM 面板。
 *
 * 原实现整套界面画在 canvas 上（onDrawForeground），ComfyUI Node 2.0（Vue 节点）
 * 不画画布，于是节点只剩一块空白。这里改用真实 DOM（addDOMWidget），
 * 两种渲染模式都能显示。
 *
 * 分工：
 *   - 自动连线、输出槽、裁剪区间、试听、解码、波形算法全在 multi_audio.js 里，import 复用。
 *   - 本文件只管画（行内 canvas 画波形 / 裁剪线 / 播放头）和收输入。
 *   - multi_audio.js 里所有画布交互都会因 node.__tyDomPanel 为 true 而跳过。
 */

import { app } from "../../scripts/app.js";
import {
  MAX_AUDIOS,
  MODE_OPTIONS,
  LONG_REF_AUDIO_SEC,
  getWidget,
  getAudioFiles,
  setAudios,
  getMode,
  uploadOne,
  durOf,
  exactDurOf,
  getAudioBuffer,
  togglePreview,
  stopPreview,
  previewPosition,
  waveformPeaks,
  trimAt,
  setTrim,
  syncConnections,
  reorderList,
} from "./multi_audio.js";

const NODE_NAME = "TaiYangMultiAudioLoader";

const MIN_NODE_W = 460;
const HEAD_H = 20;
const WAVE_H = 46;             // 波形 36 + 刻度带 10
const ROW_PAD = 4;
const ROW_GAP = 8;
const TOP_H = 24;
const CTRL_H = 24;
const PAD = 12;
const VGAP = 8;
const ROW_H = HEAD_H + WAVE_H + ROW_PAD * 2;
const HIT = 7;                 // 竖线命中半径（px）

const STYLE_ID = "ty-ma-style";
const POLL_MS = 600;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.ty-ma {
  display: flex; flex-direction: column; gap: ${VGAP}px;
  width: 100%; height: 100%; box-sizing: border-box; padding: 6px;
  border-radius: 8px; background: #17181c;
  box-shadow: inset 0 0 0 1px #2c2e36;
  user-select: none; -webkit-user-select: none; font-family: inherit;
}
.ty-ma-top { display: flex; align-items: center; gap: 8px; height: ${TOP_H}px; flex: 0 0 ${TOP_H}px; }
.ty-ma-title { font-size: 12px; font-weight: 600; color: #8fd0ff; letter-spacing: .2px; }
.ty-ma-link { font-size: 11.5px; color: #9aa0ab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ty-ma-link.ok { color: #8fe08f; }
.ty-ma-link.warn { color: #ffd479; }
.ty-ma-spacer { flex: 1 1 auto; min-width: 0; }

.ty-ma-list { display: flex; flex-direction: column; gap: ${ROW_GAP}px; flex: 0 0 auto; }
.ty-ma-row {
  position: relative; box-sizing: border-box; height: ${ROW_H}px; padding: ${ROW_PAD}px 6px;
  border-radius: 6px; background: #1a1f27; box-shadow: inset 0 0 0 1px #3a5f80;
  display: flex; flex-direction: column; gap: 2px;
}
.ty-ma-row.dragging { opacity: .4; }
.ty-ma-row.over { box-shadow: inset 0 0 0 2px #8fd0ff; }
.ty-ma-row.playing { box-shadow: inset 0 0 0 1px #d9a63c; }
.ty-ma-head { display: flex; align-items: center; gap: 6px; height: ${HEAD_H}px; }
.ty-ma-grip {
  cursor: grab; color: #5d6673; font-size: 11px; letter-spacing: -1px;
  padding: 0 1px; flex: 0 0 auto;
}
.ty-ma-grip:active { cursor: grabbing; }
.ty-ma-no {
  flex: 0 0 auto; min-width: 16px; text-align: center;
  font-size: 10.5px; line-height: 14px; color: #9fb4c8;
  background: rgba(255,255,255,.06); border-radius: 4px; padding: 0 4px;
}
.ty-ma-name {
  flex: 1 1 auto; min-width: 0; font-size: 11px; color: #cfd8e3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ty-ma-dur { flex: 0 0 auto; font-size: 10.5px; color: #7d8794; font-variant-numeric: tabular-nums; }
.ty-ma-trim { flex: 0 0 auto; font-size: 10.5px; color: #8fe08f; font-variant-numeric: tabular-nums; }
.ty-ma-warn { flex: 0 0 auto; font-size: 10.5px; color: #ffb454; cursor: help; }
.ty-ma-ico {
  flex: 0 0 auto; width: 20px; height: 18px; padding: 0; cursor: pointer;
  border: none; border-radius: 4px; font-size: 11px; line-height: 18px; text-align: center;
  background: rgba(255,255,255,.07); color: #dfe2e8;
}
.ty-ma-ico:hover { background: rgba(255,255,255,.16); }
.ty-ma-ico.del:hover { background: #a33; color: #fff; }
.ty-ma-cv { display: block; width: 100%; height: ${WAVE_H}px; border-radius: 4px; cursor: pointer; touch-action: none; }
.ty-ma-row.addrow {
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; height: 30px; gap: 6px;
  background: #141519; box-shadow: inset 0 0 0 1px #30333b; color: #6a727e; font-size: 12px;
}
.ty-ma-row.addrow:hover { background: #17202a; color: #8fd0ff; box-shadow: inset 0 0 0 1px #3f6f95; }
.ty-ma-row.addrow.off { cursor: not-allowed; opacity: .45; }

.ty-ma-ctrl { display: flex; align-items: center; gap: 6px; height: ${CTRL_H}px; flex: 0 0 ${CTRL_H}px; }
.ty-ma-sel {
  flex: 1 1 auto; min-width: 0; height: 24px; padding: 0 4px;
  border-radius: 4px; background: #23252c; color: #dfe2e8;
  font-size: 11px; font-family: inherit; border: 1px solid #34373f;
  outline: none; cursor: pointer;
}
.ty-ma-sel:hover { border-color: #4a4e59; }
.ty-ma-btn {
  flex: 0 0 auto; height: 24px; padding: 0 8px; box-sizing: border-box;
  border-radius: 4px; cursor: pointer; white-space: nowrap;
  font-size: 11px; font-family: inherit; line-height: 1;
  background: #262931; color: #cfd3db; border: 1px solid #353941;
}
.ty-ma-btn:hover { background: #2e323b; border-color: #454a55; color: #fff; }
.ty-ma-btn:active { transform: translateY(1px); }
.ty-ma-btn.pri { border-color: #35506a; color: #b9ddf6; }
.ty-ma-btn.pri:hover { border-color: #3f6f95; background: #1d2a36; color: #d7ecff; }
.ty-ma-btn.danger:hover { border-color: #7a3d47; color: #f2c3c9; }
`;
  document.head.appendChild(s);
}

function fmtSec(v) {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 60) {
    const m = Math.floor(v / 60);
    const s = v - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
  }
  return `${v.toFixed(1)}s`;
}

function panelHeight(count) {
  const rows = count + 1;                    // 每条音频 + 一个「添加」条
  const listH = count > 0 ? count * ROW_H + (count - 1) * ROW_GAP + ROW_GAP : 0;
  return PAD + TOP_H + VGAP + listH + 30 + VGAP + CTRL_H;
}

function linkedCount(node) {
  let n = 0;
  for (const out of node.outputs || []) {
    if ((out.links || []).length) n++;
  }
  return n;
}

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

/* ------------------------------------------------------------ 单行绘制 */

function paintRow(row, node, index) {
  if (!row) return;
  const cv = row.cv;
  if (!cv) return;
  const name = getAudioFiles(node)[index];
  if (!name) return;

  const w = Math.max(80, Math.round(cv.clientWidth || row.root.clientWidth || 300));
  const h = WAVE_H;
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(w * dpr);
  const pxH = Math.round(h * dpr);
  if (cv.width !== pxW || cv.height !== pxH) {
    cv.width = pxW;
    cv.height = pxH;
  }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 底板
  ctx.fillStyle = "#0d1014";
  ctx.beginPath();
  ctx.roundRect?.(0, 0, w, h, 4);
  if (!ctx.roundRect) ctx.rect(0, 0, w, h);
  ctx.fill();

  const tr = trimAt(node, index);
  const dur = exactDurOf(node, name);
  const info = node._bufs?.[name];

  // 底部留一条刻度带：没有刻度就没法对齐裁剪位置
  const RULER_H = 10;
  const waveH = h - RULER_H;

  // 波形
  if (info?.buffer) {
    // 峰值是按宽度算的，播放头动画每帧都重画 —— 这里必须缓存，
    // 否则每帧都要遍历整段采样（几百万点），音频一播就卡
    const key = `${name}|${Math.round(w)}|${waveH}`;
    if (row.peaksKey !== key) {
      row.peaks = waveformPeaks(info.buffer, Math.max(1, Math.round(w)));
      row.peaksKey = key;
    }
    const peaks = row.peaks;
    const mid = waveH / 2;
    const half = waveH / 2 - 2;
    ctx.strokeStyle = "rgba(150,200,240,.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = peaks.length;
    for (let i = 0; i < n; i++) {
      const x = Math.floor((i / Math.max(1, n)) * w) + 0.5;
      const v = Math.max(0.5, peaks[i] * half);
      ctx.moveTo(x, mid - v);
      ctx.lineTo(x, mid + v);
    }
    ctx.stroke();
  }

  // 刻度带（先画，竖线和播放头会盖在上面）
  ctx.fillStyle = "rgba(255,255,255,.03)";
  ctx.fillRect(0, waveH, w, RULER_H);
  if (dur > 0) {
    const step = niceStep(dur);
    // 像素够宽才画秒数，太挤就每两个刻度标一次
    const pxPer = (step / dur) * w;
    const every = pxPer < 24 ? 2 : 1;
    ctx.font = "8px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let k = 0;
    for (let t = 0; t <= dur + 1e-6; t += step, k++) {
      const x = Math.round((t / dur) * w) + 0.5;
      ctx.strokeStyle = "rgba(255,255,255,.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, waveH);
      ctx.lineTo(x, waveH + 3);
      ctx.stroke();
      if (k % every === 0) {
        ctx.fillStyle = "rgba(180,195,210,.55)";
        ctx.fillText(`${Math.round(t)}s`, Math.min(x + 1, w - 12), waveH + 2);
      }
    }
  }

  if (dur > 0) {
    const sx = Math.min(w, Math.max(0, (tr.s / dur) * w));
    const ex = tr.e != null ? Math.min(w, Math.max(0, (tr.e / dur) * w)) : w;

    // 区间外压暗
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(0, 0, sx, waveH);
    ctx.fillRect(ex, 0, Math.max(0, w - ex), waveH);
    // 选中区间底色
    ctx.fillStyle = "rgba(143,224,143,.12)";
    ctx.fillRect(sx, 0, Math.max(0, ex - sx), waveH);

    // 起点线（绿，上端三角）
    ctx.strokeStyle = "#8fe08f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, waveH);
    ctx.stroke();
    ctx.fillStyle = "#8fe08f";
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx - 5, 7);
    ctx.lineTo(sx + 5, 7);
    ctx.closePath();
    ctx.fill();

    // 终点线（蓝，下端三角）
    ctx.strokeStyle = "#8fd0ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ex, 0);
    ctx.lineTo(ex, waveH);
    ctx.stroke();
    ctx.fillStyle = "#8fd0ff";
    ctx.beginPath();
    ctx.moveTo(ex, waveH);
    ctx.lineTo(ex - 5, waveH - 7);
    ctx.lineTo(ex + 5, waveH - 7);
    ctx.closePath();
    ctx.fill();
  }

  // 播放头
  const pos = previewPosition();
  if (node._playingIndex === index && pos != null && dur > 0) {
    const px = Math.min(w, Math.max(0, (pos / dur) * w));
    ctx.strokeStyle = "#ffd479";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, waveH);
    ctx.stroke();
  }
}

/** 刻度间隔：让整段音频落 4~10 条刻度 */
function niceStep(dur) {
  if (dur <= 2) return 0.5;
  if (dur <= 5) return 1;
  if (dur <= 12) return 2;
  if (dur <= 30) return 5;
  if (dur <= 90) return 10;
  return Math.max(10, Math.round(dur / 8 / 10) * 10);
}

function paintAll(node) {
  const el = node.__tyMaEl;
  if (!el) return;
  for (const row of el.rows) paintRow(row, node, row.index);
}

/** 播放头动画：只在试听中跑，停下就自动退出 */
function tick(node) {
  node.__tyMaRaf = 0;
  const el = node.__tyMaEl;
  if (!el) return;
  const i = node._playingIndex;
  if (i == null) {
    paintAll(node);
    return;
  }
  const row = el.rows.find((r) => r.index === i);
  if (row) paintRow(row, node, i);
  node.__tyMaRaf = requestAnimationFrame(() => tick(node));
}

function startTick(node) {
  if (node.__tyMaRaf) return;
  node.__tyMaRaf = requestAnimationFrame(() => tick(node));
}

/* ------------------------------------------------------------ 面板 */

function build(node) {
  ensureStyle();

  const root = document.createElement("div");
  root.className = "ty-ma";
  root.innerHTML = `
    <div class="ty-ma-top">
      <span class="ty-ma-title">参考音频</span>
      <span class="ty-ma-link"></span>
      <span class="ty-ma-spacer"></span>
      <button type="button" class="ty-ma-btn danger ty-ma-clear">清空</button>
    </div>
    <div class="ty-ma-list"></div>
    <div class="ty-ma-ctrl">
      <select class="ty-ma-sel ty-ma-mode" title="自动连线目标"></select>
    </div>`;

  const el = {
    root,
    title: root.querySelector(".ty-ma-title"),
    link: root.querySelector(".ty-ma-link"),
    clear: root.querySelector(".ty-ma-clear"),
    list: root.querySelector(".ty-ma-list"),
    mode: root.querySelector(".ty-ma-mode"),
    rows: [],
  };

  for (let i = 0; i < MODE_OPTIONS.length; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = MODE_OPTIONS[i];
    el.mode.appendChild(o);
  }

  const swallow = (e) => e.stopPropagation();
  for (const t of [root.querySelector(".ty-ma-top"), root.querySelector(".ty-ma-ctrl")]) {
    t.addEventListener("pointerdown", swallow);
    t.addEventListener("wheel", swallow, { passive: true });
  }
  el.list.addEventListener("wheel", swallow, { passive: true });

  /* ---------------- 上传 / 清空 */

  const pickFiles = () => {
    const files = getAudioFiles(node);
    if (files.length >= MAX_AUDIOS) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.multiple = true;
    input.onchange = async () => {
      const picked = Array.from(input.files || []);
      if (!picked.length) return;
      const uploaded = [];
      for (const f of picked) {
        try {
          uploaded.push(await uploadOne(f));
        } catch (err) {
          console.error("[TaiYangMultiAudio] 上传失败:", f.name, err);
        }
      }
      if (!uploaded.length) return;
      setAudios(node, getAudioFiles(node).concat(uploaded).slice(0, MAX_AUDIOS));
      syncConnections(node);
      refresh(node, true);
    };
    input.click();
  };

  const insertAt = async (at, files) => {
    const uploaded = [];
    for (const f of files) {
      if (!/^audio\//i.test(f.type) && !/\.(wav|mp3|flac|ogg|m4a|aac|opus|webm)$/i.test(f.name)) continue;
      try {
        uploaded.push(await uploadOne(f));
      } catch (err) {
        console.error("[TaiYangMultiAudio] 上传失败:", f.name, err);
      }
    }
    if (!uploaded.length) return;
    const list = getAudioFiles(node).slice();
    list.splice(Math.max(0, Math.min(at, list.length)), 0, ...uploaded);
    setAudios(node, list.slice(0, MAX_AUDIOS));
    syncConnections(node);
    refresh(node, true);
  };

  el.clear.addEventListener("click", () => {
    if (!getAudioFiles(node).length) return;
    stopPreview();
    setAudios(node, []);
    syncConnections(node);
    refresh(node, true);
  });

  el.mode.addEventListener("change", () => {
    if (node._audioManualTarget) {
      node._audioManualTarget = null;
      if (node.properties) delete node.properties.auto_link_target;
    }
    const w = getWidget(node, "auto_link");
    // 写**字符串**：后端是 combo，收索引会校验失败
    if (w) w.value = MODE_OPTIONS[Number(el.mode.value)] ?? MODE_OPTIONS[0];
    syncConnections(node);
    refresh(node, false);
  });

  /* ---------------- 行交互（事件委托到 list） */

  let dragFrom = -1;
  let dragTrim = null;      // { index, which, dur }

  const rowOf = (e) => e.target?.closest?.(".ty-ma-row");
  const indexOf = (e) => {
    const r = rowOf(e);
    if (!r || r.dataset.i == null) return -1;
    const i = Number(r.dataset.i);
    return Number.isFinite(i) ? i : -1;
  };

  el.list.addEventListener("click", (e) => {
    const t = e.target;
    if (t?.classList?.contains("ty-ma-del")) {
      const i = indexOf(e);
      const files = getAudioFiles(node);
      if (i < 0 || i >= files.length) return;
      const next = files.slice();
      next.splice(i, 1);
      stopPreview();
      setAudios(node, next);
      syncConnections(node);
      refresh(node, true);
      return;
    }
    if (t?.classList?.contains("ty-ma-play")) {
      const i = indexOf(e);
      const files = getAudioFiles(node);
      if (i < 0 || i >= files.length) return;
      if (node._playingIndex === i) {
        stopPreview();
      } else {
        togglePreview(node, i, files[i]);
        startTick(node);
      }
      refresh(node, false);
      return;
    }
    const r = rowOf(e);
    if (r?.classList?.contains("addrow")) {
      if (getAudioFiles(node).length < MAX_AUDIOS) pickFiles();
    }
  });

  // 波形区：点一下试听；拖竖线改裁剪区间
  const onPointerDown = (e) => {
    const cv = e.target;
    if (!cv?.classList?.contains("ty-ma-cv")) return;
    const i = indexOf(e);
    const files = getAudioFiles(node);
    if (i < 0 || i >= files.length) return;
    const dur = exactDurOf(node, files[i]);
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width || 1;

    if (dur > 0) {
      const tr = trimAt(node, i);
      const sx = (tr.s / dur) * w;
      const ex = tr.e != null ? (tr.e / dur) * w : w;
      // 终点线优先：两条线重合时先给终点，否则永远拖不到
      if (Math.abs(x - ex) <= HIT) {
        dragTrim = { index: i, which: "e", dur };
        cv.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
      if (Math.abs(x - sx) <= HIT) {
        dragTrim = { index: i, which: "s", dur };
        cv.setPointerCapture?.(e.pointerId);
        if (node._playingIndex === i) stopPreview();   // 改起点就停播，免得听着错位
        e.preventDefault();
        return;
      }
    }

    // 点空白：试听开关
    if (node._playingIndex === i) stopPreview();
    else {
      togglePreview(node, i, files[i]);
      startTick(node);
    }
    refresh(node, false);
    e.preventDefault();
  };

  el.list.addEventListener("pointerdown", (e) => {
    if (e.target?.classList?.contains("ty-ma-cv") || e.target?.closest?.(".ty-ma-row")) {
      e.stopPropagation();          // 别让画布把点击当成拖节点
    }
    onPointerDown(e);
  });

  el.list.addEventListener("pointermove", (e) => {
    if (!dragTrim) return;
    const cv = e.target;
    if (!cv?.classList?.contains("ty-ma-cv")) return;
    const { index, which, dur } = dragTrim;
    const rect = cv.getBoundingClientRect();
    const w = rect.width || 1;
    const x = Math.max(0, Math.min(w, e.clientX - rect.left));
    const sec = (x / w) * dur;
    const tr = trimAt(node, index);
    if (which === "s") {
      const limit = tr.e != null ? tr.e - 0.01 : dur;
      setTrim(node, index, Math.min(sec, limit), tr.e, dur);
    } else {
      setTrim(node, index, tr.s, Math.max(sec, tr.s + 0.01), dur);
    }
    paintRow(el.rows.find((r) => r.index === index), node, index);
    refresh(node, false);
  });

  const endTrim = () => {
    if (!dragTrim) return;
    dragTrim = null;
    refresh(node, false);
  };
  el.list.addEventListener("pointerup", endTrim);
  el.list.addEventListener("pointercancel", endTrim);

  // 拖拽排序：只有手柄可拖，避免和波形上的拖动冲突
  el.list.addEventListener("dragstart", (e) => {
    const grip = e.target?.closest?.(".ty-ma-grip");
    if (!grip) {
      e.preventDefault();
      return;
    }
    const i = indexOf(e);
    if (i < 0) {
      e.preventDefault();
      return;
    }
    dragFrom = i;
    e.dataTransfer.setData("text/plain", String(i));
    e.dataTransfer.effectAllowed = "move";
    rowOf(e)?.classList.add("dragging");
  });

  el.list.addEventListener("dragend", () => {
    dragFrom = -1;
    for (const r of el.list.querySelectorAll(".dragging, .over")) r.classList.remove("dragging", "over");
  });

  el.list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const r = rowOf(e);
    for (const x of el.list.querySelectorAll(".over")) x.classList.remove("over");
    if (r && !r.classList.contains("addrow")) r.classList.add("over");
    e.dataTransfer.dropEffect = "move";
  });

  el.list.addEventListener("dragleave", (e) => {
    rowOf(e)?.classList.remove("over");
  });

  el.list.addEventListener("drop", async (e) => {
    e.preventDefault();
    for (const r of el.list.querySelectorAll(".over, .dragging")) r.classList.remove("over", "dragging");

    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length) {
      await insertAt(Math.max(0, Math.min(indexOf(e), getAudioFiles(node).length)), Array.from(dropped));
      return;
    }

    const files = getAudioFiles(node);
    const from = dragFrom >= 0 ? dragFrom : Number(e.dataTransfer?.getData("text/plain"));
    const to = indexOf(e);
    dragFrom = -1;
    if (!Number.isFinite(from) || from < 0 || from >= files.length) return;
    if (to < 0 || to >= files.length || to === from) return;
    stopPreview();
    setAudios(node, reorderList(files, from, to));
    syncConnections(node);        // 顺序变了，下游 audio_N 要跟着换
    refresh(node, true);
  });

  node.__tyMaEl = el;
  return el;
}

/* ------------------------------------------------------------ 刷新 */

function refresh(node, full = true) {
  const el = node.__tyMaEl;
  if (!el) return;
  const files = getAudioFiles(node);
  const linked = linkedCount(node);

  el.title.textContent = `参考音频 ${files.length}/${MAX_AUDIOS}`;
  el.link.textContent = files.length === 0
    ? "还没有音频，点「添加」或把音频拖进来"
    : linked >= files.length
      ? `✓ 已连接${node._audioManualTarget ? " " + node._audioManualTarget : ""}`
      : `还有 ${files.length - linked} 条未连接`;
  el.link.className = "ty-ma-link"
    + (files.length === 0 ? "" : linked >= files.length ? " ok" : " warn");
  if (document.activeElement !== el.mode) el.mode.value = String(getMode(node));

  // 播放状态描边：不重建行，只切 class
  for (const row of el.rows) {
    row.root.classList.toggle("playing", node._playingIndex === row.index);
    const btn = row.play;
    if (btn) btn.textContent = node._playingIndex === row.index ? "■" : "▶";
    if (row.dur) {
      const d = durOf(node, files[row.index]);
      row.dur.textContent = fmtSec(d);
      row.dur.title = d > 0 ? `${d.toFixed(3)} 秒` : "还没解出时长";
    }
    if (row.warn) {
      const d = durOf(node, files[row.index]);
      const long = d > LONG_REF_AUDIO_SEC;
      row.warn.style.display = long ? "" : "none";
      row.warn.title = long
        ? `超过 ${LONG_REF_AUDIO_SEC} 秒，参考音频太长会让音色被稀释，建议裁一段纯人声`
        : "";
    }
    if (row.trim) {
      const tr = trimAt(node, row.index);
      const d = durOf(node, files[row.index]);
      if (tr.s > 0 || tr.e != null) {
        const s = tr.s || 0;
        const e = tr.e != null ? tr.e : d;
        row.trim.textContent = `${s.toFixed(1)}–${e > 0 ? e.toFixed(1) : "?"}s`;
        row.trim.style.display = "";
      } else {
        row.trim.textContent = "";
        row.trim.style.display = "none";
      }
    }
  }

  if (!full) return;

  el.list.textContent = "";
  el.rows = [];

  for (let i = 0; i < files.length; i++) {
    const row = document.createElement("div");
    row.className = "ty-ma-row";
    row.dataset.i = String(i);

    const head = document.createElement("div");
    head.className = "ty-ma-head";

    const grip = document.createElement("span");
    grip.className = "ty-ma-grip";
    grip.textContent = "⋮⋮";
    grip.title = "按住拖动可调顺序";
    grip.draggable = true;

    const no = document.createElement("span");
    no.className = "ty-ma-no";
    no.textContent = String(i + 1);

    const name = document.createElement("span");
    name.className = "ty-ma-name";
    name.textContent = files[i];
    name.title = files[i];

    const dur = document.createElement("span");
    dur.className = "ty-ma-dur";

    const trimTag = document.createElement("span");
    trimTag.className = "ty-ma-trim";
    trimTag.title = "裁剪区间（拖动波形上的绿/蓝竖线可改）";

    const warn = document.createElement("span");
    warn.className = "ty-ma-warn";
    warn.textContent = "⚠";
    warn.style.display = "none";

    const play = document.createElement("button");
    play.type = "button";
    play.className = "ty-ma-ico ty-ma-play";
    play.textContent = "▶";
    play.title = "试听选中的区间";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ty-ma-ico ty-ma-del";
    del.textContent = "×";
    del.title = "移除这条";

    head.append(grip, no, name, dur, trimTag, warn, play, del);

    const cv = document.createElement("canvas");
    cv.className = "ty-ma-cv";
    cv.dataset.i = String(i);
    cv.draggable = false;
    cv.title = "点击试听选中的区间；拖动绿 / 蓝竖线可改起止点";

    row.append(head, cv);
    el.list.appendChild(row);

    const rec = { index: i, root: row, cv, play, dur, warn, trim: trimTag };
    el.rows.push(rec);
    row.draggable = false;

    // 解码完成后才有波形 / 竖线：异步回填
    getAudioBuffer(node, files[i]).then(() => {
      paintRow(rec, node, i);
      refresh(node, false);
    });
  }

  // 添加条
  const add = document.createElement("div");
  add.className = "ty-ma-row addrow";
  if (files.length >= MAX_AUDIOS) {
    add.classList.add("off");
    add.textContent = `已满 ${MAX_AUDIOS} 条`;
  } else {
    add.textContent = "＋ 添加音频";
    add.title = "选择音频文件（可多选）";
  }
  el.list.appendChild(add);

  // 行宽依赖布局，得等一帧才有 clientWidth
  requestAnimationFrame(() => {
    paintAll(node);
    fitNode(node);
  });
  refresh(node, false);
}

function signature(node) {
  return JSON.stringify([
    getAudioFiles(node),
    linkedCount(node),
    node._audioManualTarget || "",
    getMode(node),
    getWidget(node, "trims")?.value || "",
    node._playingIndex ?? -1,
  ]);
}

function watch(node) {
  if (node.__tyMaTimer) clearInterval(node.__tyMaTimer);
  node.__tyMaSig = signature(node);
  node.__tyMaFiles = JSON.stringify(getAudioFiles(node));
  node.__tyMaTimer = setInterval(() => {
    // 节点被删 / 面板已拆：自己收工，别留着空转
    if (!node.__tyMaEl) {
      clearInterval(node.__tyMaTimer);
      node.__tyMaTimer = 0;
      return;
    }
    const sig = signature(node);
    if (sig === node.__tyMaSig) return;
    node.__tyMaSig = sig;
    const filesSig = JSON.stringify(getAudioFiles(node));
    const layoutChanged = filesSig !== node.__tyMaFiles;
    node.__tyMaFiles = filesSig;
    refresh(node, layoutChanged);
    if (layoutChanged) requestAnimationFrame(() => paintAll(node));
  }, POLL_MS);
}

app.registerExtension({
  name: "TaiYang.MultiAudio.DomPanel",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated?.apply(this, arguments);
      const node = this;

      // 同步先打标记（同帧的尺寸钳制 / 自绘判定都要读它）
      node.__tyDomPanel = true;

      // 面板下一轮再建：js 加载顺序不保证，同步建可能读到还没初始化的节点
      setTimeout(() => {
        if (node.__tyMaEl) return;
        try {
          const el = build(node);
          node.addDOMWidget("multi_audio_panel", "TY_MULTI_AUDIO", el.root, {
            serialize: false,
            hideOnZoom: false,
            getHeight: () => panelHeight(getAudioFiles(node).length),
            getMinHeight: () => panelHeight(0),
            getMaxHeight: () => panelHeight(MAX_AUDIOS),
          });
          refresh(node, true);
          watch(node);
        } catch (e) {
          node.__tyDomPanel = false;
          console.error("[TaiYangMultiAudio] DOM 面板创建失败", e);
        }
      }, 0);

      return r;
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure?.apply(this, arguments);
      const node = this;
      requestAnimationFrame(() => {
        if (!node.__tyMaEl) return;
        refresh(node, true);
        node.__tyMaSig = signature(node);
      });
      return r;
    };

    const origRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this.__tyMaTimer) clearInterval(this.__tyMaTimer);
      if (this.__tyMaRaf) cancelAnimationFrame(this.__tyMaRaf);
      this.__tyMaTimer = 0;
      this.__tyMaRaf = 0;
      this.__tyMaEl = null;
      return origRemoved?.apply(this, arguments);
    };
  },
});

export { build, refresh, panelHeight, signature, watch, paintRow, paintAll, fmtSec };
