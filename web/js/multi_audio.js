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
// 上下排列的长条形（单列）：每条音频占一整行，波形区长而扁，操作面积大。
// 早期是 4 列方格，格子只有 130px 宽，竖线和刻度挤在一起不好点。
const ROW_H = 64; // 每条音频长条的高度
const ROW_GAP = 8; // 条与条之间的间距
const COLS = 1; // 单列：一列到底
const START_X = 20;
const HEADER_H = 62; // 顶部标题 + 状态文字
// 行数上限 = 音频数 + 1 个「添加音频」条
const GRID_ROWS = MAX_AUDIOS + 1;
const GRID_H = GRID_ROWS * ROW_H + (GRID_ROWS - 1) * ROW_GAP;
// 右侧留出输出槽标签宽度（audio_1 / audio_8），否则标签会压在长条上
const SLOT_DOT_W = 12;
const SLOT_LABEL_W = 62;
const RIGHT_PAD = SLOT_DOT_W + SLOT_LABEL_W;
// 节点默认宽度：单列长条要够长才好操作，比原来的方格布局宽不少
const NODE_W = 440;
// 拖拽判定阈值（px）：按下后移动超过它才算真拖，单击无动作
const DRAG_THRESHOLD = 8;

/**
 * 长条宽度：跟随节点实际宽度（用户可横向拉宽/拉窄）。
 */
function rowWidthOf(node) {
  const w = node?.size?.[0] ?? NODE_W;
  return Math.max(160, w - START_X * 2 - RIGHT_PAD);
}

/** 第 i 条的水平起点（单列，恒为 START_X） */
const rowX = () => START_X;

/** 第 i 条的垂直起点（从上往下累加） */
const rowY = (i) => HEADER_H + i * (ROW_H + ROW_GAP);

/**
 * 参考音频过长阈值（秒）。
 * MiniMax H3 的 length 训练范围约 124~362 帧（≈5.2~15.1 秒），
 * 参考音频若远长于生成时长，音频潜变量会比输出长好几倍，
 * 音色特征被稀释——表现为「感觉没参考这个音色」。
 * 超过此值在节点里用橙色 ⚠ 标出，提醒裁一段纯人声。
 */
const LONG_REF_AUDIO_SEC = 15;

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
const NODE_H = WIDGET_TOP_GAP + WIDGET_H + 10;
// 底部auto_link 条的高度
const BAR_H = 24;
const BAR_GAP = 6;
// 底部控件区总高度
const BOTTOM_BLOCK_H = BAR_H + BAR_GAP * 2;
// 节点最小宽度
const MIN_NODE_W = 320;

/**
 * 按**实际条数**算最小高度。
 * 长条只画到有内容的那几条，所以音频少时节点可以缩得很矮——
 * 只要「已用长条 + 底部控件区」能放下就行，不遮挡当前已有的音频。
 */
function minHeightFor(node) {
  const n = (node?._audios || []).length;
  // 有音频就多留一个「添加音频」条的位置
  const used = Math.max(1, n < MAX_AUDIOS ? n + 1 : n);
  const listH = used * ROW_H + (used - 1) * ROW_GAP;
  return HEADER_H + listH + BOTTOM_BLOCK_H;
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
  // DOM 面板模式下尺寸由面板自己算，这里不要插手
  if (node.__tyDomPanel) return node;
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
  const oldNames = (node._audios || []).slice();
  // **必须在改 _audios 之前读旧区间**：readTrims 按 _audios.length 截断，
  // 等列表改了再读，被删文件后面的区间会被挤掉/错位。
  const oldTrims = readTrims(node);
  node._prevAudios = oldNames;
  const w = getWidget(node, "audio_files");
  if (w) w.value = JSON.stringify(list);
  node._audios = list.slice();
  // 音频增删后最小高度会变（按已用行数），重新钳一次：
  // 删音频后要顶回去，加音频后要跟着长出来，否则控件会挡住内容。
  // DOM 面板下高度由面板控制，别在这里改 size。
  if (!node.__tyDomPanel) {
    const minH = minHeightFor(node);
    if (node.size && node.size[1] < minH) node.size[1] = minH;
    if (node.size && node.size[0] < MIN_NODE_W) node.size[0] = MIN_NODE_W;
  }
  // 音频列表变了：按新顺序重新对齐裁剪区间（同名音频也各自独立）
  pruneTrims(node, oldNames, oldTrims);
  // **预取音频数据**：新上传的音频必须有时长才会画裁剪竖线与时间刻度。
  // 只走解码（getAudioBuffer）——**不要先读 metadata**：
  // HTMLAudioElement.duration 对 MP3 只是按码率估算，可能差好几秒。
  // 若让估算值先占位，竖线会先画在错位置，解码完成后又跳一下；
  // 更糟的是缓存命中不回填时，估算值会一直留着，导致竖线和试听长期对不上。
  // 解码失败时 getAudioBuffer 内部会自己退回 metadata 兜底。
  (list || []).forEach((n) => {
    getAudioBuffer(node, n);
  });
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
/**
 * 读裁剪区间：返回**与 _audios 按位置对齐**的数组，下标即槽位号。
 * 这样「音频1 和音频3 是同一个文件」也各自独立，不会互相同步。
 *
 * 兼容旧格式：早先版本按文件名存 `[{"n":名字,"s":..,"e":..}]`，
 * 这里把它迁移到首个同名槽位上（只读一次，之后写回就是新格式）。
 */
function readTrims(node) {
  const w = getWidget(node, "trims");
  const names = node._audios || [];
  const out = new Array(names.length).fill(null);
  if (!w) return out;
  let raw;
  try {
    raw = JSON.parse(w.value || "[]");
  } catch {
    return out;
  }
  if (!Array.isArray(raw)) return out;
  raw.forEach((it, i) => {
    if (it && typeof it === "object" && typeof it.n === "string") {
      // 旧格式：按文件名，落到第一个还没被占的同名槽位
      const idx = names.indexOf(it.n);
      if (idx >= 0 && out[idx] === null) out[idx] = normTrim(it);
      return;
    }
    if (i < out.length) out[i] = normTrim(it);
  });
  return out;
}

/** 归一化单条区间；整段 / 非法值统一返回 null（end=null 表示「到结尾」） */
function normTrim(it) {
  if (!it || typeof it !== "object") return null;
  let s = Number(it.s);
  if (!Number.isFinite(s) || s < 0) s = 0;
  let e = it.e == null ? null : Number(it.e);
  // end 非法或 <= start：置 null（表示不裁剪到结尾，保留 start 生效）
  if (e != null && (!Number.isFinite(e) || e <= s)) e = null;
  // 完全没裁剪（start=0 且到结尾）才算整段
  return s <= 0 && e == null ? null : { s, e };
}

/** 写回裁剪区间（数组按位置对齐，null 表示整段） */
function writeTrims(node, arr) {
  const w = getWidget(node, "trims");
  if (!w) return;
  w.value = JSON.stringify(arr.slice(0, (node._audios || []).length));
}

/** 取第 index 个槽位的区间（没有则给整段 0~null） */
function trimAt(node, index) {
  return readTrims(node)[index] || { s: 0, e: null };
}

/**
 * 设置第 index 个槽位的裁剪区间，并强制 end > start。
 * @param {number|null} end 传 null 表示「到结尾」
 * @returns {{s:number,e:number|null}} 实际生效的区间
 */
function setTrim(node, index, start, end, duration) {
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
  const arr = readTrims(node);
  while (arr.length <= index) arr.push(null);
  arr[index] = s <= 0 && e == null ? null : { s, e };
  writeTrims(node, arr);
  node.setDirtyCanvas?.(true, true);
  return { s, e };
}

/**
 * 音频列表变化后重新对齐裁剪区间。
 * 关键：同名文件也要**按槽位**区分，不能让两条相同音频共享区间。
 * 规则：
 *   1) 位置和文件名都没变 -> 区间跟随（常见：增删、点上传）
 *   2) 文件名相同但位置变了（拖拽排序）-> 区间跟着文件走
 *   3) 新出现的文件 -> 区间为空
 */
function realignTrims(oldNames, newNames, oldTrims) {
  const out = new Array(newNames.length).fill(null);
  const taken = new Array(oldNames.length).fill(false);
  const filled = new Array(newNames.length).fill(false);
  // 第一轮：同位置同文件名，区间直接跟随
  for (let i = 0; i < Math.min(oldNames.length, newNames.length); i++) {
    if (oldNames[i] === newNames[i]) {
      out[i] = oldTrims[i] ?? null;
      filled[i] = true;   // 必须标记已填，否则第二轮会把区间抢走
      taken[i] = true;
    }
  }
  // 第二轮：名字相同但位置不同（拖拽排序/插入/删除导致错位），按名字接上
  for (let i = 0; i < newNames.length; i++) {
    if (filled[i]) continue;
    for (let j = 0; j < oldNames.length; j++) {
      if (!taken[j] && oldNames[j] === newNames[i]) {
        out[i] = oldTrims[j] ?? null;
        filled[i] = true;
        taken[j] = true;
        break;
      }
    }
  }
  return out;
}

/** 音频列表变化后，按新顺序重新对齐裁剪区间（见 realignTrims） */
function pruneTrims(node, oldNamesArg, oldTrimsArg) {
  const w = getWidget(node, "trims");
  if (!w) return;
  const oldNames = oldNamesArg ?? node._prevAudios ?? [];
  const newNames = node._audios || [];
  // 旧区间由调用方在改列表**之前**传入；没传则现读（此时已按新长度截断）
  const oldTrims = oldTrimsArg ?? readTrims(node);
  writeTrims(node, realignTrims(oldNames, newNames, oldTrims));
}

// ---------------------------------------------------------------- 时长 / 试听

/**
 * 取音频时长（用于竖线定位、刻度、命中判定）。
 *
 * **必须优先用解码后的精确时长**：HTMLAudioElement.duration 对 MP3 只是按码率
 * 估算，可能差好几秒；而试听是按采样点播的。若竖线用估算值、试听用真实值，
 * 两者就会对不上（用户反馈「比竖线差约 2 秒」正是这个原因）。
 *
 * 只有解码失败时才退到 metadata 估算值（聊胜于无）。
 */
function durOf(node, name) {
  const b = node?._bufs?.[name];
  if (b && typeof b.duration === "number" && b.duration > 0) return b.duration;
  const d = node?._durations?.[name];
  return typeof d === "number" && d > 0 ? d : 0;
}

/**
 * 取**已解码确认**的精确时长；没解码成功返回 0。
 *
 * 竖线定位、命中判定、拖动换算**只认这个值**——
 * 试听是按解码后的采样点播的，若竖线用 metadata 估算值（MP3 可能差数秒），
 * 就会出现「竖线越往后，跟试听差得越多」的比例误差。
 * 这里从构造上保证：能拖竖线 <=> 已解码 <=> 试听必然用同一份时长。
 */
function exactDurOf(node, name) {
  const b = node?._bufs?.[name];
  return b && typeof b.duration === "number" && b.duration > 0 ? b.duration : 0;
}

/**
 * 取音频时长（秒）。用 HTMLAudioElement 读 metadata，不解码整段，开销小。
 * **仅作为解码失败时的兜底**，正常路径一律用 durOf() 拿解码后的精确时长。
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
      // 时长是异步读到的：拿到后必须重绘，否则竖线/刻度不会画出来
      // （新上传的音频最初 dur=0 走的是「未知时长」分支）
      node.setDirtyCanvas?.(true, true);
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

// ---------------------------------------------------------------- Web Audio 解码（精确试听）
//
// 为什么要解码而不是直接 seek HTMLAudioElement：
// 浏览器对**没有 Xing/Info 头的 CBR MP3**只能按码率估算位置，seek 误差
// 可达数秒（表现为「试听比竖线早了 1.5 秒」这类整段偏移）。
// 用 Web Audio 解码成 AudioBuffer 后，可以按**采样点**指定起播/时长，
// 完全不受 seek 估算影响。附带好处：能拿到真实波形数据。

/** 全局 AudioContext（懒创建，必须在用户手势里 resume） */
let _audioCtx = null;
function ensureAudioCtx() {
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _audioCtx = new AC();
  }
  if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

/**
 * 取解码后的 AudioBuffer（带缓存）。
 * @returns {Promise<{buffer:AudioBuffer,duration:number}|null>} 失败返回 null
 */
function getAudioBuffer(node, name) {
  const cache = (node._bufs ||= {});
  if (cache[name] != null) {
    // 缓存命中也要回填精确时长：onConfigure 会重置 _durations，
    // 不回填就会退回到 metadata 估算值，导致竖线和试听对不上。
    if (cache[name]?.duration && node._durations) {
      node._durations[name] = cache[name].duration;
    }
    return Promise.resolve(cache[name]);
  }
  const ctx = ensureAudioCtx();
  if (!ctx) {
    // 没有 Web Audio（老浏览器）：退回 metadata 估算
    getDuration(node, name);
    return Promise.resolve(null);
  }
  return fetch(audioUrl(name))
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => {
      cache[name] = { buffer: buf, duration: buf.duration };
      // 用解码后的**精确时长**回填（HTMLAudioElement 的 metadata 对 MP3 只是估算）
      if (node._durations) node._durations[name] = buf.duration;
      node.setDirtyCanvas?.(true, true);
      return cache[name];
    })
    .catch(() => {
      cache[name] = null;   // 记失败，避免反复重试
      // 解码失败：退回 metadata 估算，至少能把竖线和刻度画出来
      getDuration(node, name);
      return null;
    });
}

/**
 * **按秒裁切** AudioBuffer，返回只含 [start, end) 这一段的新 buffer。
 *
 * 试听走这条路而不是 `source.start(0, offset, duration)`：
 * 用户要求「按照当前显示的开始和结束时间来剪裁，然后播放」——
 * 真正裁一段出来、从 0 播，语义最直白，也不依赖各浏览器对 offset 的处理差异。
 * 上传（后端）用的是同一对秒值，两边必然一致。
 *
 * @param {AudioContext} ctx
 * @param {AudioBuffer} src 原音频
 * @param {number} start 起始秒
 * @param {number} end 结束秒
 * @returns {AudioBuffer|null} start>=end 或越界时返回 null
 */
function cutBuffer(ctx, src, start, end) {
  const sr = src.sampleRate;
  const total = src.length;
  let i0 = Math.round(start * sr);
  let i1 = end == null ? total : Math.round(end * sr);
  // 夹到合法范围，并保证至少 1 个采样点
  i0 = Math.max(0, Math.min(total - 1, i0));
  i1 = Math.max(i0 + 1, Math.min(total, i1));
  const len = i1 - i0;
  if (!(len > 0)) return null;
  const out = ctx.createBuffer(src.numberOfChannels, len, sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    out.getChannelData(c).set(src.getChannelData(c).subarray(i0, i1));
  }
  return out;
}

/**
 * 从 AudioBuffer 提取波形峰值（用于绘制），按 outW 列聚合。
 * 返回 Float32Array(outW)，值域 0~1。
 */
function waveformPeaks(buf, outW) {
  const n = Math.max(1, Math.floor(outW));
  const out = new Float32Array(n);
  const data = buf.getChannelData(0);
  const step = data.length / n;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step);
    const e = Math.min(data.length, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = s; j < e; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  // 归一化到 0~1（静音片段不会把整体压得太小）
  let max = 0;
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

/**
 * 刻度秒数格式化：整数不带小数点，小数保留 1 位，并清掉浮点尾差
 * （例如 0.30000000000000004 -> "0.3"）。
 */
function formatRulerSec(v) {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * 刻度**标记**的间隔（秒）。
 *
 * 硬性要求：**必须精确到 1 秒**，即间隔 ≤ 1 秒，每秒都有刻度线。
 * 只有短于 1 秒的音频才用更细的 0.1 / 0.2 / 0.5 秒。
 * @param {number} dur 音频总时长（秒）
 * @param {number} _width 波形区宽度（保留参数，标记间隔不依赖宽度）
 */
function pickRulerStep(dur, _width) {
  if (!(dur > 0)) return 1;
  if (dur < 1) {
    // 短音频：选一个不超过时长、且能分出至少 4 格的细间隔
    for (const c of [0.5, 0.2, 0.1]) {
      if (c <= dur) return c;
    }
    return 0.1;
  }
  return 1; // 精确到 1 秒
}

/**
 * 刻度**标签**的间隔（秒）。
 *
 * 刻度线已经密到每秒一条，标签若也跟着密就会挤成一团。
 * 规则（按用户要求）：**标签只显示 5秒 / 10秒 / 15秒 …，步长最小 5 秒**，
 * 且只用 5 的整数倍；只有音频短到放不下 5 秒刻度时才退到 1 / 2 秒。
 *
 * @param {number} dur 音频总时长（秒）
 * @param {number} width 波形区宽度（px）
 */
function pickLabelStep(dur, width) {
  if (!(dur > 0) || !(width > 0)) return 5;
  const MIN_PX = 44; // 8px 字号下，44px 才放得下「120秒」这类标签不贴边
  // 5 的整数倍，从小到大
  const mult5 = [5, 10, 15, 30, 60, 120, 300, 600];
  for (const c of mult5) {
    if (c > dur) break; // 超过音频时长了，改用更细的
    if ((c / dur) * width >= MIN_PX) return c;
  }
  // 音频不足 5 秒：退到 2 秒 / 1 秒（短音频标签本来就不多）
  for (const c of [2, 1]) {
    if ((c / dur) * width >= MIN_PX) return c;
  }
  return 1;
}

/** 正在试听的 {name, index, start, end, el, timer} */
let previewing = null;


/**
 * 试听：**按当前显示的开始/结束秒数裁切音频，然后播放裁出来的那段**。
 * 已在试听同一条-> 停止；试听别的 -> 先停旧的再播新的。
 *
 * 做法（按用户要求改）：不用 `source.start(0, offset, duration)` 直接定位，
 * 而是 `cutBuffer()` 真裁一段 [start, end) 出来，再从 0 播。
 * 语义最直白，也不依赖浏览器对 offset 的处理差异。
 * 上传（后端 torchaudio）用的是同一对秒值，试听与上传必然一致。
 *
 * @returns {boolean} 是否成功开始试听
 */
function togglePreview(node, index, name) {
  // 每次点击都**重新读当前显示的区间**，不用任何缓存值
  const t = trimAt(node, index);
  if (previewing && previewing.name === name && previewing.index === index) {
    stopPreview();
    return false;
  }
  stopPreview();

  const dur = durOf(node, name) || t.e || 0;
  const startSec = Math.max(0, t.s);
  const endSec = t.e != null ? t.e : dur;
  if (!(endSec > startSec)) return false;   // 区间非法，不播

  const ctx = ensureAudioCtx();
  const entry = {
    name, index, start: startSec, end: endSec,
    src: null, buffer: null, timer: null, mode: null, t0: 0,
  };
  previewing = entry;

  getAudioBuffer(node, name).then((info) => {
    if (previewing !== entry || !info) return;      // 已被停止 / 解码失败
    const full = info.buffer;
    // 终点夹到真实音频长度内，避免裁出空段
    const endClamped = Math.min(entry.end, full.duration);
    if (!(endClamped > entry.start)) {
      stopPreview();
      return;
    }
    entry.end = endClamped;

    // **真正裁一段出来**，然后从 0 播放
    const cut = cutBuffer(ctx, full, entry.start, entry.end);
    if (!cut) {
      stopPreview();
      return;
    }
    entry.buffer = cut;                 // 记住裁好的段，供 seekPreview 用
    entry.fullBuffer = full;            // 原音频，拖动竖线时重新裁
    entry.cutStart = entry.start;       // 裁切起点（秒）
    entry.cutEnd = entry.end;           // 裁切终点（秒）

    const src = ctx.createBufferSource();
    src.buffer = cut;
    src.connect(ctx.destination);
    entry.src = src;
    entry.mode = "webaudio";
    entry.t0 = ctx.currentTime;
    src.start(0);                        // 从裁段的 0 开始播
    src.onended = () => {
      if (previewing === entry) stopPreview();
    };
    node._playing = name;
    node._playingIndex = index;
    node.setDirtyCanvas?.(true, true);
    // 便于核对：试听用的秒数 / 原音频真实时长
    console.debug(
      `[TaiYangMultiAudio] 试听 #${index + 1} ${name}: ` +
        `裁切 ${entry.start.toFixed(3)}s → ${entry.end.toFixed(3)}s ` +
        `(${(entry.end - entry.start).toFixed(3)}s)，原音频 ${full.duration.toFixed(3)}s`
    );
  });

  return true;
}

/** 当前试听的播放头（秒，绝对时间）；未播放返回 null */
function previewPosition() {
  if (!previewing || previewing.mode !== "webaudio" || !_audioCtx) return null;
  const el = _audioCtx.currentTime - previewing.t0 + previewing.start;
  return Math.min(el, previewing.end ?? el);
}

/**
 * 拖动起点竖线时，按新的开始秒**重新裁一段**再播（不打断听感）。
 * 与 togglePreview 用同一套裁切逻辑，保证行为一致。
 */
function seekPreview(newStart) {
  if (!previewing || previewing.mode !== "webaudio" || !_audioCtx) return;
  const e = previewing;
  const ctx = _audioCtx;
  const full = e.fullBuffer;
  if (!full) return;
  try {
    e.src?.stop?.();
    e.src?.disconnect?.();
  } catch {
    /* 忽略 */
  }
  e.start = newStart;
  e.cutStart = newStart;
  const endSec = e.end ?? full.duration;
  if (!(endSec > newStart)) return;
  // 用原音频重新裁 [newStart, end)
  const cut = cutBuffer(ctx, full, newStart, endSec);
  if (!cut) return;
  e.buffer = cut;
  const src = ctx.createBufferSource();
  src.buffer = cut;
  src.connect(ctx.destination);
  e.src = src;
  e.t0 = ctx.currentTime;
  src.start(0);                       // 裁段从 0 播
  src.onended = () => {
    if (previewing === e) stopPreview();
  };
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
    e.src?.stop?.();
    e.src?.disconnect?.();
  } catch {
    /* 忽略：停止失败无所谓 */
  }
  // 清掉所有节点上的播放标记
  const g = window.app?.graph;
  if (g?._nodes) {
    for (const n of g._nodes) {
      if (n._playing || n._playingIndex != null) {
        n._playing = null;
        n._playingIndex = null;
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
 * 找第 ordinal 个 autogrow 槽位的下标；没有就返回 -1，**绝不自己造槽**。
 * 原因同多图载入那边：前端 1.55 起 link 归属走 graph 内部索引，
 * 手工 splice node.inputs 会把索引弄脏，进而叠出孤儿 link、存进工作流、
 * 重开时全部画在第一个槽上（看着就是连错线）。详见 multi_image.js 同名注释。
 */
function ensureAutogrowInput(node, groupPrefix, info, ordinal) {
  return findAutogrowSlot(node, groupPrefix, info, ordinal);
}

/** 取 graph.links 里所有指向 (nodeId, slotIndex) 的 link —— 包括孤儿 */
function linksIntoSlot(graph, nodeId, slotIndex) {
  const out = [];
  const links = graph?.links;
  if (!links) return out;
  const visit = (l) => {
    if (!l) return;
    const tid = l.target_id ?? l.targetNode?.id;
    const ts = l.target_slot ?? l.targetSlot;
    if (tid === nodeId && ts === slotIndex) out.push(l);
  };
  if (typeof links.forEach === "function") {
    links.forEach((v, k) => visit(v ?? (typeof links.get === "function" ? links.get(k) : null)));
  } else {
    for (const k in links) visit(links[k]);
  }
  return out;
}

/** 硬删一条 link（官方 API 删不掉的孤儿走这里） */
function removeLinkHard(graph, link) {
  if (!graph || !link) return false;
  let gone = false;
  try {
    if (typeof link.disconnect === "function") {
      link.disconnect(graph);
      gone = getLink(graph, link.id) == null;
    }
  } catch (e) {
    /* 走兜底 */
  }
  if (!gone) {
    try {
      if (typeof graph.removeLink === "function") {
        graph.removeLink(link);
        gone = getLink(graph, link.id) == null;
      }
    } catch (e) {
      /* 继续兜底 */
    }
  }
  if (!gone) {
    try {
      if (typeof graph.links?.delete === "function") graph.links.delete(link.id);
      else if (graph.links) delete graph.links[link.id];
      graph.incrementVersion?.();
      gone = true;
    } catch (e) {
      console.warn("[TaiYangMultiAudio] 清理残留连线失败", e);
    }
  }
  if (!gone) return false;
  const origin = graph.getNodeById?.(link.origin_id);
  const target = graph.getNodeById?.(link.target_id);
  const arr = origin?.outputs?.[link.origin_slot]?.links;
  if (Array.isArray(arr)) {
    const at = arr.indexOf(link.id);
    if (at !== -1) arr.splice(at, 1);
  }
  const tin = target?.inputs?.[link.target_slot];
  if (tin && (tin.link === link.id || tin.link == null)) tin.link = null;
  return true;
}

/**
 * 叫前端把本组再扩一个槽出来：把本组最后一条（自己的）线断开再接回去，
 * 借这次连接触发 autogrowInputConnected。没这条动作的话，
 * 「最后一个槽本来就连着」的情况下扩张永远不会发生，后面几个音频连不上。
 */
function growAutogrowByReconnect(loader, target, groupPrefix) {
  const graph = target.graph || app.graph;
  if (!graph) return false;
  const before = findLastAutogrowSlot(target, groupPrefix);
  if (before === -1) return false;
  const links = linksIntoSlot(graph, target.id, before);
  const link = links.find((l) => (l.origin_id ?? null) === loader.id);
  if (!link) return false;
  const src = graph.getNodeById?.(link.origin_id);
  if (!src) return false;
  const outSlot = link.origin_slot;
  disconnectSlot(target, before);
  connectSlot(src, outSlot, target, before);
  return findLastAutogrowSlot(target, groupPrefix) > before;
}

/**
 * 断开某个输入槽：官方入口 + 孤儿硬删。
 * 不能靠 `inp.link == null` 提前返回 —— 脏槽里正是 link 指向别处、孤儿还在。
 */
function disconnectSlot(node, slotIndex) {
  const graph = node.graph || app.graph;
  const inp = node.inputs?.[slotIndex];
  if (!graph || !inp) return;

  const doomed = linksIntoSlot(graph, node.id, slotIndex);
  if (typeof node.disconnectInput === "function") {
    try {
      node.disconnectInput(slotIndex, true);
    } catch (e) {
      console.warn("[TaiYangMultiAudio] 断开失败", e);
    }
  }
  for (const link of doomed) {
    if (getLink(graph, link.id)) removeLinkHard(graph, link);
  }
  if (inp.link != null && !getLink(graph, inp.link)) inp.link = null;
  node.setDirtyCanvas?.(true, true);
}

/** 同一槽挂了多条 link 的，只留一条（优先留 origin_slot 对得上的那条） */
function pruneGroupLinks(loader, target, prefix, info) {
  const graph = target.graph || app.graph;
  if (!graph) return 0;
  let removed = 0;
  for (let i = 0; i < target.inputs.length; i++) {
    const inp = target.inputs[i];
    if (!isGroupSlot(prefix, inp.name)) continue;
    const links = linksIntoSlot(graph, target.id, i);
    if (links.length <= 1) continue;
    const ord = ordinalOfSlot(prefix, info, inp.name);
    let keeper = links[links.length - 1];
    if (ord != null) {
      const exact = links.find((l) => l.origin_id === loader.id && l.origin_slot === ord);
      if (exact) keeper = exact;
    }
    for (const l of links) {
      if (l === keeper) continue;
      if (removeLinkHard(graph, l)) removed++;
    }
  }
  if (removed) {
    console.warn(`[TaiYangMultiAudio] 清理了 ${removed} 条残留连线（同一槽位重复）`);
    target.setDirtyCanvas?.(true, true);
  }
  return removed;
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

  const graph = srcNode.graph || app.graph;
  // 不能只看 inp.link（legacy 视图只反映最后一条），脏槽里可能挂孤儿
  const existing = linksIntoSlot(graph, dstNode.id, dstSlotIndex);
  if (existing.length) {
    const sameOrigin =
      existing.length === 1 &&
      (existing[0].origin_id ?? null) === srcNode.id &&
      (existing[0].origin_slot ?? null) === outSlot;
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
      if (idx !== -1) disconnectSlot(target, idx);
    }
    target.setDirtyCanvas?.(true, true);
    return;
  }

  // autogrow 分支（如 ReferenceToVideo 的 ref_audios）
  const ag = findAudioAutogrow(target);
  if (!ag) return;
  const { prefix, info } = ag;
  const cap = Math.min(count, info?.max ?? MAX_AUDIOS, MAX_AUDIOS);

  // 先收拾同一槽上的重复/孤儿连线，否则下面的 connect 会继续往上叠
  pruneGroupLinks(node, target, prefix, info);

  for (let i = 0; i < cap; i++) {
    let idx = ensureAutogrowInput(target, prefix, info, i);
    if (idx === -1) {
      // 前面可能是「同源跳过」，扩张不会被触发；断开重连一次把前端唤醒
      if (growAutogrowByReconnect(node, target, prefix)) {
        idx = ensureAutogrowInput(target, prefix, info, i);
      }
      if (idx === -1) continue;
    }
    connectSlot(node, i, target, idx);
  }

  // 多余的槽位断开（例如音频被删掉了）。先快照再遍历。
  const snapshot = target.inputs.slice();
  for (const inp of snapshot) {
    if (!isGroupSlot(prefix, inp.name)) continue;
    const ord = ordinalOfSlot(prefix, info, inp.name);
    if (ord === null || ord < cap) continue;
    const idx = target.inputs.indexOf(inp);
    // 不再用 inp.link != null 预判：脏槽里可能还有孤儿
    if (idx !== -1) disconnectSlot(target, idx);
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
    const graph = node.graph || app.graph;
    const targets = collectTargets(node);
    for (const t of targets) {
      const ag = findAudioAutogrow(t);
      for (const inp of t.inputs?.slice() || []) {
        const isAutoSlot = ag && isGroupSlot(ag.prefix, inp.name);
        const isStaticSlot = STATIC_TARGETS[t.type] && staticOrdinal(t.type, inp.name) !== null;
        if (!isAutoSlot && !isStaticSlot) continue;
        const idx = t.inputs.indexOf(inp);
        if (idx === -1) continue;
        // 不靠 inp.link 预判：槽上可能只剩本节点留下的孤儿
        const mine = linksIntoSlot(graph, t.id, idx).some(
          (l) => (l.origin_id ?? null) === node.id
        );
        if (mine || inp.link != null) disconnectSlot(t, idx);
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

      // 异步解码每条音频（拿精确时长画竖线 + 供试听/波形）。
      // 只走解码，不先读 metadata —— metadata 对 MP3 只是估算，会让竖线和试听对不上。
      (this._audios || []).forEach((n) => getAudioBuffer(this, n));

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
      // 载入时把「旧列表」设为当前列表：这样后续增删会以载入态为基准做区间对齐
      this._prevAudios = this._audios.slice();

      // 裁剪区间：从 widget 读，老工作流则从 properties 兜底
      const tw = getWidget(this, "trims");
      if ((!tw || !tw.value || tw.value === "[]") && this.properties?.trims) {
        if (tw) tw.value = this.properties.trims;
      }
      this._durations = {};
      // 读精确时长（解码），画竖线要用；不先读 metadata（估算不准）
      (this._audios || []).forEach((n) => getAudioBuffer(this, n));

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

      // 裁剪区间相关：全部重置 / 单条重置
      const trimsNow = readTrims(this);
      const trimmedIdx = trimsNow.findIndex((t) => t !== null);
      if (trimmedIdx >= 0) {
        items.push({
          content: "↺ 重置所有裁剪区间（恢复整段）",
          callback: () => {
            writeTrims(this, []);
            this.setDirtyCanvas(true, true);
          },
        });
        // 同名音频可能有多条，菜单里带上槽位号便于区分
        const trimmedList = (this._audios || [])
          .map((n, i) => ({ n, i }))
          .filter((x) => trimsNow[x.i] !== null);
        if (trimmedList.length) {
          items.push({
            content: "✂ 重置某条音频的裁剪区间",
            callback: () =>
              items.push(
                ...trimmedList.map((x) => ({
                  content: `　#${x.i + 1} ${truncateName(x.n, 16)}`,
                  callback: () => {
                    const arr = readTrims(this);
                    arr[x.i] = null;
                    writeTrims(this, arr);
                    this.setDirtyCanvas(true, true);
                  },
                }))
              ),
          });
        }
      }

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
    // 单列长条：GRID 只带条高/间距/起点，宽度由节点实际宽度算（rowWidthOf）
    const GRID = { rowH: ROW_H, gap: ROW_GAP, cols: COLS, startX: START_X, startY: HEADER_H };

    const origDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origDraw?.apply(this, arguments);

      // 已挂 DOM 面板（multi_audio_dom.js）时不再自绘：
      // Node 2.0（Vue 节点）不画画布，自绘内容会整个消失。
      if (this.__tyDomPanel) return;

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
      const { rowH, gap, startX, startY } = GRID;
      const rowW = rowWidthOf(this);
      this._gridPos = { ...GRID, rowW };

      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";

      // 按「有连线的输出槽个数」计数，不能按 link 条数累加
      let linked = 0;
      const graph = this.graph || app.graph;
      for (const out of this.outputs || []) {
        const hasLive = (out.links || []).some((lid) => getLink(graph, lid));
        if (hasLive) linked++;
      }

      const centerX = startX + rowW / 2;

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

      // 单列长条：水平位置恒为 startX，垂直位置按条号累加
      const cx = () => startX;
      const cy = (i) => startY + i * (rowH + gap);

      for (let i = 0; i < count; i++) {
        const slotFrom = fromOrder.indexOf(i);
        const slotTo = toOrder.indexOf(i);
        const x = cx();
        const y = cy(slotFrom) + (cy(slotTo) - cy(slotFrom)) * t;

        const isHover = this._hoverCell === i;
        const isGrabbed = !!drag && drag.from === i;
        const isShifted = slotFrom !== slotTo;

        ctx.fillStyle = isGrabbed ? "rgba(20,26,34,0.5)" : isShifted ? "#223244" : isHover ? "#3a3a3a" : "#1d2530";
        ctx.beginPath();
        ctx.roundRect(x, y, rowW, rowH, 6);
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
        const tr = trimAt(this, i);
        const dur = exactDurOf(this, name);   // 竖线只认解码后的精确时长
        const playing = this._playingIndex === i;

        const TOPBAR_H = 16;       // 长条顶部（序号 + 区间秒数）高度
        const RULER_H = 13;        // 波形区下方的时间刻度带
        const FILEBAR_H = 14;      // 底部文件名条
        const waveTop = y + TOPBAR_H;  // 波形区上沿
        const waveH = rowH - TOPBAR_H - RULER_H - FILEBAR_H;
        const waveX = x + 8;
        const waveW = rowW - 16;
        const rulerY = waveTop + waveH;  // 刻度带顶沿

        // 长条底部：文件名（左对齐，长条够宽放全名）
        ctx.fillStyle = "rgba(220,230,240,0.85)";
        ctx.font = "11px Arial";
        ctx.textAlign = "left";
        ctx.fillText(truncateName(name, 60), x + 8, y + rowH - 4);

        // 波形区底板
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.beginPath();
        ctx.roundRect(waveX, waveTop, waveW, waveH, 3);
        ctx.fill();

        // 真实波形（解码成功后才有）：先画，竖线和高亮盖在上面
        const bufInfo = (this._bufs || {})[name];
        if (bufInfo?.buffer) {
          const peaks = waveformPeaks(bufInfo.buffer, Math.round(waveW));
          const mid = waveTop + waveH / 2;
          const half = waveH / 2 - 1;
          ctx.strokeStyle = "rgba(150,200,240,0.85)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          // 第 i 列代表时间 [i/n, (i+1)/n)，所以像素要用 **i/n** 而不是 i/(n-1)。
          // 用 n-1 会让整条波形被拉伸 1/(n-1) 倍，与竖线的秒标尺对不上。
          const nCols = peaks.length;
          for (let i = 0; i < nCols; i++) {
            const px = waveX + (i / Math.max(1, nCols)) * waveW;
            const h = Math.max(0.5, peaks[i] * half);
            ctx.moveTo(px, mid - h);
            ctx.lineTo(px, mid + h);
          }
          ctx.stroke();
        }

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
          const dragStart = this._dragTrim?.index === i && this._dragTrim.which === "s";
          const dragEnd = this._dragTrim?.index === i && this._dragTrim.which === "e";

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

          // 试听播放头（用 Web Audio 的时钟，比 el.currentTime 精确得多）
          if (playing && previewing) {
            const t = previewPosition();
            if (t != null) {
              // 播放头在 [起点线, 终点线] 之间线性映射。
              // **必须从 sx 起算，不能从 waveX 起算**：
              // 若从 waveX（波形区左边缘）起算，播放头会被整体左移
              // (sx - waveX) 像素——正好等于起点线到左边缘的距离，
              // 于是「起点竖线越往后，播放头偏得越多」。
              const span = Math.max(0.001, (tr.e ?? dur) - tr.s);
              const px = sx + ((t - tr.s) / span) * (ex - sx);
              if (px >= sx && px <= ex) {
                ctx.fillStyle = "#ffd479";
                ctx.fillRect(px - 1, waveTop, 2, waveH);
              }
            }
          }
        } else {
          // 还没解码出精确时长：明确提示，而不是画一条位置可能不对的竖线。
          // （解码完成后会自动重绘，竖线才出现）
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(150,170,190,0.75)";
          ctx.font = "11px Arial";
          ctx.fillText("读取中…", x + rowW / 2, waveTop + waveH / 2);
          ctx.textBaseline = "alphabetic";
        }

        // 顶部：序号（左）+ 总时长（中）+ 区间秒数（右）
        // 总时长与播放中的当前位置都显示出来，方便和实际音频核对
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "bold 11px Arial";
        ctx.textAlign = "left";
        ctx.fillText(String(i + 1), x + 8, y + 11);
        if (dur > 0) {
          // 试听中：把「当前播放到第几秒」显示在总时长旁边，一眼核对
          if (playing && previewing) {
            const cur = previewPosition();
            if (cur != null) {
              ctx.fillStyle = "#ffd479";
              ctx.font = "bold 10px Arial";
              ctx.textAlign = "center";
              ctx.fillText(`▶ ${formatRulerSec(cur)}秒`, x + rowW / 2, y + 11);
            }
          }
          if (!(playing && previewing && previewPosition() != null)) {
            // 参考音频过长会稀释音色参考（MiniMax H3 训练范围约 5~15 秒），
            // 超过 15 秒用橙色标出，提醒用户裁一段纯人声。
            const tooLong = dur > LONG_REF_AUDIO_SEC;
            ctx.fillStyle = tooLong ? "#ff9d5c" : "rgba(160,185,210,0.9)";
            ctx.font = tooLong ? "bold 10px Arial" : "10px Arial";
            ctx.textAlign = "center";
            ctx.fillText(
              tooLong ? `${formatRulerSec(dur)}秒 ⚠` : `${formatRulerSec(dur)}秒`,
              x + rowW / 2,
              y + 11
            );
          }
          const seg =
            tr.e != null
              ? `${tr.s.toFixed(2)}秒 → ${tr.e.toFixed(2)}秒`
              : tr.s > 0
                ? `${tr.s.toFixed(2)}秒 → 结尾`
                : "整段";
          ctx.fillStyle = tr.e != null || tr.s > 0 ? "#8fe08f" : "#7d8894";
          ctx.font = "10px Arial";
          ctx.textAlign = "right";
          ctx.fillText(seg, x + rowW - 8, y + 11);
        }

        // ------------------------------------------------------------
        // 时间刻度（秒）
        //   - 刻度**线**：间隔 ≤1 秒，精确到 1 秒（短音频更细）
        //   - 刻度**标签**：只显示 5秒/10秒/15秒…（步长最小 5 秒，仅 5 的整数倍），
        //     音频不足 5 秒才退到 1/2 秒 —— 这样每秒都有刻度线但不挤
        //   - 单位「秒」强制显示；字号调小，进一步降低拥挤感
        // ------------------------------------------------------------
        if (dur > 0) {
          const tickStep = pickRulerStep(dur, waveW);   // 刻度线间隔（≤1秒）
          const labelStep = pickLabelStep(dur, waveW);  // 标签间隔（最小5秒）
          const ticks = Math.floor(dur / tickStep + 1e-6);
          // 标签抽稀比例：每隔 labelEvery 条刻度线打一个标签
          const labelEvery = Math.max(1, Math.round(labelStep / tickStep));

          ctx.font = "8px Arial";       // 字小一点
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          const drawTick = (sec, labeled, isEnd, skipLine = false) => {
            const px = waveX + (sec / dur) * waveW;
            // 刻度线：带标签的长一些深一些，没标签的短而淡 —— 主次分明不拥挤
            if (!skipLine) {
              ctx.strokeStyle = labeled ? "rgba(165,190,215,0.9)" : "rgba(115,135,155,0.35)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(px, rulerY + 1);
              ctx.lineTo(px, rulerY + (labeled ? 5 : 2.5));
              ctx.stroke();
            }
            if (!labeled) return;
            // 标签：一律带「秒」；末刻度贴右边界内缩，避免溢出长条
            const lx = isEnd ? Math.min(px, x + rowW - 16) : px;
            ctx.fillStyle = "rgba(205,220,235,0.95)";
            ctx.fillText(`${formatRulerSec(sec)}秒`, lx, rulerY + 9);
          };

          // 先画 0 ~ ticks-1 的整秒（或整档）刻度
          for (let k = 0; k < ticks; k++) {
            const sec = k * tickStep;
            drawTick(sec, k % labelEvery === 0, false);
          }
          // 末尾统一画「音频真实时长」这个刻度（带标签），保证终点精确。
          // 若终点和上一个刻度几乎重合（<1px）就不重复画线，只保留标签位置正确。
          const lastPx = ticks > 0 ? waveX + ((ticks * tickStep) / dur) * waveW : -1;
          const endPx = waveX + waveW;
          drawTick(dur, true, true, Math.abs(endPx - lastPx) < 1);
          ctx.textBaseline = "alphabetic";
        }

        // 删除按钮：放在长条右上角（序号已在左上，不冲突）；拖拽期间隐藏
        if (!drag) {
          const bx = x + rowW - 14;
          const by = y + 12;
          ctx.fillStyle = "#e04b4b";
          ctx.beginPath();
          ctx.arc(bx, by, 9, 0, Math.PI * 2);
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

      // 添加音频条：固定排在所有音频后面，同样是长条形
      if (count < MAX_AUDIOS) {
        const ax = cx();
        const ay = cy(count);
        const isHover = this._hoverCell === count;
        ctx.fillStyle = isHover ? "#3a3a3a" : "#2a2a2a";
        ctx.beginPath();
        ctx.roundRect(ax, ay, rowW, rowH, 6);
        ctx.fill();
        ctx.strokeStyle = isHover ? "#7fbfff" : "#4a4a4a";
        ctx.lineWidth = isHover ? 2 : 1;
        ctx.stroke();
        // 中间的 + 号
        ctx.strokeStyle = isHover ? "#8fd0ff" : "#666";
        ctx.lineWidth = 3;
        const cxm = ax + rowW / 2;
        const cym = ay + rowH / 2;
        const r = 14;
        ctx.beginPath();
        ctx.moveTo(cxm - r, cym);
        ctx.lineTo(cxm + r, cym);
        ctx.moveTo(cxm, cym - r);
        ctx.lineTo(cxm, cym + r);
        ctx.stroke();
        // 文字贴在 + 右侧
        ctx.fillStyle = "#888";
        ctx.font = "12px Arial";
        ctx.textAlign = "left";
        ctx.fillText("添加音频", cxm + r + 10, cym + 4);
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
      const { rowH, gap, startX, startY } = GRID;
      const audios = node._audios || [];
      const i = cellAt(node, pos);
      if (i < 0 || i >= audios.length) return null;

      const name = audios[i];
      const dur = exactDurOf(node, name);
      if (!(dur > 0)) return null;

      // 单列长条：水平位置固定，垂直按条号累加
      const x = startX;
      const y = startY + i * (rowH + gap);
      const rowW = rowWidthOf(node);
      const TOPBAR_H = 16, RULER_H = 13, FILEBAR_H = 14;
      const waveTop = y + TOPBAR_H;
      const waveH = rowH - TOPBAR_H - RULER_H - FILEBAR_H;
      // y 必须落在波形区内（含上下的手柄余量）
      if (pos[1] < waveTop - 8 || pos[1] > waveTop + waveH + 8) return null;

      const waveX = x + 8;
      const waveW = rowW - 16;
      const tr = trimAt(node, i);
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
      const { rowH, gap, startX, startY } = GRID;
      const rowW = rowWidthOf(node);
      const waveX = startX + 8;
      const waveW = rowW - 16;
      const ratio = (pos[0] - waveX) / waveW;
      return Math.max(0, Math.min(dur, ratio * dur));
    };

    /** 长条命中判定：音频条 0..n-1，添加条固定是 n */
    const cellAt = function (node, pos) {
      if (!withinNode(node, pos)) return -1;
      const { rowH, gap, startX, startY } = GRID;
      const rowW = rowWidthOf(node);
      const n = (node._audios || []).length;
      const total = n < MAX_AUDIOS ? n + 1 : n;
      for (let i = 0; i < total; i++) {
        const x = startX;
        const y = startY + i * (rowH + gap);
        if (pos[0] >= x && pos[0] <= x + rowW && pos[1] >= y && pos[1] <= y + rowH) return i;
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
      // DOM 面板接管后，画布上不再有可点的长条 / 竖线 / 模式条
      if (this.__tyDomPanel) return origMove?.apply(this, arguments);

      // 折叠时不更新 hover / 拖拽，自绘区域已不再显示
      if (isCollapsed(this)) return origMove?.apply(this, arguments);

      // 0) 正在拖裁剪竖线：实时更新区间（终点只允许在起点右侧）
      if (this._dragTrim) {
        const { which, index, dur } = this._dragTrim;
        const secs = xToSeconds(this, pos, index, dur);
        const tr = trimAt(this, index);
        if (which === "s") {
          // 起点不能越过终点
          const limit = tr.e != null ? tr.e - 0.01 : dur;
          setTrim(this, index, Math.min(secs, limit), tr.e, dur);
        } else {
          // 终点必须严格在起点右侧
          setTrim(this, index, tr.s, Math.max(secs, tr.s + 0.01), dur);
        }
        // 正在试听这条时：拖起点竖线要把播放位置也带过去，
        // 否则竖线和实际听到的位置会对不上（看着不准）。
        if (previewing && previewing.index === index && which === "s") {
          seekPreview(Math.max(0, secs));
        }
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
      // DOM 面板接管后，裁剪竖线的拖动由行内 canvas 自己处理
      if (this.__tyDomPanel) return origUp?.apply(this, arguments);

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
      // DOM 面板接管后，点击全在 DOM 里处理；这里必须放行，
      // 否则会按几何位置误判成“点在模式条上”而吃掉事件
      if (this.__tyDomPanel) return origDown?.apply(this, arguments);

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
      const { rowH, gap, startX, startY } = GRID;
      const rowW = rowWidthOf(this);
      const x = startX;
      const y = startY + i * (rowH + gap);

      if (i < audios.length) {
        // 右上角删除按钮（优先于一切）；位置与绘制保持一致
        const bx = x + rowW - 14;
        const by = y + 12;
        const dx = pos[0] - bx;
        const dy = pos[1] - by;
        if (dx * dx + dy * dy < 10 * 10) {
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
          togglePreview(this, i, audios[i]);
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
/* ---------------------------------------------------------------------------
 * 供 multi_audio_dom.js（DOM 面板）复用。
 * 自动连线、输出槽、裁剪区间、试听、波形全都只此一份，DOM 面板只负责画和收输入。
 * ------------------------------------------------------------------------- */
export {
  MAX_AUDIOS,
  MODE_OPTIONS,
  LONG_REF_AUDIO_SEC,
  getWidget,
  getAudioFiles,
  setAudios,
  getMode,
  audioUrl,
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
  truncateName,
  formatRulerSec,
  syncConnections,
  reorderList,
};
