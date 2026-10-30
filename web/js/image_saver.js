/**
 * 图片保存 / 载入 —— TaiYangImageSaver 的前端面板。
 *
 * 一个预览区，没有第二块：
 *   · 接上游跑一次 -> 图存下来，预览区显示第一张新存的
 *   · 「载入图片」/ 把文件拖进来 -> 从本地挑图放进节点（存到 input/TaiYang）
 *   · 「移除」-> 把当前这张从节点里拿掉（硬盘上的文件不动）
 *   · ◀ ▶ -> 多张之间翻；节点里的图会作为 IMAGE 输出给下游
 *   · 「返回」-> 切到九宫格，一次看完所有图；点某一格回到大图
 *   · 「全景查看」-> 当 360 全景环视，拖动看四周、滚轮缩放，能一键截图存盘（截图固定 4:3）
 *
 * 图的顺序 = 先来的在前、后加的在后（载入的、上游存的、全景截的都往后排）。
 *
 * 明确不做：放大预览、加入素材库、2x2 / 3x3。
 */

import { app } from "../../scripts/app.js";

const NODE_NAME = "TaiYangImageSaver";
const API = "/api";
const STYLE_ID = "ty-saver-style";
const LIST_WIDGET = "图片清单";
const UPLOAD_SUBFOLDER = "TaiYang";

// 初始尺寸：宽比高大约 5:4，图区正好是 2:1，全景图铺满不留边
const NODE_W = 500;
const NODE_H = 400;
// 标题 + 两个控件 + 一个输出槽占掉的高度，剩下的全给图区
const CHROME_H = 116;

// 全景截图的输出尺寸：固定 4:3，不受节点被拉成什么形状影响
const SHOT_W = 1600;
const SHOT_H = 1200;

const MAX_IMAGES = 200;

/* ------------------------------------------------------------------ 样式 */

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.ty-sv { display:flex; flex-direction:column; width:100%; height:100%; box-sizing:border-box;
         padding:6px; gap:6px; background:#17181c; border-radius:8px;
         box-shadow: inset 0 0 0 1px #2c2e36; user-select:none; -webkit-user-select:none;
         font-family:inherit; }
.ty-sv-bar { display:flex; align-items:center; gap:5px; height:24px; flex:0 0 24px; }
.ty-sv-btn { height:22px; padding:0 8px; border-radius:5px; border:1px solid #3a5f80;
             background:#1d2530; color:#8fd0ff; font-size:11.5px; font-family:inherit;
             cursor:pointer; white-space:nowrap; }
.ty-sv-btn:hover { background:#243244; }
.ty-sv-btn:disabled { opacity:.34; cursor:default; }
.ty-sv-btn.on { background:#2b6c8f; border-color:#4f9fc9; color:#eaf6ff; }
.ty-sv-nav { width:24px; padding:0; text-align:center; }
.ty-sv-del { border-color:#6a3a3a; color:#e9a3a3; }
.ty-sv-del:hover { background:#3a2222; }
.ty-sv-count { font-size:11px; color:#98a3b0; font-variant-numeric:tabular-nums;
               min-width:30px; text-align:center; margin-left:auto; }
.ty-sv-stage { position:relative; flex:1 1 auto; min-height:0; border-radius:6px;
               overflow:hidden; background:#111216; box-shadow: inset 0 0 0 1px #2c2e36; }
.ty-sv-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
             display:block; }
.ty-sv-size { position:absolute; right:6px; bottom:6px; font-size:10.5px; color:#c9d3df;
              background:rgba(0,0,0,.55); padding:1px 6px; border-radius:4px;
              font-variant-numeric:tabular-nums; pointer-events:none; }

/* 九宫格：三列，超过高度就在格子里滚，按住空白也能拖 */
.ty-sv-grid { position:absolute; inset:0; display:none; box-sizing:border-box;
              grid-template-columns:repeat(3, 1fr); gap:4px; padding:4px;
              align-content:start; align-items:start;
              grid-auto-rows:max-content;   /* 行高按格子自己的 4:3 撑开，不能让它按容器均分，否则整行压叠 */
              overflow-y:auto; overflow-x:hidden;
              cursor:grab; scrollbar-width:thin; }
.ty-sv-grid.on { display:grid; }
.ty-sv-grid.drag { cursor:grabbing; }
.ty-sv-grid::-webkit-scrollbar { width:8px; }
.ty-sv-grid::-webkit-scrollbar-thumb { background:#3a3f4a; border-radius:4px; }
.ty-sv-grid::-webkit-scrollbar-track { background:transparent; }
.ty-sv-cell { position:relative; aspect-ratio:4 / 3; overflow:hidden; border-radius:4px;
              background:#0b0c0f; box-shadow: inset 0 0 0 1px #2c2e36; cursor:pointer; }
.ty-sv-cell:hover { box-shadow: inset 0 0 0 1px #4f7ea0; }
.ty-sv-cell.sel { box-shadow: inset 0 0 0 2px #4f9fc9; }
.ty-sv-cell img { width:100%; height:100%; object-fit:contain; display:block;
                  pointer-events:none; }
.ty-sv-cell .n { position:absolute; right:3px; bottom:2px; font-size:10px; color:#dfe8f2;
                 background:rgba(0,0,0,.62); padding:0 4px; border-radius:3px;
                 font-variant-numeric:tabular-nums; pointer-events:none; }

.ty-sv-empty { position:absolute; inset:0; display:none; align-items:center;
               justify-content:center; color:#5d6673; font-size:12px; text-align:center;
               padding:0 16px; line-height:1.7; }
.ty-sv-drop { position:absolute; inset:0; display:none; align-items:center;
              justify-content:center; color:#8fd0ff; font-size:12.5px;
              background:rgba(20,40,60,.72); box-shadow: inset 0 0 0 2px #4f9fc9; }
.ty-sv-stage.dragover .ty-sv-drop { display:flex; }
.ty-sv-pano { position:absolute; inset:0; display:none; background:#000;
              align-items:center; justify-content:center; }
.ty-sv-pano canvas { display:block; cursor:grab; touch-action:none; }
.ty-sv-pano canvas.drag { cursor:grabbing; }
.ty-sv-pano-bar { position:absolute; left:6px; right:6px; bottom:6px; display:flex;
                  align-items:center; gap:6px; }
.ty-sv-hint { font-size:10.5px; color:#c9d3df; background:rgba(0,0,0,.5);
              padding:2px 6px; border-radius:4px; white-space:nowrap;
              overflow:hidden; text-overflow:ellipsis; }
`;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ 工具 */

function viewUrl(info) {
  const q = new URLSearchParams({
    filename: info.filename || "",
    subfolder: info.subfolder || "",
    type: info.type || "output",
  });
  return `${API}/view?${q.toString()}`;
}

/* --------------------------------------------- 把图拖到画布上：单独加载一个节点 */

let dragOut = null;        // { info, ghost }
let justDragged = false;   // 拖完别再当成点击

function ghostEl() {
  let el = document.getElementById("TYSV_GHOST");
  if (!el) {
    el = document.createElement("img");
    el.id = "TYSV_GHOST";
    el.alt = "";
    el.style.cssText =
      "position:fixed;left:0;top:0;width:150px;height:auto;display:none;pointer-events:none;" +
      "z-index:99999;border-radius:6px;opacity:.92;transform:translate(-50%,-50%);" +
      "box-shadow:0 8px 22px rgba(0,0,0,.6);outline:1px solid #4f9fc9;";
    document.body.appendChild(el);
  }
  return el;
}

function dragOutStart(info, e) {
  const ghost = ghostEl();
  ghost.src = viewUrl(info);
  ghost.style.display = "block";
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;
  dragOut = { info, ghost };
}

function dragOutMove(e) {
  if (!dragOut) return;
  dragOut.ghost.style.left = `${e.clientX}px`;
  dragOut.ghost.style.top = `${e.clientY}px`;
}

/** 中途放弃（pointercancel / 窗口失焦）：只收起幽灵图，不建节点 */
function dragOutAbort() {
  if (!dragOut) return;
  dragOut.ghost.style.display = "none";
  dragOut = null;
}

function dragOutEnd(e) {
  if (!dragOut) return;
  const { info, ghost } = dragOut;
  dragOut = null;
  ghost.style.display = "none";
  const cv = app.canvas?.canvas;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  let p;
  try {
    p = app.canvas.convertEventToCanvasOffset(e);
  } catch {
    p = [e.clientX - r.left, e.clientY - r.top];
  }
  spawnLoader(info, p[0], p[1]);
}

/* 拖出来的图存到哪里：input 下的一个专门子目录，不跟原图混在一起 */
const DRAG_SUBFOLDER = "TaiYang_拖出";
const dragCache = new Map();   // "subfolder/filename" -> input 里的相对路径

function widgetOf(node, name) {
  return (node.widgets || []).find((it) => it.name === name);
}

/** 把输出目录里的这张图复制一份到 input，标准 LoadImage 才认 */
async function ensureInputCopy(info) {
  const key = `${info.subfolder || ""}/${info.filename}`;
  if (dragCache.has(key)) return dragCache.get(key);

  const resp = await fetch(viewUrl(info));
  if (!resp.ok) throw new Error(`取图失败 HTTP ${resp.status}`);
  const blob = await resp.blob();

  const fd = new FormData();
  fd.append("image", blob, info.filename);
  fd.append("type", "input");
  fd.append("subfolder", DRAG_SUBFOLDER);
  const up = await fetch(`${API}/upload/image`, { method: "POST", body: fd });
  const j = await up.json();
  if (!j?.name) throw new Error("上传没有返回文件名");

  const rel = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  dragCache.set(key, rel);
  return rel;
}

/** 在画布 (x,y) 处建一个独立载入节点（图的副本进 input，节点就是标准 LoadImage） */
async function spawnLoader(info, x, y) {
  const n = window.LiteGraph?.createNode?.("LoadImage");
  if (!n) return null;

  n.pos = [x - 40, y - 24];
  n.title = `载入中：${info.filename}`;
  app.graph.add(n);
  app.graph.setDirtyCanvas?.(true, true);

  try {
    const rel = await ensureInputCopy(info);
    const w = widgetOf(n, "image");
    if (w) {
      w.value = rel;
      try {
        w.callback?.(rel);
      } catch {
        /* 忽略 */
      }
      n.onWidgetChanged?.(w.name, rel, rel, w);
    }
    n.title = `载入 ${info.filename}`;
  } catch (e) {
    console.error("[TaiYang保存] 拖出载入失败", e);
    n.title = `载入失败：${info.filename}`;
  }
  app.graph.setDirtyCanvas?.(true, true);
  try {
    app.canvas.selectNode?.(n, false);
  } catch {
    /* 忽略 */
  }
  return n;
}

/** 给某个元素挂上「按住往画布上拖」的行为 */
function bindDragOut(el, getInfo) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const info = getInfo();
    if (!info) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    let last = { clientX: sx, clientY: sy, preventDefault() {}, stopPropagation() {} };

    const onMove = (ev) => {
      last = ev;
      if (!started) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 8) return;
        started = true;
        dragOutStart(info, ev);
        // 拖拽期间别让浏览器顺手做图片原生拖拽 / 选中文字
        try {
          el.setPointerCapture?.(ev.pointerId);
        } catch {
          /* 忽略 */
        }
      }
      dragOutMove(ev);
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onAbort, true);
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        /* 忽略 */
      }
    };

    const onUp = (ev) => {
      detach();
      if (!started) return;
      // 有些前端组件会在冒泡阶段吞掉 pointerup，坐标兜底用最后一次移动的位置
      const evt = ev && typeof ev.clientX === "number" ? ev : last;
      dragOutEnd(evt);
      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 120);
    };

    const onCancel = () => {
      detach();
      if (started) dragOutAbort();
    };

    const onAbort = () => {
      detach();
      if (started) dragOutAbort();
    };

    // 必须挂在**捕获阶段**：画布（LiteGraph）会在冒泡阶段把 pointerup 拦掉，
    // 只有捕获阶段才能保证「在节点外松手」也能收到，否则拖出去就永远拖不出来。
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onAbort, true);
  });
}


function stateOf(node) {
  if (!node.__tySv) {
    node.__tySv = { images: [], index: 0, mode: "view" };  // view | grid | pano
  }
  return node.__tySv;
}

function listWidget(node) {
  return (node.widgets || []).find((w) => w.name === LIST_WIDGET);
}

/** 把节点里的图清单同时写进 properties 和隐藏控件，后端才拿得到。 */
function syncList(node) {
  const st = stateOf(node);
  const text = JSON.stringify(st.images);
  node.properties = node.properties || {};
  node.properties.ty_images = st.images;
  const w = listWidget(node);
  if (w) w.value = text;
}

function hideListWidget(node) {
  const w = listWidget(node);
  if (!w || w.__tyHidden) return;
  w.__tyHidden = true;
  // -4 是 litegraph 自己给控件之间留的间距，返回它等于占位为 0
  w.computeSize = () => [0, -4];
  w.type = "hidden";
  w.draw = () => {};
}

function currentIndex(node) {
  const st = stateOf(node);
  if (!st.images.length) return -1;
  return Math.min(Math.max(st.index, 0), st.images.length - 1);
}

/** 往后追加，并顺手把超量最老的那几张丢掉。 */
function appendImages(node, list) {
  const st = stateOf(node);
  st.images = st.images.concat(list);
  if (st.images.length > MAX_IMAGES) {
    st.images = st.images.slice(-MAX_IMAGES);
  }
  // 选中「这一批里的第一张」，位置一定落在追加进来的那一段上
  const keep = Math.min(list.length, st.images.length);
  st.index = Math.max(0, st.images.length - keep);
  return st;
}

/* ------------------------------------------------------------------ 全景引擎 */

const PANO_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// 等距柱状（equirectangular）贴图 → 球面取景。
// 屏幕像素反算视线方向，方向再换算成经纬度去采样，就是一张能环视的全景。
const PANO_FS = `
precision highp float;
uniform sampler2D uTex;
uniform vec3 uFwd;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uAspect;
uniform float uTanHalf;
uniform vec2 uRes;
void main() {
  vec2 p = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 d = normalize(uFwd + uRight * (p.x * uAspect * uTanHalf) + uUp * (p.y * uTanHalf));
  float lon = atan(d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  vec2 uv = vec2(fract(lon / 6.283185307 + 0.5), 0.5 + lat / 3.141592654);
  gl_FragColor = texture2D(uTex, uv);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("[TaiYang保存] 着色器编译失败", gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

function createPano(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: true });
    if (!gl) gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: true });
  } catch (e) {
    gl = null;
  }
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, PANO_VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, PANO_FS);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("[TaiYang保存] 着色器链接失败", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uni = {};
  for (const n of ["uTex", "uFwd", "uRight", "uUp", "uAspect", "uTanHalf", "uRes"]) {
    uni[n] = gl.getUniformLocation(prog, n);
  }

  const tex = gl.createTexture();
  return {
    gl, tex, uni,
    yaw: Math.PI / 2,
    pitch: 0,
    fov: 80,
    ready: false,
    aspect2to1: true,

    setImage(imgEl) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgEl);
      } catch (e) {
        console.error("[TaiYang保存] 全景贴图上传失败", e);
        return false;
      }
      const isWebgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
      const pot = (n) => (n & (n - 1)) === 0;
      // WebGL1 的非 2 次幂贴图不能用 REPEAT，退成夹取（接缝处差一个像素，肉眼无感）
      const wrapS = isWebgl2 || (pot(imgEl.naturalWidth) && pot(imgEl.naturalHeight))
        ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.aspect2to1 = Math.abs(imgEl.naturalWidth / imgEl.naturalHeight - 2) < 0.6;
      this.ready = true;
      return true;
    },

    render() {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.ready) return;

      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const fwd = [cp * sy, sp, cp * cy];
      const right = [cy, 0, -sy];
      // up = forward × right
      const up = [
        fwd[1] * right[2] - fwd[2] * right[1],
        fwd[2] * right[0] - fwd[0] * right[2],
        fwd[0] * right[1] - fwd[1] * right[0],
      ];

      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uni.uTex, 0);
      gl.uniform3f(uni.uFwd, fwd[0], fwd[1], fwd[2]);
      gl.uniform3f(uni.uRight, right[0], right[1], right[2]);
      gl.uniform3f(uni.uUp, up[0], up[1], up[2]);
      gl.uniform1f(uni.uAspect, w / h);
      gl.uniform1f(uni.uTanHalf, Math.tan((this.fov * Math.PI) / 360));
      gl.uniform2f(uni.uRes, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

/* ------------------------------------------------------------------ DOM */

function buildPanel(node) {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "ty-sv";
  root.innerHTML = `
    <div class="ty-sv-bar">
      <button class="ty-sv-btn ty-sv-load" title="从本机挑图片放进这个节点（可以一次选多张）">载入图片</button>
      <button class="ty-sv-btn ty-sv-pano-btn" title="把当前这张当 360 全景环视，可拖动、可缩放、可截图">全景查看</button>
      <button class="ty-sv-btn ty-sv-back" title="回到九宫格，一次看完所有图；点某一格再回到大图">返回</button>
      <span class="ty-sv-count"></span>
      <button class="ty-sv-btn ty-sv-nav ty-sv-prev" title="上一张">◀</button>
      <button class="ty-sv-btn ty-sv-nav ty-sv-next" title="下一张">▶</button>
      <button class="ty-sv-btn ty-sv-del" title="把当前这张从节点里拿掉（硬盘上的文件不会被删）">移除</button>
    </div>
    <div class="ty-sv-stage">
      <div class="ty-sv-grid"></div>
      <img class="ty-sv-img" alt="" draggable="false">
      <span class="ty-sv-size"></span>
      <div class="ty-sv-pano">
        <canvas></canvas>
        <div class="ty-sv-pano-bar">
          <button class="ty-sv-btn ty-sv-shot" title="把当前看到的这个角度按 4:3 存成一张新图">截图保存</button>
          <span class="ty-sv-hint">按住拖动环视 · 滚轮缩放 · 取景框即 4:3 成品</span>
          <button class="ty-sv-btn ty-sv-pano-exit" style="margin-left:auto">×</button>
        </div>
      </div>
      <div class="ty-sv-drop">松手就载入</div>
      <div class="ty-sv-empty">还没有图片<br>点上面「载入图片」，或者把图拖进来</div>
    </div>
    <input class="ty-sv-file" type="file" accept="image/*" multiple hidden>`;

  const refs = {
    root,
    load: root.querySelector(".ty-sv-load"),
    panoBtn: root.querySelector(".ty-sv-pano-btn"),
    back: root.querySelector(".ty-sv-back"),
    count: root.querySelector(".ty-sv-count"),
    prev: root.querySelector(".ty-sv-prev"),
    next: root.querySelector(".ty-sv-next"),
    del: root.querySelector(".ty-sv-del"),
    stage: root.querySelector(".ty-sv-stage"),
    grid: root.querySelector(".ty-sv-grid"),
    img: root.querySelector(".ty-sv-img"),
    size: root.querySelector(".ty-sv-size"),
    pano: root.querySelector(".ty-sv-pano"),
    canvas: root.querySelector(".ty-sv-pano canvas"),
    shot: root.querySelector(".ty-sv-shot"),
    panoExit: root.querySelector(".ty-sv-pano-exit"),
    hint: root.querySelector(".ty-sv-hint"),
    empty: root.querySelector(".ty-sv-empty"),
    file: root.querySelector(".ty-sv-file"),
  };
  refs.panoEngine = null;
  refs.panoLoadedUrl = null;

  // 阻住事件，别让拖动/滚轮漏到画布上（只挡传播，不影响格子自己滚动）
  for (const ev of ["pointerdown", "wheel", "contextmenu"]) {
    root.addEventListener(ev, (e) => e.stopPropagation(), { passive: false });
  }

  refs.load.addEventListener("click", (e) => {
    e.stopPropagation();
    refs.file.value = "";
    refs.file.click();
  });
  refs.file.addEventListener("change", () => {
    if (refs.file.files?.length) uploadFiles(node, refs.file.files);
  });

  refs.prev.addEventListener("click", (e) => {
    e.stopPropagation();
    step(node, -1);
  });
  refs.next.addEventListener("click", (e) => {
    e.stopPropagation();
    step(node, +1);
  });
  refs.del.addEventListener("click", (e) => {
    e.stopPropagation();
    removeCurrent(node);
  });

  // 返回：不管在全景还是大图，都回到九宫格
  refs.back.addEventListener("click", (e) => {
    e.stopPropagation();
    const st = stateOf(node);
    if (!st.images.length) return;
    st.mode = "grid";
    render(node);
  });

  refs.panoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const st = stateOf(node);
    if (st.mode === "pano") {
      st.mode = "view";
      render(node);
    } else if (st.images.length) {
      st.mode = "pano";
      render(node);
    }
  });
  refs.panoExit.addEventListener("click", (e) => {
    e.stopPropagation();
    stateOf(node).mode = "view";
    render(node);
  });
  refs.shot.addEventListener("click", (e) => {
    e.stopPropagation();
    shootPano(node);
  });

  // 点九宫格里的一格 -> 回到大图看这张
  refs.grid.addEventListener("click", (e) => {
    if (justDragged) return;   // 刚拖出去一个载入节点，别再当成点击
    const cell = e.target?.closest?.(".ty-sv-cell");
    if (!cell) return;
    const i = Number(cell.dataset.i);
    if (!Number.isFinite(i)) return;
    const st = stateOf(node);
    st.index = i;
    st.mode = "view";
    render(node);
  });

  // 按住空白处往下拖也能翻（图多的时候省得抠滚动条）
  let gdrag = null;
  refs.grid.addEventListener("pointerdown", (e) => {
    if (e.target?.closest?.(".ty-sv-cell")) return;
    gdrag = { y: e.clientY, top: refs.grid.scrollTop };
    refs.grid.classList.add("drag");
  });
  refs.grid.addEventListener("pointermove", (e) => {
    if (!gdrag) return;
    refs.grid.scrollTop = gdrag.top - (e.clientY - gdrag.y);
  });
  const gend = () => {
    gdrag = null;
    refs.grid.classList.remove("drag");
  };
  refs.grid.addEventListener("pointerup", gend);
  refs.grid.addEventListener("pointerleave", gend);
  refs.grid.addEventListener("pointercancel", gend);

  // 把文件拖到预览区也能载入
  let dragDepth = 0;
  refs.stage.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer) return;
    dragDepth++;
    refs.stage.classList.add("dragover");
    e.preventDefault();
  });
  refs.stage.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  refs.stage.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) refs.stage.classList.remove("dragover");
  });
  refs.stage.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    refs.stage.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (files?.length) uploadFiles(node, files);
  });

  // 大图也能按住拖到画布上单独加载
  bindDragOut(refs.img, () => {
    const st = stateOf(node);
    return st.images[currentIndex(node)] || null;
  });

  bindPanoDrag(node, refs);

  const ro = new ResizeObserver(() => {
    sizePanoCanvas(refs);
    if (stateOf(node).mode === "pano" && refs.panoEngine) refs.panoEngine.render();
  });
  ro.observe(refs.stage);

  return refs;
}

/* ------------------------------------------------------------------ 载入 / 删除 / 翻页 */

async function uploadFiles(node, fileList) {
  const files = Array.from(fileList).filter((f) => (f.type || "").startsWith("image/"));
  if (!files.length) return;
  const refs = node.__tySvRefs;
  if (refs) refs.empty.style.display = "none";

  const added = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append("image", f, f.name);
    fd.append("type", "input");
    fd.append("subfolder", UPLOAD_SUBFOLDER);
    try {
      const resp = await fetch(`${API}/upload/image`, { method: "POST", body: fd });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const info = await resp.json();
      if (info?.error) throw new Error(info.error);
      if (info?.name) {
        added.push({
          filename: info.name,
          subfolder: info.subfolder || "",
          type: info.type || "input",
        });
      }
    } catch (e) {
      console.error("[TaiYang保存] 载入图片失败", f.name, e);
    }
  }
  if (!added.length) {
    render(node);
    return;
  }

  // 新载入的排在后面，不要插到前面去
  const st = appendImages(node, added);
  st.mode = "view";
  syncList(node);
  render(node);
  app.graph?.setDirtyCanvas?.(true, true);
}

function removeCurrent(node) {
  const st = stateOf(node);
  const i = currentIndex(node);
  if (i < 0) return;
  st.images.splice(i, 1);
  st.index = Math.max(0, Math.min(i, st.images.length - 1));
  if (!st.images.length) st.mode = "view";
  syncList(node);
  render(node);
  app.graph?.setDirtyCanvas?.(true, true);
}

function step(node, delta) {
  const st = stateOf(node);
  const n = st.images.length;
  if (n < 2) return;
  st.index = (currentIndex(node) + delta + n) % n;
  if (st.mode === "pano") st.mode = "view";
  render(node);
}

/* ------------------------------------------------------------------ 渲染 */

function renderGrid(node, refs, st) {
  const cur = currentIndex(node);
  refs.grid.innerHTML = "";
  st.images.forEach((info, k) => {
    const cell = document.createElement("div");
    cell.className = "ty-sv-cell" + (k === cur ? " sel" : "");
    cell.dataset.i = String(k);

    const im = document.createElement("img");
    im.alt = "";
    im.draggable = false;
    im.loading = "lazy";
    im.src = viewUrl(info);
    cell.appendChild(im);

    const tag = document.createElement("span");
    tag.className = "n";
    tag.textContent = String(k + 1);
    cell.appendChild(tag);

    // 按住这一格往画布上拖，就在那边单独生成一个载入节点
    bindDragOut(cell, () => st.images[k]);

    refs.grid.appendChild(cell);
  });

  // 让当前选中的那格滚进视野（手动算，别用 scrollIntoView，免得动到画布）
  const sel = refs.grid.querySelector(".ty-sv-cell.sel");
  if (sel) {
    const top = sel.offsetTop;
    const bottom = top + sel.offsetHeight;
    if (top < refs.grid.scrollTop) {
      refs.grid.scrollTop = Math.max(0, top - 4);
    } else if (bottom > refs.grid.scrollTop + refs.grid.clientHeight) {
      refs.grid.scrollTop = bottom - refs.grid.clientHeight + 4;
    }
  }
}

function render(node) {
  const refs = node.__tySvRefs;
  if (!refs) return;
  const st = stateOf(node);
  const n = st.images.length;
  if (!n) st.mode = "view";
  const i = currentIndex(node);

  const inPano = st.mode === "pano" && n > 0;
  const inGrid = st.mode === "grid" && n > 0;

  refs.empty.style.display = n ? "none" : "flex";
  refs.img.style.display = n && !inPano && !inGrid ? "block" : "none";
  refs.pano.style.display = inPano ? "flex" : "none";
  refs.grid.classList.toggle("on", inGrid);
  refs.count.textContent = n ? `${i + 1}/${n}` : "";

  refs.prev.disabled = n < 2 || inGrid;
  refs.next.disabled = n < 2 || inGrid;
  refs.del.disabled = n === 0;
  refs.back.disabled = n === 0 || inGrid;
  refs.back.classList.toggle("on", inGrid);
  refs.panoBtn.disabled = n === 0 || inGrid;
  refs.panoBtn.classList.toggle("on", inPano);

  if (inGrid) {
    renderGrid(node, refs, st);
  } else if (n) {
    const cur = st.images[i];
    const url = viewUrl(cur);
    if (refs.img.dataset.url !== url) {
      refs.img.dataset.url = url;
      refs.img.src = url;
      refs.size.textContent = "";
    }
  } else {
    refs.img.removeAttribute("src");
    refs.img.dataset.url = "";
    refs.size.textContent = "";
  }

  if (inPano) {
    sizePanoCanvas(refs);
    loadPanoImage(node);
  }
}

/* ------------------------------------------------------------------ 全景 */

function sizePanoCanvas(refs) {
  const c = refs.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(1, refs.pano.clientWidth || 320);
  const ch = Math.max(1, refs.pano.clientHeight || 200);

  // 取景框固定 4:3、居中放 —— 屏幕上看到的范围就是截出来的那张图
  let w = cw;
  let h = Math.round((cw * SHOT_H) / SHOT_W);
  if (h > ch) {
    h = ch;
    w = Math.round((ch * SHOT_W) / SHOT_H);
  }
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;

  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
}

function loadPanoImage(node) {
  const refs = node.__tySvRefs;
  const i = currentIndex(node);
  if (i < 0) return;
  const url = viewUrl(stateOf(node).images[i]);
  if (refs.panoLoadedUrl === url && refs.panoEngine) {
    refs.panoEngine.render();
    return;
  }
  refs.panoLoadedUrl = url;

  if (!refs.panoEngine) refs.panoEngine = createPano(refs.canvas);
  if (!refs.panoEngine) {
    refs.hint.textContent = "这个浏览器不支持 WebGL，全景查看用不了";
    return;
  }
  const img = new Image();
  img.onload = () => {
    refs.panoLoadedUrl = url;
    if (!refs.panoEngine.setImage(img)) return;
    refs.panoEngine.yaw = Math.PI / 2;
    refs.panoEngine.pitch = 0;
    refs.panoEngine.fov = 80;
    refs.panoEngine.render();
    refs.hint.textContent = refs.panoEngine.aspect2to1
      ? "按住拖动环视 · 滚轮缩放 · 取景框即 4:3 成品"
      : "这张不是 2:1 全景图，也能环视，但上下会有点变形";
  };
  img.onerror = () => {
    refs.hint.textContent = "图片加载失败";
  };
  img.src = url;
}

function bindPanoDrag(node, refs) {
  const c = refs.canvas;
  let drag = null;
  c.addEventListener("pointerdown", (e) => {
    if (!refs.panoEngine) return;
    drag = { x: e.clientX, y: e.clientY, yaw: refs.panoEngine.yaw, pitch: refs.panoEngine.pitch };
    c.classList.add("drag");
    c.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  c.addEventListener("pointermove", (e) => {
    if (!drag || !refs.panoEngine) return;
    const eng = refs.panoEngine;
    const k = (eng.fov / 90) * 0.0045;
    eng.yaw = drag.yaw - (e.clientX - drag.x) * k;
    const lim = Math.PI / 2 - 0.02;
    eng.pitch = Math.max(-lim, Math.min(lim, drag.pitch + (e.clientY - drag.y) * k));
    eng.render();
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    c.classList.remove("drag");
    if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
  c.addEventListener("wheel", (e) => {
    if (!refs.panoEngine) return;
    e.preventDefault();
    const eng = refs.panoEngine;
    eng.fov = Math.max(25, Math.min(110, eng.fov + (e.deltaY > 0 ? 4 : -4)));
    eng.render();
  }, { passive: false });
}

async function shootPano(node) {
  const refs = node.__tySvRefs;
  const eng = refs?.panoEngine;
  if (!eng || !eng.ready) return;
  const c = refs.canvas;

  // 按固定 4:3（1600x1200）重画一次再取图：
  // 不再跟着节点被拉成什么形状走，截出来的永远是 4:3
  const oldW = c.width, oldH = c.height;
  try {
    c.width = SHOT_W;
    c.height = SHOT_H;
    eng.render();
    const data = c.toDataURL("image/png");
    c.width = oldW;
    c.height = oldH;
    eng.render();

    refs.shot.disabled = true;
    refs.shot.textContent = "保存中…";
    const resp = await fetch(`${API}/taiyang/save_shot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, subfolder: UPLOAD_SUBFOLDER, filename: "全景截图_%Y-%m-%d-%H-%M-%S" }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const info = await resp.json();
    if (info.error) throw new Error(info.error);

    // 截出来的图也排到最后
    const st = appendImages(node, [info]);
    st.mode = "view";          // 截完直接回预览区看结果，别停在全景里
    syncList(node);
    refs.panoLoadedUrl = null;
    render(node);
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (e) {
    console.error("[TaiYang保存] 截图保存失败", e);
  } finally {
    refs.shot.disabled = false;
    refs.shot.textContent = "截图保存";
  }
}

/* ------------------------------------------------------------------ 注册 */

app.registerExtension({
  name: "ComfyUI.TaiYangImageSaver",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      // 初始尺寸：宽比高约 5:4，图区正好铺满一张 2:1 全景
      node.setSize?.([NODE_W, NODE_H]);
      if (!node.setSize) node.size = [NODE_W, NODE_H];
      node.__tySv = { images: [], index: 0, mode: "view" };
      hideListWidget(node);

      setTimeout(() => {
        if (node.__tySvRefs) return;
        try {
          const refs = buildPanel(node);
          node.__tySvRefs = refs;
          // 高度跟着节点走，节点拉高图区就变大
          node.addDOMWidget("ty_saver_panel", "TY_SAVER", refs.root, {
            serialize: false,
            hideOnZoom: false,
            getHeight: () => Math.max(160, (node.size?.[1] || NODE_H) - CHROME_H),
            getMinHeight: () => 120,
            getMaxHeight: () => 2400,
          });
          // 图本身多大，加载完把尺寸显示在右下角
          refs.img.addEventListener("load", () => {
            if (refs.img.naturalWidth) {
              refs.size.textContent = `${refs.img.naturalWidth} × ${refs.img.naturalHeight}`;
            }
          });
          render(node);
        } catch (e) {
          console.error("[TaiYang保存] 面板创建失败", e);
        }
      }, 0);

      return r;
    };

    // 节点被拉大/拉小时，全景画布跟着重排（只挂一次，写在 onNodeCreated 外面）
    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
      const rr = onResize ? onResize.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        if (!this.__tySvRefs) return;
        sizePanoCanvas(this.__tySvRefs);
        if (stateOf(this).mode === "pano" && this.__tySvRefs.panoEngine) {
          this.__tySvRefs.panoEngine.render();
        }
      });
      return rr;
    };

    // 跑完之后拿保存结果（走 ty_saved，不会触发 ComfyUI 自带的预览区）
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      const list = (message?.ty_saved || []).filter((x) => x && x.filename);
      if (list.length) {
        const st = appendImages(this, list);   // 新存的排后面
        st.mode = "view";
        syncList(this);
        requestAnimationFrame(() => render(this));
      }
      return r;
    };

    // 重新打开工作流时把上次存的图恢复出来
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const node = this;
      hideListWidget(node);
      const saved = node.properties?.ty_images;
      if (Array.isArray(saved) && saved.length) {
        node.__tySv = { images: saved.slice(), index: 0, mode: "view" };
        syncList(node);
        requestAnimationFrame(() => render(node));
      }
      return r;
    };
  },
});
