import { app } from "../../scripts/app.js";

const NODE_NAME = "TaiYangMultiAudioLoader";
const MAX_AUDIOS = 8;

/**
 * auto_link 的可选目标（音频版）。
 *
 * 设计原则同图片版：**按能力发现，而不是硬编码节点类型**。
 *
 * A) AUTOGROW_GROUPS：autogrow 动态槽位。按「组名」匹配：
 *    - H3 参考转视频:   组 "ref_audios"，槽 ref_audio_0 / ref_audio_1 ...
 *    注意 H3 还有 AUDIO 类型的 "ref_video_audios" 组（参考视频的原声），
 *    靠组名白名单排除，绝不能只按槽类型 AUDIO 匹配，否则会把独立参考音频
 *    错接到视频原声槽上。
 * B) STATIC_TARGETS：schema 里固定声明的音频槽（Star7 的 ref_audio_0/1/2）。
 *    用 nameAt 生成槽名，兼容 0 基 + 下划线的命名（与图片版 image1/2/3 不同）。
 */
const AUTOGROW_GROUPS = ["ref_audios"];
const AUTOGROW_TARGETS = ["MiniMaxH3ReferenceToVideo"];
const STATIC_TARGETS = {
  // Star7 的独立参考音频是固定槽 ref_audio_0/1/2（0 基、下划线）
  MiniMaxH3MaterialPromptStar7: { count: 3, nameAt: (i) => `ref_audio_${i}`, scanMax: 16 },
};

const MODE_OPTIONS = ["自动", ...AUTOGROW_TARGETS, ...Object.keys(STATIC_TARGETS), "关闭"];
const MODE_AUTO = 0;
const MODE_OFF = MODE_OPTIONS.length - 1;

// ---------------------------------------------------------------- 布局常量
const CELL = 130;
const GAP = 10;
const COLS = 4;
const START_X = 20;
const HEADER_H = 62; // 顶部标题 + 状态文字
const GRID_ROWS = Math.ceil(MAX_AUDIOS / COLS);
const GRID_H = GRID_ROWS * CELL + (GRID_ROWS - 1) * GAP;
// 右侧留出输出槽标签宽度（audio_1 / audio_8），否则标签会压在最右侧格子上
const SLOT_DOT_W = 12;
const SLOT_LABEL_W = 62;
const RIGHT_PAD = SLOT_DOT_W + SLOT_LABEL_W;
// 拖拽判定阈值（px）：按下后移动超过它才算真拖，单击无动作
const DRAG_THRESHOLD = 8;

// ---------------------------------------------------------------- 拖拽排序（纯逻辑）
// 统一模型：order[p] = 位置 p 上放的是原来第几个音频。绘制与落盘都基于这一个数组。

/** 恒等顺序：位置 p 放第 p 个 */
function identityOrder(count) {
  const o = [];
  for (let i = 0; i < count; i++) o.push(i);
  return o;
}

/** 把第 from 个挪到第 to 位之后的顺序；无效落点返回 null */
function computeOrder(count, from, to) {
  if (to == null || to < 0 || to >= count || to === from) return null;
  return applyMove(identityOrder(count), from, to);
}

/** 在已有顺序上做一次「移动」，返回新数组（不改原数组） */
function applyMove(order, from, to) {
  const o = order.slice();
  o.splice(to, 0, o.splice(from, 1)[0]);
  return o;
}

/** 按顺序重排文件列表 */
function reorderList(list, from, to) {
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const WIDGET_TOP_GAP = HEADER_H + GRID_H;
const WIDGET_H = 34;
const NODE_W = START_X * 2 + COLS * CELL + (COLS - 1) * GAP + RIGHT_PAD;
const NODE_H = WIDGET_TOP_GAP + WIDGET_H + 10;
// 底部auto_link 条的高度
const BAR_H = 24;
const BAR_GAP = 6;
// 底部控件区总高度
const BOTTOM_BLOCK_H = BAR_H + BAR_GAP * 2;
// 节点最小宽度
const MIN_NODE_W = 320;

/**
 * 按**实际已用行数**算最小高度。
 * 网格只画到有内容的那几行，所以音频少时节点可以缩得很矮——
 * 只要「已用网格 + 底部控件区」能放下就行，不遮挡当前已有的音频。
 */
function minHeightFor(node) {
  const n = (node?._audios || []).length;
  // 有音频就多留一个加号格的位置（加号固定排在所有音频后面）
  const slots = n < MAX_AUDIOS ? n + 1 : n;
  const rows = Math.max(1, Math.ceil(slots / COLS));
  const gridH = rows * CELL + (rows - 1) * GAP;
  return HEADER_H + gridH + BOTTOM_BLOCK_H;
}

/**
 * 底部 auto_link 条布局：**贴着节点实际底边往上排**。
 * 用户手动缩放节点时，控件跟着底边一起动，而不是钉在固定坐标上。
 */
function bottomLayout(nodeH) {
  return { modeY: nodeH - BAR_H - BAR_GAP };
}

/**
 * 钳制节点尺寸：宽度不低于 MIN_NODE_W，高度不低于「已用网格 + 控件区」。
 * 这样既能自由缩小（音频少时），又保证控件不会盖住已有音频。
 */
function clampNodeSize(node) {
  const s = node?.size;
  if (!s) return node;
  if (!(s[0] >= MIN_NODE_W)) s[0] = MIN_NODE_W;
  const minH = minHeightFor(node);
  if (!(s[1] >= minH)) s[1] = minH;
  return node;
}

// ---------------------------------------------------------------- 基础工具

function getWidget(node, name) {
  return node?.widgets?.find((w) => w.name === name) || null;
}

/**
 * 节点是否被折叠。LiteGraph 折叠后只画一条标题栏，
 * 但仍然会调用 onDrawForeground，所以自绘部分必须自己判断并整体跳过，
 * 否则网格和底部控制条会画到节点框外的画布上。
 */
function isCollapsed(node) {
  return node?.flags?.collapsed === true || node?.collapsed === true;
}

function getMode(node) {
  const w = getWidget(node, "auto_link");
  if (!w) return MODE_AUTO;
  let idx = w.value;
  if (typeof idx === "string") {
    idx = MODE_OPTIONS.indexOf(idx);
    if (idx === -1) idx = MODE_AUTO;
  }
  return typeof idx === "number" && idx >= 0 && idx < MODE_OPTIONS.length ? idx : MODE_AUTO;
}

/** 读取节点里保存的音频文件名列表（已剔除空槽） */
function getAudioFiles(node) {
  const w = getWidget(node, "audio_files");
  if (!w) return [];
  try {
    const parsed = JSON.parse(w.value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** 文件名过长时截断，给格子里显示 */
function truncateName(name, n) {
  const s = String(name || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------- 输出槽管理

/** 只扩不缩：保证至少有 count 个输出。连线前必须先做，否则 outputs[i] 不存在会连不上 */
function growOutputSlots(node, count) {
  if (typeof node.addOutput !== "function") return;
  const target = Math.max(1, Math.min(count, MAX_AUDIOS));
  try {
    while (node.outputs.length < target) {
      const idx = node.outputs.length;
      node.addOutput(`audio_${idx + 1}`, "AUDIO");
    }
  } catch (e) {
    console.warn("[TaiYangMultiAudio] 扩展输出槽失败", e);
  }
}

/**
 * 让输出槽数量跟随音频数量：有几个音频就显示几个 audio_N 输出。
 * 用 addOutput / removeOutput（内部会维护 link 的 origin_slot），不直接 splice。
 */
function syncOutputSlots(node, count) {
  if (typeof node.addOutput !== "function" || typeof node.removeOutput !== "function") return;
  const want = Math.max(1, Math.min(count, MAX_AUDIOS));
  const linked = (node.outputs || []).filter((o) => (o.links || []).length > 0).length;
  const target = Math.max(want, linked);

  growOutputSlots(node, target);
  try {
    while (node.outputs.length > target) {
      node.removeOutput(node.outputs.length - 1);
    }
  } catch (e) {
    console.warn("[TaiYangMultiAudio] 调整输出槽失败", e);
  }
  node.setDirtyCanvas?.(true, true);
}

/**
 * 写回文件名列表。
 * 这里不动输出槽——输出槽必须等 syncConnections 把多余连线断干净之后再收，
 * 否则 removeOutput 会先把 link 删掉，encode 侧就留下悬空的 link 引用。
 */
function setAudios(node, files) {
  const list = files.slice(0, MAX_AUDIOS);
  const w = getWidget(node, "audio_files");
  if (w) w.value = JSON.stringify(list);
  node._audios = list.slice();
  // 音频增删后最小高度会变（按已用行数），重新钳一次：
  // 删音频后要顶回去，加音频后要跟着长出来，否则控件会挡住内容。
  const minH = minHeightFor(node);
  if (node.size && node.size[1] < minH) node.size[1] = minH;
  if (node.size && node.size[0] < MIN_NODE_W) node.size[0] = MIN_NODE_W;
  // 音频列表变了：清掉已不存在文件的裁剪区间与缓存，避免残留脏数据
  pruneTrims(node);
  node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- 音频区间裁剪 + 试听
//
// 每条音频有一个可选裁剪区间 [start, end]（秒）：
//   - 不裁剪时 end = null，表示到结尾
//   - 前端在格子里画两条竖线，拖动改区间；**end 必须 > start**
//   - 状态存trims widget（[{"n":文件名,"s":起始,"e":结束}, ...]），
//     后端执行时按这个区间切片。
//   - 点格子试听：从 start 播到 end，再点停止。

/** 读全部裁剪区间，返回 {文件名: {s, e}} */
function readTrims(node) {
  const w = getWidget(node, "trims");
  const out = {};
  if (!w) return out;
  let raw;
  try {
    raw = JSON.parse(w.value || "[]");
  } catch {
    return out;
  }
  if (!Array.isArray(raw)) return out;
  for (const it of raw) {
    if (it && typeof it.n === "string") {
      const s = Number(it.s) || 0;
      let e = it.e == null ? null : Number(it.e);
      if (e != null && !Number.isFinite(e)) e = null;
      out[it.n] = { s, e };
    }
  }
  return out;
}

/** 写回裁剪区间 */
function writeTrims(node, map) {
  const w = getWidget(node, "trims");
  if (!w) return;
  const arr = Object.entries(map).map(([n, t]) => ({ n, s: t.s, e: t.e }));
  w.value = JSON.stringify(arr);
}

/** 取某条音频的区间（没有则给整段 0~null） */
function trimOf(node, name) {
  return readTrims(node)[name] || { s: 0, e: null };
}

/**
 * 设置某条音频的裁剪区间，并强制 end > start。
 * @param {number|null} end 传 null 表示「到结尾」
 * @returns {{s:number,e:number|null}} 实际生效的区间
 */
function setTrim(node, name, start, end, duration) {
  const dur = duration && duration > 0 ? duration : null;
  let s = Math.max(0, Number(start) || 0);
  let e = end == null ? null : Number(end);
  if (dur) s = Math.min(s, dur);
  if (e != null) {
    e = Math.max(0, e);
    if (dur) e = Math.min(e, dur);
    // 结束必须在开始之后；否则顶到 start + 一个最小可见量（或到结尾）
    if (e <= s) {
      e = dur != null && s + 0.05 < dur ? s + 0.05 : dur;
      if (e != null && e <= s) e = null; // 到结尾仍不合法就退回整段
    }
  }
  const map = readTrims(node);
  if (s <= 0 && e == null) delete map[name];
  else map[name] = { s, e };
  writeTrims(node, map);
  node.setDirtyCanvas?.(true, true);
  return { s, e };
}

/** 音频列表变化后，丢掉已不存在文件的区间 */
function pruneTrims(node) {
  const w = getWidget(node, "trims");
  if (!w) return;
  const map = readTrims(node);
  const alive = new Set(node._audios || []);
  let changed = false;
  for (const n of Object.keys(map)) {
    if (!alive.has(n)) {
      delete map[n];
      changed = true;
    }
  }
  if (changed) writeTrims(node, map);
}

// ---------------------------------------------------------------- 时长 / 试听

/**
 * 取音频时长（秒）。用 HTMLAudioElement 读 metadata，不解码整段，开销小。
 * 结果缓存在 node._durations[name]，避免重复加载。
 */
function getDuration(node, name) {
  const cache = (node._durations ||= {});
  if (cache[name] != null) return Promise.resolve(cache[name]);
  return new Promise((resolve) => {
    const el = new Audio();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      cache[name] = v;      // null 表示读不到
      el.src = "";
      resolve(v);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => finish(null);
    // 兜底：有些环境不触发事件，2 秒后按未知处理
    setTimeout(() => finish(cache[name] ?? null), 2000);
    el.src = audioUrl(name);
  });
}

/** 音频访问 URL（与上传接口的 type=input 对应） */
function audioUrl(name) {
  return `/api/view?filename=${encodeURIComponent(name)}&type=input`;
}

/** 正在试听的 {name, start, end, el} */
let previewing = null;

/**
 * 试听：从 start 播到 end。
 * 已在试听同一条-> 停止；试听别的 -> 先停旧的再播新的。
 *
 * 用定时器轮询播放头来判定「到终点」，比 el.onended 可靠——
 * 设了裁剪终点时我们不修改 src，只能靠 currentTime 判断。
 * @returns {boolean} 是否成功开始试听
 */
function togglePreview(node, name) {
  const t = trimOf(node, name);
  if (previewing && previewing.name === name) {
    stopPreview();
    return false;
  }
  stopPreview();

  const el = new Audio();
  el.src = audioUrl(name);
  el.currentTime = Math.max(0, t.s);
  const entry = { name, start: t.s, end: t.e, el, timer: null };
  previewing = entry;

  // 轮询：越过终点就停
  entry.timer = setInterval(() => {
    if (!previewing || previewing !== entry) return;
    const cur = el.currentTime || 0;
    // end 为 null 表示放到结尾，靠 ended 事件收尾
    if (entry.end != null && cur >= entry.end - 0.02) {
      stopPreview();
      return;
    }
    // 播放头移动 -> 重绘（播放头/ 时间显示）
    node.setDirtyCanvas?.(true, true);
  }, 60);

  el.onended = () => {
    if (previewing === entry) stopPreview();
  };
  el.onerror = () => stopPreview();

  const p = el.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => stopPreview());
  }
  node._playing = name;
  node.setDirtyCanvas?.(true, true);
  return true;
}

/** 停止试听 */
function stopPreview() {
  if (!previewing) return;
  const e = previewing;
  previewing = null;
  if (e.timer) {
    clearInterval(e.timer);
    e.timer = null;
  }
  try {
    e.el.pause();
    e.el.currentTime = 0;
    e.el.src = "";
  } catch {
    /* 忽略：停止失败无所谓 */
  }
  // 清掉所有节点上的播放标记
  const g = window.app?.graph;
  if (g?._nodes) {
    for (const n of g._nodes) {
      if (n._playing) {
        n._playing = null;
        n.setDirtyCanvas?.(true, true);
      }
    }
  }
}

// ---------------------------------------------------------------- autogrow 槽位管理

/** 兼容 graph.links 为 Map 或普通对象两种情况 */
function getLink(graph, id) {
  if (!graph || id == null) return null;
  const links = graph.links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(id) ?? null;
  return links[id] ?? null;
}

function targetIdOf(link) {
  return link?.target_id ?? link?.targetNode?.id ?? null;
}

/**
 * 找出该节点里「可以接多个参考音频」的 autogrow 组。
 *
 * 只认组名在 AUTOGROW_GROUPS 白名单里的组，且槽类型必须是 AUDIO。
 * 不能只按槽类型 AUDIO 匹配：H3 的 ref_video_audios 组也是 AUDIO，
 * 但它是「参考视频原声」，接上去是错的。
 *
 * @param {object} node
 * @param {string[]|null} onlyGroups 限定只找这些组名；null = 用白名单
 * @returns {{prefix:string, info:object}|null}
 */
function findAudioAutogrow(node, onlyGroups = null) {
  const ag = node?.comfyDynamic?.autogrow;
  if (!ag) return null;
  const wanted = onlyGroups && onlyGroups.length ? onlyGroups : AUTOGROW_GROUPS;

  for (const prefix of wanted) {
    const info = ag[prefix];
    if (!info) continue;
    const specs = info?.inputSpecs || [];
    if (!specs.length) continue;
    if (!specs.some((s) => String(s.type).toUpperCase().includes("AUDIO"))) continue;
    return { prefix, info };
  }
  return null;
}

/** 兼容旧调用 */
function getAutogrowInfo(node, preferPrefix = "ref_audios") {
  return findAudioAutogrow(node, [preferPrefix]);
}

/**
 * 取组内槽名的「局部前缀」，用于生成第 n 个槽名。
 *  - TemplateNames：names = [...], 1 基
 *  - TemplatePrefix（如 H3）：prefix = "ref_audio_", 0 基
 */
function slotLocalName(groupPrefix, info, ordinal) {
  const names = info?.names;
  if (Array.isArray(names) && names.length) {
    return names[ordinal] ?? `${info?.inputSpecs?.[0]?.name ?? "audio"}_${ordinal + 1}`;
  }
  const p = info?.prefix;
  const base = typeof p === "string" && p.length
    ? p
    : `${(info?.inputSpecs?.[0]?.name ?? groupPrefix)}_`;
  const start = (info?.min ?? 0) > 0 ? info.min : 0;
  return `${base}${start + ordinal}`;
}

/** 该组槽名的尾部数字；非本组返回 null */
function slotTailNumber(groupPrefix, fullName) {
  if (!isGroupSlot(groupPrefix, fullName)) return null;
  const m = fullName.slice(groupPrefix.length + 1).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function isGroupSlot(groupPrefix, fullName) {
  return typeof fullName === "string" && fullName.startsWith(groupPrefix + ".");
}

/** 找出 prefix 组里第 ordinal 个槽位的下标，没有则 -1 */
function findAutogrowSlot(node, groupPrefix, info, ordinal) {
  const want = `${groupPrefix}.${slotLocalName(groupPrefix, info, ordinal)}`;
  for (let i = 0; i < node.inputs.length; i++) {
    if (node.inputs[i].name === want) return i;
  }
  return -1;
}

/** 该组最后一个槽位的下标，没有则 -1 */
function findLastAutogrowSlot(node, groupPrefix) {
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    if (isGroupSlot(groupPrefix, node.inputs[i].name)) return i;
  }
  return -1;
}

/**
 * 保证第 ordinal 个音频槽位存在，返回其下标；没有则 -1。
 *
 * 关键：不要自己 splice 造槽位。前端 autogrow 只认自己创建的槽
 * （自带 display_name，画布上显示短名）。正确做法是借前端自己的扩张逻辑，
 * 这里复刻其最小实现（造带 display_name 的完整槽对象）。
 */
function ensureAutogrowInput(node, groupPrefix, info, ordinal) {
  const direct = findAutogrowSlot(node, groupPrefix, info, ordinal);
  if (direct !== -1) return direct;
  return addAutogrowGroup(node, groupPrefix, info, ordinal);
}

function addAutogrowGroup(node, groupPrefix, info, ordinal) {
  const max = info?.max ?? 16;
  if (ordinal >= max) return -1;
  const specs = info?.inputSpecs || [];
  if (!specs.length) return -1;

  const isOptional = ordinal >= (info?.min ?? 0);
  const local = slotLocalName(groupPrefix, info, ordinal);
  const created = specs.map((spec) => ({
    ...spec,
    name: `${groupPrefix}.${local}`,
    display_name: local,
    isOptional: isOptional || !!spec.isOptional,
    link: null,
  }));

  const at = findLastAutogrowSlot(node, groupPrefix);
  const insertAt = at === -1 ? node.inputs.length : at + 1;

  for (const slot of created) {
    const twin = node.inputs.find((i) => i.name === slot.name && i.link != null);
    if (twin) slot.link = twin.link;
  }

  node.inputs.splice(insertAt, 0, ...created);

  // 插入点之后的 link 目标槽位整体后移
  const graph = node.graph || app.graph;
  for (let i = insertAt; i < node.inputs.length; i++) {
    const inp = node.inputs[i];
    if (inp.link == null) continue;
    const link = getLink(graph, inp.link);
    if (link) link.target_slot = i;
  }

  node.setDirtyCanvas?.(true, true);
  const idx = node.inputs.indexOf(created[0]);
  return idx === -1 ? findAutogrowSlot(node, groupPrefix, info, ordinal) : idx;
}

function disconnectSlot(node, slotIndex) {
  const inp = node.inputs?.[slotIndex];
  if (!inp || inp.link == null) return;
  try {
    if (typeof node.disconnectInput === "function") {
      node.disconnectInput(slotIndex, true);
      return;
    }
    const graph = node.graph || app.graph;
    graph.disconnectInput(node, slotIndex, node);
  } catch (e) {
    console.warn("[TaiYangMultiAudio] 断开失败", e);
  }
}

/**
 * 建链。优先用节点级 connect(outSlot, targetNode, inputSlot)，
 * 它内部会处理 link id 分配 / graph.links 写入 / 两侧 slot 更新 /
 * beforeChange+afterChange / 脏画布 / autogrow 的 onConnectionsChange。
 * 以「输入槽是否真的挂上 link」判定成功，不依赖返回值。
 */
function connectSlot(srcNode, outSlot, dstNode, dstSlotIndex) {
  const inp = dstNode.inputs?.[dstSlotIndex];
  if (!inp || !srcNode.outputs?.[outSlot]) return false;

  if (inp.link != null) {
    const graph = srcNode.graph || app.graph;
    const existing = getLink(graph, inp.link);
    const sameOrigin =
      existing &&
      (existing.origin_id ?? null) === srcNode.id &&
      (existing.origin_slot ?? null) === outSlot;
    if (sameOrigin) return true;
    disconnectSlot(dstNode, dstSlotIndex);
  }

  if (typeof srcNode.connect === "function") {
    try {
      srcNode.connect(outSlot, dstNode, dstSlotIndex);
      if (inp.link != null) return true;
    } catch (e) {
      console.warn("[TaiYangMultiAudio] connect 失败", e);
    }
  }
  if (typeof srcNode.connectSlots === "function") {
    try {
      srcNode.connectSlots(srcNode.outputs[outSlot], inp, dstNode);
      if (inp.link != null) return true;
    } catch (e) {
      console.warn("[TaiYangMultiAudio] connectSlots 失败", e);
    }
  }
  console.warn("[TaiYangMultiAudio] 建链未生效", outSlot, "->", dstNode.type, inp.name);
  return false;
}

// ---------------------------------------------------------------- 自动连线主逻辑

function collectTargets(node) {
  const graph = node.graph || app.graph;
  if (!graph) return [];

  const mode = getMode(node);
  if (mode === MODE_OFF) return [];

  const manual = node._audioManualTarget || null;

  let candidates;
  if (manual) {
    candidates = (graph._nodes || []).filter((n) => n.type === manual);
  } else if (mode === MODE_AUTO) {
    candidates = (graph._nodes || []).filter(
      (n) => n.type !== NODE_NAME && (findAudioAutogrow(n) || STATIC_TARGETS[n.type])
    );
  } else {
    const type = MODE_OPTIONS[mode];
    candidates = (graph._nodes || []).filter((n) => n.type === type);
  }
  if (candidates.length === 0) return [];

  // 「已连过的目标优先」只用来排序，不用来过滤，保证既有连线不被无谓改动
  const linked = new Set();
  for (const out of node.outputs || []) {
    for (const lid of out.links || []) {
      const tid = targetIdOf(getLink(graph, lid));
      if (tid != null) linked.add(tid);
    }
  }
  return [...candidates].sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)));
}

/** 固定槽目标里，第 i 个合法槽名（nameAt）是否匹配；顺带返回其序号 */
function staticOrdinal(type, name) {
  const s = STATIC_TARGETS[type];
  if (!s) return null;
  const max = s.scanMax ?? (s.count + 4);
  for (let i = 0; i < max; i++) {
    if (s.nameAt(i) === name) return i;
  }
  return null;
}

function syncOneTarget(node, target, count) {
  const graph = node.graph || app.graph;
  if (!graph) return;

  // 固定槽分支（如 Star7 的 ref_audio_0/1/2）
  if (STATIC_TARGETS[target.type] && !findAudioAutogrow(target)) {
    const spec = STATIC_TARGETS[target.type];
    const cap = Math.min(count, spec.count, MAX_AUDIOS);
    for (let i = 0; i < cap; i++) {
      const idx = target.inputs.findIndex((x) => x.name === spec.nameAt(i));
      if (idx === -1) continue;
      connectSlot(node, i, target, idx);
    }
    // 多余的固定槽断开
    const snapshot = target.inputs.slice();
    for (const inp of snapshot) {
      const ord = staticOrdinal(target.type, inp.name);
      if (ord === null || ord < cap) continue;
      const idx = target.inputs.indexOf(inp);
      if (idx !== -1 && inp.link != null) disconnectSlot(target, idx);
    }
    target.setDirtyCanvas?.(true, true);
    return;
  }

  // autogrow 分支（如 ReferenceToVideo 的 ref_audios）
  const ag = findAudioAutogrow(target);
  if (!ag) return;
  const { prefix, info } = ag;
  const cap = Math.min(count, info?.max ?? MAX_AUDIOS, MAX_AUDIOS);

  for (let i = 0; i < cap; i++) {
    const idx = ensureAutogrowInput(target, prefix, info, i);
    if (idx === -1) continue;
    connectSlot(node, i, target, idx);
  }

  // 多余的槽位断开（例如音频被删掉了）。先快照再遍历。
  const snapshot = target.inputs.slice();
  for (const inp of snapshot) {
    if (!isGroupSlot(prefix, inp.name)) continue;
    const ord = ordinalOfSlot(prefix, info, inp.name);
    if (ord === null || ord < cap) continue;
    const idx = target.inputs.indexOf(inp);
    if (idx !== -1 && inp.link != null) disconnectSlot(target, idx);
  }

  target.setDirtyCanvas?.(true, true);
}

/** 槽名 -> 本组内序号（0 基）；不是本组返回 null */
function ordinalOfSlot(groupPrefix, info, fullName) {
  if (!isGroupSlot(groupPrefix, fullName)) return null;
  const names = info?.names;
  const local = fullName.slice(groupPrefix.length + 1);
  if (Array.isArray(names) && names.length) {
    const i = names.indexOf(local);
    if (i !== -1) return i;
  }
  for (let ord = 0; ord < (info?.max ?? 16) + 1; ord++) {
    if (slotLocalName(groupPrefix, info, ord) === local) return ord;
  }
  return null;
}

/** 把本节点的音频按顺序连到目标节点 */
function syncConnections(node) {
  const files = getAudioFiles(node);
  if (files.length === 0) {
    const targets = collectTargets(node);
    for (const t of targets) {
      const ag = findAudioAutogrow(t);
      for (const inp of t.inputs?.slice() || []) {
        if (inp.link == null) continue;
        const link = getLink(t.graph || app.graph, inp.link);
        if ((link?.origin_id ?? null) !== node.id) continue;
        const isAutoSlot = ag && isGroupSlot(ag.prefix, inp.name);
        const isStaticSlot = STATIC_TARGETS[t.type] && staticOrdinal(t.type, inp.name) !== null;
        if (!isAutoSlot && !isStaticSlot) continue;
        const idx = t.inputs.indexOf(inp);
        if (idx !== -1) disconnectSlot(t, idx);
      }
    }
    syncOutputSlots(node, 1);
    return;
  }

  const targets = collectTargets(node);
  if (targets.length === 0) {
    console.debug("[TaiYangMultiAudio] 未找到可连接的多音频接入目标节点");
    syncOutputSlots(node, files.length);
    return;
  }

  // 关键顺序：先扩输出槽，再连线，最后收缩
  growOutputSlots(node, files.length);
  for (const t of targets) syncOneTarget(node, t, files.length);
  syncOutputSlots(node, files.length);
}

/** 目标节点刚被创建时，反向把已有音频接上去 */
function syncAllLoaders() {
  const graph = app.graph;
  if (!graph) return;
  for (const n of graph._nodes || []) {
    if (n.type !== NODE_NAME) continue;
    if (getAudioFiles(n).length === 0) continue;
    syncConnections(n);
  }
}

// ---------------------------------------------------------------- 上传

async function uploadOne(file) {
  const fd = new FormData();
  // /upload/image 是 ComfyUI 唯一通用上传端点，表单字段名固定为 "image"，
  // 文件按扩展名落到 input/ 目录，音频同样复用。
  fd.append("image", file);
  fd.append("type", "input");
  const res = await fetch("/upload/image", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// ---------------------------------------------------------------- 节点注册

app.registerExtension({
  name: "ComfyUI.TaiYangMultiAudioLoader",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    // 目标节点：新建时反向触发一次连线（注册期拿不到实例的 autogrow 定义，
    // 统一挂载、由 syncAllLoaders 运行时判断）
    if (nodeData.name !== NODE_NAME) {
      const origTargetCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = origTargetCreated ? origTargetCreated.apply(this, arguments) : undefined;
        setTimeout(() => {
          if (findAudioAutogrow(this) || STATIC_TARGETS[this.type]) syncAllLoaders();
        }, 80);
        return r;
      };
      return;
    }

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated ? origCreated.apply(this, arguments) : undefined;
      this._audios = [];
      this._gridPos = null;
      this._hoverCell = -1;
      // 拖拽状态：_press 待判定 / _drag 确认拖拽 / _anim 让位动画 / _shownOrder 动画起点
      this._press = null;
      this._drag = null;
      this._anim = null;
      this._shownOrder = null;
      this._animRaf = null;

      this.size[0] = NODE_W;
      this.size[1] = NODE_H;

      syncOutputSlots(this, getAudioFiles(this).length || 1);

      const modeWidget = getWidget(this, "auto_link");
      if (modeWidget && typeof modeWidget.value === "number" && !MODE_OPTIONS[modeWidget.value]) {
        modeWidget.value = MODE_AUTO;
      }

      // auto_link / audio_files 两个 widget 都设 hidden：widget 会生成 DOM 覆盖层
      // 挡住网格，所以外观由 onDrawForeground 自绘，点击由 onMouseDown 处理。
      // widget 仍留在 widgets 数组里，后端按名字取值。
      // trims（裁剪区间）同样 hidden：它是内部状态，不该直接暴露给用户编辑。
      const hideWidget = (name) => {
        const w = getWidget(this, name);
        if (!w) return;
        w.dontHide = true;
        w.hidden = true;
        w.computeSize = () => [0, 0];
        w.draw = () => {};
      };
      hideWidget("audio_files");
      hideWidget("trims");
      if (modeWidget) {
        modeWidget.hidden = true;
        modeWidget.computeSize = () => [0, 0];
        modeWidget.draw = () => {};
      }

      // 异步读取每条音频的时长（画竖线要用）
      (this._audios || []).forEach((n) => getDuration(this, n));

      return r;
    };

    // 载入工作流时还原文件列表
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;

      const w = getWidget(this, "audio_files");
      if ((!w || !w.value || w.value === "[]") && this.properties?.audio_files) {
        if (w) w.value = this.properties.audio_files;
      }
      this._audioManualTarget = this.properties?.auto_link_target || null;
      this._audios = getAudioFiles(this).slice();

      // 裁剪区间：从 widget 读，老工作流则从 properties 兜底
      const tw = getWidget(this, "trims");
      if ((!tw || !tw.value || tw.value === "[]") && this.properties?.trims) {
        if (tw) tw.value = this.properties.trims;
      }
      this._durations = {};
      // 读时长，画竖线要用
      (this._audios || []).forEach((n) => getDuration(this, n));

      const linkedCount = (this.outputs || []).filter((o) => (o.links || []).length > 0).length;
      syncOutputSlots(this, Math.max(this._audios.length, linkedCount));

      // 老工作流可能存着过窄的宽度，这里强制拉齐宽度；
      // 高度不按 NODE_H 拉满——最小高度是动态的（按已用行数），
      // 音频少时节点应该允许更矮。clampNodeSize 负责兜下限。
      clampNodeSize(this);
      if (this.size[0] < NODE_W) this.size[0] = NODE_W;
      this.setDirtyCanvas?.(true, true);

      setTimeout(() => syncConnections(this), 0);
      return r;
    };

    /**
     * 手动缩放节点时钳住最小尺寸。
     * 缩到小于「网格 + 底部控件区」时，底部控件会和图片重叠，这里直接顶回下限。
     */
    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origResize ? origResize.apply(this, arguments) : undefined;
      clampNodeSize(this);
      this.setDirtyCanvas?.(true, true);
      return r;
    };

    const origSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function () {
      if (this.properties) {
        this.properties.audio_files = getWidget(this, "audio_files")?.value ?? "[]";
        // 保存裁剪区间，下次载入仍然生效
        this.properties.trims = getWidget(this, "trims")?.value ?? "[]";
        if (this._audioManualTarget) this.properties.auto_link_target = this._audioManualTarget;
        else delete this.properties.auto_link_target;
      }
      return origSerialize ? origSerialize.apply(this, arguments) : this;
    };

    // 菜单：手动指定目标 / 重连 / 断开
    const origMenu = nodeType.prototype.getNodeMenuItems;
    nodeType.prototype.getNodeMenuItems = function (opts) {
      const items = origMenu ? origMenu.apply(this, arguments) : [];

      const graph = this.graph || app.graph;
      const present = [...new Set((graph?._nodes || []).map((n) => n.type))].filter(
        (t) => t && t !== NODE_NAME
      );
      const capable = present.filter((t) => {
        const n = (graph._nodes || []).find((x) => x.type === t);
        return n && (findAudioAutogrow(n) || STATIC_TARGETS[t]);
      });
      const others = present.filter((t) => !capable.includes(t));

      const pickTarget = (node, type) => {
        node._audioManualTarget = type;
        syncConnections(node);
        node.setDirtyCanvas(true, true);
      };
      const backToAuto = (node) => {
        node._audioManualTarget = null;
        syncConnections(node);
        node.setDirtyCanvas(true, true);
      };
      const asRows = (types, node) => [
        ...types.map((t) => ({
          content: `　→ ${t}${node._audioManualTarget === t ? "  ✓当前" : ""}`,
          callback: () => pickTarget(node, t),
        })),
        { content: "　↩ 回到自动发现", callback: () => backToAuto(node) },
      ];

      items.push({
        content: "🔗 重新自动连线",
        callback: () => {
          syncConnections(this);
          this.setDirtyCanvas(true, true);
        },
      });

      if (capable.length) {
        items.push({
          content: `🎯 指定多音频目标${this._audioManualTarget ? `（当前：${this._audioManualTarget}）` : ""}`,
          callback: () => items.push(...asRows(capable, this)),
        });
      }
      if (others.length) {
        items.push({
          content: `🧩 指定其他节点为目标${this._audioManualTarget && others.includes(this._audioManualTarget) ? `（当前：${this._audioManualTarget}）` : ""}`,
          callback: () => items.push(...asRows(others, this)),
        });
      }
      if (this._audioManualTarget) {
        items.push({
          content: "↩ 目标改回自动发现",
          callback: () => backToAuto(this),
        });
      }
      items.push({
        content: "⛓ 断开本节点的全部连线",
        callback: () => {
          const graph = this.graph || app.graph;
          for (const out of this.outputs || []) {
            for (const lid of [...(out.links || [])]) {
              const link = getLink(graph, lid);
              if (!link) continue;
              const tid = targetIdOf(link);
              const tnode = tid != null ? graph.getNodeById(tid) : null;
              if (tnode && tnode.inputs) {
                const idx = tnode.inputs.findIndex((x) => x.link === lid);
                if (idx !== -1) disconnectSlot(tnode, idx);
              }
            }
          }
          this.setDirtyCanvas(true, true);
        },
      });
      return items;
    };

    // ------------------------------------------------------------ 绘制
    const GRID = { cell: CELL, gap: GAP, cols: COLS, startX: START_X, startY: HEADER_H };

    const origDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origDraw?.apply(this, arguments);

      // 折叠时必须整体跳过自绘：LiteGraph 折叠后仍会调用 onDrawForeground，
      // 若继续画，网格与底部条会跑到节点框外的画布上（节点只剩一条标题栏）。
      if (isCollapsed(this)) return;

      // 节点被手动缩小后，布局常量（NODE_W/NODE_H）会大于实际尺寸，
      // 自绘内容就会溢出到节点框外。这里 clip 到节点真实范围，收尾 restore。
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.size[0], this.size[1]);
      ctx.clip();

      const audios = this._audios || [];
      const { cell, gap, cols, startX, startY } = GRID;
      this._gridPos = { ...GRID };

      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";

      // 按「有连线的输出槽个数」计数，不能按 link 条数累加
      let linked = 0;
      const graph = this.graph || app.graph;
      for (const out of this.outputs || []) {
        const hasLive = (out.links || []).some((lid) => getLink(graph, lid));
        if (hasLive) linked++;
      }

      const gridW = COLS * CELL + (COLS - 1) * GAP;
      const centerX = START_X + gridW / 2;

      ctx.fillStyle = "#8fd0ff";
      ctx.font = "bold 13px Arial";
      ctx.fillText(`参考音频 ${audios.length}/${MAX_AUDIOS}   已连线 ${linked}`, centerX, startY - 34);

      const manual = this._audioManualTarget;
      const dragging = !!this._drag;
      ctx.fillStyle = dragging
        ? "#ffd479"
        : linked === audios.length && audios.length > 0
          ? "#8fe08f"
          : "#c8c8c8";
      ctx.font = "12px Arial";
      ctx.fillText(
        audios.length === 0
          ? `点击下方 + 添加音频（可多选，最多 ${MAX_AUDIOS} 个）`
          : dragging
            ? "松开放置 · 顺序改变后连线会自动跟随"
            : linked === audios.length
              ? `✓ 已连接${manual ? " " + manual : " 多音频节点"} · 可拖动音频调顺序`
              : `还有 ${audios.length - linked} 个未连接`,
        centerX,
        startY - 16
      );

      // ------------------------------------------------------------------
      // 绘制音频网格（含拖拽让位动画）。统一模型 order[p]=位置p放原来第几个。
      // ------------------------------------------------------------------
      const count = audios.length;
      const drag = this._drag;
      const targetOrder =
        (drag ? computeOrder(count, drag.from, drag.to) : null) || identityOrder(count);
      const anim = this._anim;
      const fromOrder = anim ? anim.fromOrder : targetOrder;
      const toOrder = anim ? anim.toOrder : targetOrder;
      const t = anim ? anim.t : 1;

      const cx = (i) => startX + (i % cols) * (cell + gap);
      const cy = (i) => startY + Math.floor(i / cols) * (cell + gap);

      for (let i = 0; i < count; i++) {
        const slotFrom = fromOrder.indexOf(i);
        const slotTo = toOrder.indexOf(i);
        const x = cx(slotFrom) + (cx(slotTo) - cx(slotFrom)) * t;
        const y = cy(slotFrom) + (cy(slotTo) - cy(slotFrom)) * t;

        const isHover = this._hoverCell === i;
        const isGrabbed = !!drag && drag.from === i;
        const isShifted = slotFrom !== slotTo;

        ctx.fillStyle = isGrabbed ? "rgba(20,26,34,0.5)" : isShifted ? "#223244" : isHover ? "#3a3a3a" : "#1d2530";
        ctx.beginPath();
        ctx.roundRect(x, y, cell, cell, 6);
        ctx.fill();
        ctx.strokeStyle = isGrabbed
          ? "#6f7c88"
          : isShifted
            ? "#5fe08f"
            : isHover
              ? "#7fbfff"
              : "#4a7fb5";
        ctx.lineWidth = isShifted || isHover ? 2 : 1;
        if (isGrabbed) ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // ------------------------------------------------------------------
        // 音频格子：波形区 + 两条裁剪竖线（起点 / 终点）+ 文件名
        //
        // 波形区内：
        //   选中区间（start~end）高亮，两侧灰暗
        //   两条竖线可拖动：左=起点，右=终点（终点只能在起点右边）
        //   正在试听时显示播放头
        // ------------------------------------------------------------------
        const name = audios[i];
        const trims = readTrims(this);
        const tr = trims[name] || { s: 0, e: null };
        const dur = (this._durations || {})[name] || 0;
        const playing = this._playing === name;

        const FILEBAR_H = 18;       // 底部文件名条
        const waveTop = y + 26;     // 波形区上沿（留出顶部标题空间）
        const waveH = cell - 26 - FILEBAR_H - 4;
        const waveX = x + 8;
        const waveW = cell - 16;

        // 格子底部：区间秒数
        ctx.fillStyle = "rgba(220,230,240,0.85)";
        ctx.font = "11px Arial";
        ctx.textAlign = "center";
        ctx.fillText(truncateName(name, 15), x + cell / 2, y + cell - 7);

        // 波形区底板
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.beginPath();
        ctx.roundRect(waveX, waveTop, waveW, waveH, 3);
        ctx.fill();

        if (dur > 0) {
          // 有时长才能定位竖线
          const sx = waveX + (tr.s / dur) * waveW;
          const ex = tr.e != null ? waveX + (tr.e / dur) * waveW : waveX + waveW;

          // 区间外灰暗、区间内高亮
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(waveX, waveTop, Math.max(0, sx - waveX), waveH);
          ctx.fillRect(Math.min(ex, waveX + waveW), waveTop, Math.max(0, waveX + waveW - ex), waveH);
          ctx.fillStyle = "rgba(143,224,143,0.16)";
          ctx.fillRect(sx, waveTop, Math.max(0, ex - sx), waveH);

          // 两条竖线
          const dragStart = this._dragTrim?.name === name && this._dragTrim.which === "s";
          const dragEnd = this._dragTrim?.name === name && this._dragTrim.which === "e";

          // 起点线
          ctx.strokeStyle = dragStart ? "#ffd479" : "#8fe08f";
          ctx.lineWidth = dragStart ? 3 : 2;
          ctx.beginPath();
          ctx.moveTo(sx, waveTop);
          ctx.lineTo(sx, waveTop + waveH);
          ctx.stroke();
          // 起点手柄（小三角）
          ctx.fillStyle = dragStart ? "#ffd479" : "#8fe08f";
          ctx.beginPath();
          ctx.moveTo(sx, waveTop);
          ctx.lineTo(sx - 5, waveTop - 7);
          ctx.lineTo(sx + 5, waveTop - 7);
          ctx.closePath();
          ctx.fill();

          // 终点线
          ctx.strokeStyle = dragEnd ? "#ffd479" : "#8fd0ff";
          ctx.lineWidth = dragEnd ? 3 : 2;
          ctx.beginPath();
          ctx.moveTo(ex, waveTop);
          ctx.lineTo(ex, waveTop + waveH);
          ctx.stroke();
          ctx.fillStyle = dragEnd ? "#ffd479" : "#8fd0ff";
          ctx.beginPath();
          ctx.moveTo(ex, waveTop + waveH);
          ctx.lineTo(ex - 5, waveTop + waveH + 7);
          ctx.lineTo(ex + 5, waveTop + waveH + 7);
          ctx.closePath();
          ctx.fill();

          // 试听播放头
          if (playing && previewing) {
            const t = Math.min(previewing.el.currentTime || 0, previewing.end ?? dur);
            const px = waveX + ((t - tr.s) / Math.max(0.001, (tr.e ?? dur) - tr.s)) * (ex - sx);
            if (px >= sx && px <= ex) {
              ctx.fillStyle = "#ffd479";
              ctx.fillRect(px - 1, waveTop, 2, waveH);
            }
          }
        } else {
          // 时长未知：画音符占位，并提示点击可试听
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = isGrabbed ? "#9aa7b3" : "#8fd0ff";
          ctx.font = `${Math.round(cell * 0.26)}px Arial`;
          ctx.fillText(playing ? "■" : "♪", x + cell / 2, waveTop + waveH / 2);
          ctx.textBaseline = "alphabetic";
        }

        // 区间秒数（贴波形区上方右侧）
        if (dur > 0) {
          const seg =
            tr.e != null
              ? `${tr.s.toFixed(2)}s → ${tr.e.toFixed(2)}s`
              : tr.s > 0
                ? `${tr.s.toFixed(2)}s → 结尾`
                : "整段";
          ctx.fillStyle = tr.e != null || tr.s > 0 ? "#8fe08f" : "#7d8894";
          ctx.font = "10px Arial";
          ctx.textAlign = "right";
          ctx.fillText(seg, x + cell - 8, waveTop - 4);
        }

        // 序号角标
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.font = "bold 12px Arial";
        ctx.textAlign = "center";
        ctx.fillText(String(i + 1), x + 16, y + 18);

        // 删除按钮：拖拽期间隐藏
        if (!drag) {
          const bx = x + cell - 16;
          const by = y + 16;
          ctx.fillStyle = "#e04b4b";
          ctx.beginPath();
          ctx.arc(bx, by, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(bx - 4, by - 4);
          ctx.lineTo(bx + 4, by + 4);
          ctx.moveTo(bx + 4, by - 4);
          ctx.lineTo(bx - 4, by + 4);
          ctx.stroke();
        }
      }

      // 加号格：固定排在所有音频后面
      if (count < MAX_AUDIOS) {
        const ax = cx(count);
        const ay = cy(count);
        const isHover = this._hoverCell === count;
        ctx.fillStyle = isHover ? "#3a3a3a" : "#2a2a2a";
        ctx.beginPath();
        ctx.roundRect(ax, ay, cell, cell, 6);
        ctx.fill();
        ctx.strokeStyle = isHover ? "#7fbfff" : "#4a4a4a";
        ctx.lineWidth = isHover ? 2 : 1;
        ctx.stroke();
        ctx.strokeStyle = isHover ? "#8fd0ff" : "#666";
        ctx.lineWidth = 3;
        const c = cell / 2;
        const r = 22;
        ctx.beginPath();
        ctx.moveTo(ax + c - r, ay + c);
        ctx.lineTo(ax + c + r, ay + c);
        ctx.moveTo(ax + c, ay + c - r);
        ctx.lineTo(ax + c, ay + c + r);
        ctx.stroke();
        ctx.fillStyle = "#888";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.fillText("添加音频", ax + c, ay + c + 44);
      }

      // ---------------------------------------------------------- 底部模式条
      // 宽度跟随节点实际宽度，位置用 bottomLayout 贴着节点底边（随缩放一起动）。
      const bw = Math.max(80, this.size[0] - 24);
      const bh = BAR_H;
      const bx = 12;
      const by = bottomLayout(this.size[1]).modeY;
      this._modeBar = { x: bx, y: by, w: bw, h: bh };

      const hovering = this._hoverBar === true;
      ctx.fillStyle = hovering ? "#3d4a58" : "#2a2f36";
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fill();
      ctx.strokeStyle = hovering ? "#8fd0ff" : "#4a5560";
      ctx.lineWidth = 1;
      ctx.stroke();

      const label = manual
        ? `auto_link：自动 → ${manual}`
        : `auto_link：${MODE_OPTIONS[getMode(this)]}`;
      ctx.fillStyle = hovering ? "#eaf6ff" : "#c8d2dc";
      ctx.font = "12px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
      ctx.fillStyle = hovering ? "#8fd0ff" : "#7d8894";
      ctx.beginPath();
      ctx.moveTo(bx + bw - 20, by + bh / 2 - 4);
      ctx.lineTo(bx + bw - 10, by + bh / 2 - 4);
      ctx.lineTo(bx + bw - 15, by + bh / 2 + 3);
      ctx.closePath();
      ctx.fill();
      ctx.textBaseline = "alphabetic";

      // 解除上面设置的裁剪（见函数开头的 clip）
      ctx.restore();
    }

    /**
     * 命中判定的前置条件：坐标必须落在节点真实范围内。
     * 节点被手动缩小后，布局常量算出的格子/控制条可能已在框外，此时不能响应点击。
     */
    const withinNode = function (node, pos) {
      if (isCollapsed(node)) return false;
      const w = node?.size?.[0] ?? 0;
      const h = node?.size?.[1] ?? 0;
      return pos[0] >= 0 && pos[0] <= w && pos[1] >= 0 && pos[1] <= h;
    };

    /** 底部模式条的命中判定 */
    const barAt = function (node, pos) {
      const b = node._modeBar;
      if (!b || !withinNode(node, pos)) return false;
      return pos[0] >= b.x && pos[0] <= b.x + b.w && pos[1] >= b.y && pos[1] <= b.y + b.h;
    };

    // ------------------------------------------------------------ 鼠标
    /**
     * 裁剪竖线命中判定：返回 {index, which} 或 null。
     * which = "s" 起点线、"e" 终点线。
     * 命中容差 6px，两条线都命中时取更近的那条。
     * 格子在拖拽换位时不响应。
     */
    const hitTrim = function (node, pos) {
      if (node._drag) return null;
      const { cell, gap, cols, startX, startY } = GRID;
      const audios = node._audios || [];
      const i = cellAt(node, pos);
      if (i < 0 || i >= audios.length) return null;

      const name = audios[i];
      const dur = (node._durations || {})[name] || 0;
      if (!(dur > 0)) return null;

      const x = startX + (i % cols) * (cell + gap);
      const y = startY + Math.floor(i / cols) * (cell + gap);
      const FILEBAR_H = 18;
      const waveTop = y + 26;
      const waveH = cell - 26 - FILEBAR_H - 4;
      // y 必须落在波形区内（含上下的手柄余量）
      if (pos[1] < waveTop - 8 || pos[1] > waveTop + waveH + 8) return null;

      const waveX = x + 8;
      const waveW = cell - 16;
      const tr = trimOf(node, name);
      const sx = waveX + (tr.s / dur) * waveW;
      const ex = tr.e != null ? waveX + (tr.e / dur) * waveW : waveX + waveW;

      const ds = Math.abs(pos[0] - sx);
      const de = Math.abs(pos[0] - ex);
      const TOL = 6;
      if (ds <= TOL && (ds <= de || de > TOL)) return { index: i, which: "s", name, dur };
      if (de <= TOL) return { index: i, which: "e", name, dur };
      return null;
    };

    /**
     * 把横坐标换算成秒（限制在 0~duration）。
     */
    const xToSeconds = function (node, pos, index, dur) {
      const { cell, gap, cols, startX, startY } = GRID;
      const x = startX + (index % cols) * (cell + gap);
      const y = startY + Math.floor(index / cols) * (cell + gap);
      const waveX = x + 8;
      const waveW = cell - 16;
      const ratio = (pos[0] - waveX) / waveW;
      return Math.max(0, Math.min(dur, ratio * dur));
    };

    /** 格子命中判定：音频格 0..n-1，加号格固定是 n */
    const cellAt = function (node, pos) {
      if (!withinNode(node, pos)) return -1;
      const { cell, gap, cols, startX, startY } = GRID;
      const n = (node._audios || []).length;
      const total = n < MAX_AUDIOS ? n + 1 : n;
      for (let i = 0; i < total; i++) {
        const x = startX + (i % cols) * (cell + gap);
        const y = startY + Math.floor(i / cols) * (cell + gap);
        if (pos[0] >= x && pos[0] <= x + cell && pos[1] >= y && pos[1] <= y + cell) return i;
      }
      return -1;
    };

    /** 推进让位动画：每次以「当前显示顺序」为起点，连贯衔接不跳 */
    const animateTo = function (node, toOrder) {
      const fromOrder = node._anim ? node._anim.toOrder : node._shownOrder || toOrder;
      node._shownOrder = toOrder;
      node._anim = { fromOrder, toOrder, t: 0 };
      if (node._animRaf != null) cancelAnim(node);
      const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      const step = () => {
        if (!node._anim) return;
        node._anim.t += 0.28;
        if (node._anim.t >= 1) {
          node._anim = null;
          node._animRaf = null;
          node.setDirtyCanvas(true, true);
          return;
        }
        node.setDirtyCanvas(true, true);
        node._animRaf = raf(step);
      };
      node._animRaf = raf(step);
    };

    const cancelAnim = function (node) {
      if (node._animRaf == null) return;
      const cancel = window.cancelAnimationFrame;
      if (cancel) cancel(node._animRaf);
      node._animRaf = null;
    };

    /** 彻底清掉拖拽相关状态 */
    const resetDrag = function (node) {
      cancelAnim(node);
      node._press = null;
      node._drag = null;
      node._anim = null;
      node._shownOrder = null;
      node.setDirtyCanvas(true, true);
    };

    const origMove = nodeType.prototype.onMouseMove;
    nodeType.prototype.onMouseMove = function (e, pos) {
      // 折叠时不更新 hover / 拖拽，自绘区域已不再显示
      if (isCollapsed(this)) return origMove?.apply(this, arguments);

      // 0) 正在拖裁剪竖线：实时更新区间（终点只允许在起点右侧）
      if (this._dragTrim) {
        const { name, which, index, dur } = this._dragTrim;
        const secs = xToSeconds(this, pos, index, dur);
        const tr = trimOf(this, name);
        if (which === "s") {
          // 起点不能越过终点
          const limit = tr.e != null ? tr.e - 0.01 : dur;
          setTrim(this, name, Math.min(secs, limit), tr.e, dur);
        } else {
          // 终点必须严格在起点右侧
          setTrim(this, name, tr.s, Math.max(secs, tr.s + 0.01), dur);
        }
        // 拖动时把播放头反馈出来
        this.setDirtyCanvas(true, true);
        return true;
      }

      // 1) 已按下未越阈值：等越过 DRAG_THRESHOLD 才升级为拖拽（单击无动作）
      if (this._press && !this._drag) {
        const dx = pos[0] - this._press.x;
        const dy = pos[1] - this._press.y;
        if (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD) {
          this._drag = { from: this._press.from, to: this._press.from };
          this._press = null;
          this.setDirtyCanvas(true, true);
          return true;
        }
        return true;
      }

      // 2) 拖拽中：更新落点，变了就重播让位动画
      if (this._drag) {
        const over = cellAt(this, pos);
        const n = (this._audios || []).length;
        const target = over >= 0 && over < n ? over : this._drag.to;
        if (target !== this._drag.to) {
          this._drag.to = target;
          const next = computeOrder(n, this._drag.from, target);
          if (next) animateTo(this, next);
        }
        return true;
      }

      // 3) 普通悬停
      const hov = cellAt(this, pos);
      if (hov !== this._hoverCell) {
        this._hoverCell = hov;
        this.setDirtyCanvas(true, true);
      }
      const onBar = barAt(this, pos);
      if (onBar !== this._hoverBar) {
        this._hoverBar = onBar;
        this.setDirtyCanvas(true, true);
      }

      // 悬停在竖线上时改光标，提示可以拖动
      if (!this._dragTrim) {
        const onTrim = !!hitTrim(this, pos);
        if (onTrim !== this._hoverTrim) {
          this._hoverTrim = onTrim;
          const c = this.canvas;
          if (c) c.style.cursor = onTrim ? "ew-resize" : "";
        }
      }
      return origMove?.apply(this, arguments);
    };

    const origUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function (e, pos) {
      // 0) 裁剪竖线拖动结束
      if (this._dragTrim) {
        this._dragTrim = null;
        // 拖完恢复光标
        if (this.canvas) this.canvas.style.cursor = "";
        this.setDirtyCanvas(true, true);
        return true;
      }

      // 1) 单击：静默复位
      if (this._press) {
        resetDrag(this);
        return true;
      }

      // 2) 拖拽结束：落盘顺序 + 重建连线
      if (this._drag) {
        const { from, to } = this._drag;
        const audios = this._audios || [];
        const willReorder = to != null && to >= 0 && to < audios.length && to !== from;
        resetDrag(this);
        if (willReorder) {
          setAudios(this, reorderList(audios, from, to));
          syncConnections(this);
        }
        return true;
      }

      return origUp?.apply(this, arguments);
    };

    const origDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      // 折叠时节点只剩标题栏，自绘区域全部不可交互，直接交回 LiteGraph
      if (isCollapsed(this)) return origDown?.apply(this, arguments);

      // 底部模式条：左键在「自动 / 关闭」间切换；有手动目标时先清掉手动目标
      if (barAt(this, pos)) {
        if (this._audioManualTarget) {
          this._audioManualTarget = null;
          if (this.properties) delete this.properties.auto_link_target;
        } else {
          const w = getWidget(this, "auto_link");
          if (w) w.value = getMode(this) === MODE_OFF ? MODE_AUTO : MODE_OFF;
        }
        syncConnections(this);
        this.setDirtyCanvas(true, true);
        return true;
      }

      const i = cellAt(this, pos);
      if (i === -1) return origDown?.apply(this, arguments);

      const audios = this._audios || [];
      const { cell, gap, cols, startX, startY } = GRID;
      const x = startX + (i % cols) * (cell + gap);
      const y = startY + Math.floor(i / cols) * (cell + gap);

      if (i < audios.length) {
        // 右上角删除按钮（优先于一切）
        const bx = x + cell - 16;
        const by = y + 16;
        const dx = pos[0] - bx;
        const dy = pos[1] - by;
        if (dx * dx + dy * dy < 12 * 12) {
          const next = audios.slice();
          next.splice(i, 1);
          setAudios(this, next);
          syncConnections(this);
          return true;
        }

        // 裁剪竖线：按住拖动调整起点/终点（优先级高于拖拽排序与试听）
        const hit = hitTrim(this, pos);
        if (hit && (e?.button === 0 || e?.button == null)) {
          this._dragTrim = { name: hit.name, which: hit.which, index: hit.index, dur: hit.dur };
          this._press = null;
          this.setDirtyCanvas(true, true);
          return true;
        }

        // 点击格子 = 试听（从起点播到终点）；再点一次停止
        if (e?.button === 0 || e?.button == null) {
          togglePreview(this, audios[i]);
          // 试听点击不进入排序拖拽（单击无副作用）
          return true;
        }
      } else {
        if (audios.length >= MAX_AUDIOS) return true;
      }

      // 点在加号格 -> 打开文件选择，追加到末尾
      const insertAt = audios.length;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/*";
      input.multiple = true;
      input.onchange = async () => {
        const picked = Array.from(input.files || []);
        if (picked.length === 0) return;
        const uploaded = [];
        for (const f of picked) {
          try {
            uploaded.push(await uploadOne(f));
          } catch (err) {
            console.error("[TaiYangMultiAudio] 上传失败:", f.name, err);
          }
        }
        if (uploaded.length === 0) return;
        const next = audios.slice();
        uploaded.forEach((nm, k) => {
          next[insertAt + k] = nm;
        });
        setAudios(this, next.filter(Boolean).slice(0, MAX_AUDIOS));
        syncConnections(this);
      };
      input.click();
      return true;
    };
  },
});