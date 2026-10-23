import { app } from "../../scripts/app.js";

const NODE_NAME = "TaiYangMultiImageLoader";
const MAX_IMAGES = 16;

/**
 * auto_link 的可选目标。
 *
 * 设计原则：**按能力发现，而不是硬编码节点类型**。
 * 除了下面这几个预设，用户在菜单里还能手动指定任意节点类型
 * （见 onNodeMenuItems 的「设为自动连线目标」）。
 *
 * A) AUTOGROW_GROUPS：autogrow 动态槽位。按「组名」匹配，兼容
 *    - Qwen 2.1:        组 "images"，        槽 image_1 / image_2 ...
 *    - H3 参考转视频:   组 "ref_images"，    槽 ref_image_0 / ref_image_1 ...
 *    - H3 Star7 多合一: 组 "ref_images"，    同上
 *    注意两个 H3 节点都有 IMAGE 类型的 "ref_videos" 组（视频帧），
 *    必须靠组名白名单排除，绝不能只按槽类型 IMAGE 匹配，否则会把
 *    参考图错接到视频帧槽上。
 * B) STATIC_TARGETS：固定槽位节点（非 autogrow）。
 *    - 槽位名由 slotName(i) 生成（i 从 0 开始）
 *    - Edit Plus 是 image1/2/3；TE MAN Qwen 增强是「图片」「图片2」…（中文、1 基）
 *    所以命名规则必须可配置，不能写死 image${i+1}。
 */
const AUTOGROW_GROUPS = ["images", "ref_images"];
const AUTOGROW_TARGETS = ["TextEncodeQwenImage21"];
const STATIC_TARGETS = {
  TextEncodeQwenImageEditPlus: {
    cap: 3,
    // 第 0 张 -> "image1"
    slotName: (i) => `image${i + 1}`,
    // 反解槽位序号：image3 -> 2；超出 cap 视为不属于本节点
    slotOrder: (name) => {
      const m = /^image(\d+)$/.exec(name);
      if (!m) return -1;
      const ord = parseInt(m[1], 10) - 1;
      return ord >= 0 && ord < 3 ? ord : -1;
    },
  },
  // 注意：type 是注册名 TE_Qwen_Image_2_1_Prompt_Enhancer（带下划线），
  // 不是 Python 类名 TEQwenImage21PromptEnhancer —— 两者不同，别写错。
  TE_Qwen_Image_2_1_Prompt_Enhancer: {
    cap: 8,
    // 第 0 张 -> "图片"，第 1 张起带数字："图片2"
    slotName: (i) => (i === 0 ? "图片" : `图片${i + 1}`),
    // 反解："图片" -> 0，"图片5" -> 4；超出 cap（如"图片10"）视为不属于本节点
    slotOrder: (name) => {
      let ord = -1;
      if (name === "图片") ord = 0;
      else {
        const m = /^图片(\d+)$/.exec(name);
        if (m) ord = parseInt(m[1], 10) - 1;
      }
      return ord >= 0 && ord < 8 ? ord : -1;
    },
  },
};

const MODE_OPTIONS = ["自动", ...AUTOGROW_TARGETS, ...Object.keys(STATIC_TARGETS), "关闭"];
const MODE_AUTO = 0;
const MODE_OFF = MODE_OPTIONS.length - 1;

/**
 * 取某个节点对应的固定槽位配置。
 *
 * 先按 type 精确查；查不到再用**槽名特征**反查——
 * 第三方节点的注册名（type）和 Python 类名经常不一致
 * （TE MAN 那个就是 type=TE_Qwen_Image_2_1_Prompt_Enhancer，
 *   而类名是 TEQwenImage21PromptEnhancer），只按 type 查很容易漏。
 * 特征判定：该节点的输入槽里，按某套 slotName 规则能凑出至少 2 个槽。
 */
function staticCfgOf(node) {
  if (!node) return null;
  const byType = STATIC_TARGETS[node.type];
  if (byType) return byType;
  const names = (node.inputs || []).map((i) => i.name);
  if (names.length < 2) return null;
  for (const cfg of Object.values(STATIC_TARGETS)) {
    // 前两个槽名必须都能匹配上，才算命中（避免误判）
    if (names.includes(cfg.slotName(0)) && names.includes(cfg.slotName(1))) {
      return cfg;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 布局常量
// 格子放大一倍：65 -> 130，一屏 4 列 x 4 行 = 最多 16 张
const CELL = 130;
const GAP = 10;
const COLS = 4;
const START_X = 20;
const HEADER_H = 62; // 顶部标题 + 状态文字
const GRID_ROWS = Math.ceil(MAX_IMAGES / COLS);
const GRID_H = GRID_ROWS * CELL + (GRID_ROWS - 1) * GAP;
// 右侧必须留出输出槽标签的宽度。LiteGraph 把 image_1 / image_16 这类标签
// 右对齐画在节点框内、输出槽圆点的左边，不留白就会直接压在最右侧那格图上。
// 12px 是槽圆点半径 + 一点余量；SLOT_LABEL_W 还要能容下 "image_16" 六个字符。
const SLOT_DOT_W = 12;
const SLOT_LABEL_W = 62;
const RIGHT_PAD = SLOT_DOT_W + SLOT_LABEL_W;
// 拖拽判定阈值（px）。按下后移动超过这个距离才算「真的在拖」，
// 否则视为普通单击，从而做到单击无动作、只有按住拖动才生效。
const DRAG_THRESHOLD = 8;

// ---------------------------------------------------------------- 缩放（等价内置 ImageScaleToTotalPixels）
// 与内置节点一致：按「总像素数 = megapixels × 1024²」等比缩放，宽高对齐到
// resolution_steps 的整数倍。0 表示不缩放，保持原分辨率。
// 两项都支持填任意数字：点底部缩放条（左=MP、右=倍数）或右键菜单。
const UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"];

// ---------------------------------------------------------------- 拖拽排序（纯逻辑）
// 统一模型：用「顺序数组」描述状态。
//   order[p] = 位置 p 上放的是原来第几张图
// 空闲时 order 就是 [0,1,2,...]（恒等），拖动时是把 from 挪到 to 之后的排列。
// 绘制和落盘都基于这一个数组，不再需要 isDropSlot / moving 之类的特例分支。

/** 恒等顺序：位置 p 放第 p 张图 */
function identityOrder(count) {
  const o = [];
  for (let i = 0; i < count; i++) o.push(i);
  return o;
}

/** 把第 from 张挪到第 to 位之后的顺序；无效落点返回 null */
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
// auto_link 控件所在行的顶部与节点底部留白
const WIDGET_TOP_GAP = HEADER_H + GRID_H;
const WIDGET_H = 34;
// 缩放条（等价内置 ImageScaleToTotalPixels）。同样是自绘，理由同 auto_link：
// 隐藏 widget 会生成 DOM 覆盖层挡住网格，所以外观自绘、点击自己处理。
const SCALE_BAR_H = 26;
const BAR_H = 24;
const BAR_GAP = 6;
const NODE_W = START_X * 2 + COLS * CELL + (COLS - 1) * GAP + RIGHT_PAD;
// 节点高度 = 标题 + 网格 + 缩放条 + auto_link 条
const NODE_H = WIDGET_TOP_GAP + SCALE_BAR_H + BAR_H + BAR_GAP * 2 + 10;

// 底部两条控件的总占用高度（缩放条 + auto_link 条 + 两个间距）
const BOTTOM_BLOCK_H = SCALE_BAR_H + BAR_H + BAR_GAP * 2;
// 节点最小宽度：保证底部两条控件有足够横向空间
const MIN_NODE_W = 320;

/**
 * 按**实际已用行数**算最小高度。
 * 网格只画到有内容的那几行，所以图片少时节点可以缩得很矮——
 * 只要「已用网格 + 底部控件区」能放下就行，不遮挡当前已有的图片。
 */
function minHeightFor(node) {
  const n = (node?._qwenImages || []).length;
  // 有图就多留一个加号格的位置（加号固定排在所有图片后面）
  const slots = n < MAX_IMAGES ? n + 1 : n;
  const rows = Math.max(1, Math.ceil(slots / COLS));
  const gridH = rows * CELL + (rows - 1) * GAP;
  return HEADER_H + gridH + BOTTOM_BLOCK_H;
}

/**
 * 底部控件布局：**贴着节点实际底边往上排**。
 * 这样用户手动缩放节点时，两条控件会跟着底边一起动，而不是钉在固定坐标上。
 * @param {number} nodeH 节点实际高度（node.size[1]）
 */
function bottomLayout(nodeH) {
  const modeY = nodeH - BAR_H - BAR_GAP;      // auto_link 条
  const scaleY = modeY - BAR_GAP - SCALE_BAR_H; // 缩放条（在 auto_link 条上方）
  return { scaleY, modeY };
}

/**
 * 钳制节点尺寸：宽度不低于 MIN_NODE_W，高度不低于「已用网格 + 控件区」。
 * 这样既能自由缩小（图片少时），又保证控件不会盖住已有图片。
 */
function clampNodeSize(node) {
  const s = node?.size;
  if (!s) return node;
  // DOM 面板模式下尺寸由面板自己算（addDOMWidget 的 getHeight），这里不要插手
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

/** 读取节点里保存的图片文件名列表（已剔除空槽） */
function getImageFiles(node) {
  const w = getWidget(node, "image_files");
  if (!w) return [];
  try {
    const parsed = JSON.parse(w.value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** 缩放参数读写：widget 都是 hidden 的（hidden widget 仍保留在数组里，后端按名取值） */
function getMegapixels(node) {
  const w = getWidget(node, "megapixels");
  const v = Number(w?.value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function setMegapixels(node, mp) {
  const w = getWidget(node, "megapixels");
  if (w) w.value = clampMegapixels(mp);
  node.setDirtyCanvas?.(true, true);
}

function getUpscaleMethod(node) {
  const w = getWidget(node, "upscale_method");
  return w?.value || "bilinear";
}

function setUpscaleMethod(node, m) {
  const w = getWidget(node, "upscale_method");
  if (w) w.value = m;
  node.setDirtyCanvas?.(true, true);
}

/**
 * 分辨率倍数（对齐步长）。**默认 32**，可任意填数字。
 * widget 缺失时（老工作流）主动补成 32，并写回 widget，
 * 保证界面显示、缩放计算、后端取参三处始终一致。
 */
const DEFAULT_STEPS = 32;

function getResolutionSteps(node) {
  const w = getWidget(node, "resolution_steps");
  const v = Math.round(Number(w?.value));
  if (Number.isFinite(v) && v >= 1) return v;
  // widget 不存在或值非法：补默认值并写回，避免下次再读还是错的
  if (w) w.value = DEFAULT_STEPS;
  return DEFAULT_STEPS;
}

function setResolutionSteps(node, n) {
  const w = getWidget(node, "resolution_steps");
  const v = Math.round(Number(n));
  if (w) w.value = Number.isFinite(v) && v >= 1 ? v : DEFAULT_STEPS;
  node.setDirtyCanvas?.(true, true);
}

/** 百万像素上限（与后端 widget 的 max=16 保持一致），0 表示关闭缩放 */
function clampMegapixels(mp) {
  const v = Number(mp);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(v, 16);
}

/** 数字显示去掉多余小数位：1.0 -> 1，1.25 -> 1.25 */
function trimNum(v) {
  if (!Number.isFinite(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

/**
 * 弹窗输入一个数字。用浏览器原生 prompt：
 * 画布外的系统弹窗，不会像 widget 那样生成 DOM 覆盖层压住自绘网格
 * （这个节点的坑，见 onNodeCreated 里的注释）。
 * @returns {number|null} 确认后返回数字；取消/非法输入返回 null
 */
function promptNumber(title, current, { min, max, step = 1, integer = false }) {
  const msg = `${title}\n当前：${current}${integer ? "" : ""}`;
  const raw = window.prompt(msg, String(current));
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  let v = Number(trimmed);
  if (!Number.isFinite(v)) {
    window.alert("输入的不是有效数字，已取消修改。");
    return null;
  }
  if (integer) v = Math.round(v);
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

/**
 * 推算缩放后的实际尺寸（与后端 _scale_to_total_pixels 同一套公式）。
 * megapixels<=0 时返回原尺寸。这样格子里显示的分辨率 = 真正送进模型的分辨率。
 */
function scaledSize(natW, natH, megapixels, resolutionSteps = DEFAULT_STEPS) {
  if (!natW || !natH || megapixels <= 0) return [natW, natH];
  const total = megapixels * 1024 * 1024;
  const scaleBy = Math.sqrt(total / (natW * natH));
  const steps = Math.max(1, Math.round(resolutionSteps) || 1);
  const w = Math.max(steps, Math.round((natW * scaleBy) / steps) * steps);
  const h = Math.max(steps, Math.round((natH * scaleBy) / steps) * steps);
  return [w, h];
}

function makeThumb(name) {
  const img = new Image();
  img.src = `/api/view?filename=${encodeURIComponent(name)}&type=input&rand=${Date.now()}`;
  return img;
}

/**
 * 让输出槽数量跟随图片数量：有几张图就只显示几个 image_N 输出。
 *
 * 用前端自带的 addOutput / removeOutput，而不是直接 splice node.outputs：
 * removeOutput 内部会先 disconnectOutput 再对后续 link 的 origin_slot 做自减，
 * 自己改数组会把后面所有连线的槽位编号弄乱。
 *
 * 注意：后端始终返回 16 个值，这里只影响前端显示，不影响执行。
 */
/** 只扩不缩：保证至少有 count 个输出。连线前必须先做这一步，否则 outputs[i] 不存在会连不上 */
function growOutputSlots(node, count) {
  if (typeof node.addOutput !== "function") return;
  const target = Math.max(1, Math.min(count, MAX_IMAGES));
  try {
    while (node.outputs.length < target) {
      const idx = node.outputs.length;
      node.addOutput(`image_${idx + 1}`, "IMAGE");
    }
  } catch (e) {
    console.warn("[TaiYangMultiImage] 扩展输出槽失败", e);
  }
}

/**
 * 让输出槽数量跟随图片数量：有几张图就只显示几个 image_N 输出。
 *
 * 用前端自带的 addOutput / removeOutput，而不是直接 splice node.outputs：
 * removeOutput 内部会先 disconnectOutput 再对后续 link 的 origin_slot 做自减，
 * 自己改数组会把后面所有连线的槽位编号弄乱。
 *
 * 注意：后端始终返回 16 个值，这里只影响前端显示，不影响执行。
 */
function syncOutputSlots(node, count) {
  if (typeof node.addOutput !== "function" || typeof node.removeOutput !== "function") return;
  // 至少保留 1 个输出，否则节点会退化成一个没有输出的空盒子
  const want = Math.max(1, Math.min(count, MAX_IMAGES));
  // 已有连线占用的输出不能删，否则会把有效连线剪掉
  const linked = (node.outputs || []).filter((o) => (o.links || []).length > 0).length;
  const target = Math.max(want, linked);

  growOutputSlots(node, target);
  try {
    // 从末尾删，removeOutput 会自动修正后续 origin_slot
    while (node.outputs.length > target) {
      node.removeOutput(node.outputs.length - 1);
    }
  } catch (e) {
    console.warn("[TaiYangMultiImage] 调整输出槽失败", e);
  }
  node.setDirtyCanvas?.(true, true);
}

/**
 * 写回文件名列表并重建缩略图缓存。
 * 这里不动输出槽——输出槽必须等 syncConnections 把多余连线断干净之后再收，
 * 否则 removeOutput 会先把 link 删掉，encode 侧就留下悬空的 link 引用。
 */
function setImages(node, files) {
  const list = files.slice(0, MAX_IMAGES);
  const w = getWidget(node, "image_files");
  if (w) w.value = JSON.stringify(list);
  node._qwenImages = list.slice();
  node._qwenImgCache = {};
  list.forEach((name, i) => {
    node._qwenImgCache[i] = makeThumb(name);
  });
  // 图片增删后最小高度会变（按已用行数），重新钳一次。
  // 删图后如果节点比新的下限还矮要顶回去；
  // 加图后如果节点不够高也要跟着长出来，否则新图会被底部控件挡住。
  // DOM 面板下高度由面板控制，别在这里改 size。
  if (!node.__tyDomPanel) {
    const minH = minHeightFor(node);
    if (node.size && node.size[1] < minH) node.size[1] = minH;
    if (node.size && node.size[0] < MIN_NODE_W) node.size[0] = MIN_NODE_W;
  }
  node.setDirtyCanvas(true, true);
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
 * 找出该节点里「可以接多张参考图」的 autogrow 组。
 *
 * 只认组名在 AUTOGROW_GROUPS 白名单里的组，且槽类型必须是 IMAGE。
 * 不能只按槽类型 IMAGE 匹配：MiniMax H3 的 ref_videos 组也是 IMAGE，
 * 但它是「参考视频帧」，接上去是错的。
 *
 * @param {object} node
 * @param {string[]|null} onlyGroups 限定只找这些组名；null = 用白名单
 * @returns {{prefix:string, info:object}|null}
 */
function findImageAutogrow(node, onlyGroups = null) {
  const ag = node?.comfyDynamic?.autogrow;
  if (!ag) return null;
  const wanted = onlyGroups && onlyGroups.length ? onlyGroups : AUTOGROW_GROUPS;

  for (const prefix of wanted) {
    const info = ag[prefix];
    if (!info) continue;
    const specs = info?.inputSpecs || [];
    // 必须整组都是 IMAGE 才算多图接入槽
    if (!specs.length) continue;
    if (!specs.some((s) => String(s.type).toUpperCase().includes("IMAGE"))) continue;
    return { prefix, info };
  }
  return null;
}

/** 兼容旧调用 */
function getAutogrowInfo(node, preferPrefix = "images") {
  return findImageAutogrow(node, [preferPrefix]);
}

/**
 * 取组内槽名的「局部前缀」，用于生成第 n 个槽名。
 *  - TemplateNames（如 Qwen）：names = ["image_1", "image_2", ...]
 *    -> 用 names[n]，没有就退回 "<base>_<n+1>"
 *  - TemplatePrefix（如 H3）：prefix = "ref_image_"，槽名是 ref_image_0 / ref_image_1 ...
 *    -> 用 "<base><n>"（0 基！）
 */
function slotLocalName(groupPrefix, info, ordinal) {
  const names = info?.names;
  if (Array.isArray(names) && names.length) {
    // TemplateNames（如 Qwen）：names = ["image_1", "image_2", ...]，1 基
    return names[ordinal] ?? `${info?.inputSpecs?.[0]?.name ?? "image"}_${ordinal + 1}`;
  }
  // TemplatePrefix（如 H3）：info.prefix = "ref_image_"，槽名 ref_image_0 / ref_image_1，0 基
  // 注意 info.prefix 末尾的下划线必须保留，不能 strip 掉。
  const p = info?.prefix;
  const base = typeof p === "string" && p.length
    ? p
    : `${(info?.inputSpecs?.[0]?.name ?? groupPrefix)}_`;
  const start = (info?.min ?? 0) > 0 ? info.min : 0;
  return `${base}${start + ordinal}`;
}

/** 该组槽名的尾部数字（ref_image_0 -> 0；image_1 -> 1）；非本组返回 null */
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
 * 保证第 ordinal 个 images 槽位存在，返回其下标；没有则 -1。
 *
 * 关键：不要自己 splice 造槽位。前端 autogrow 只认自己创建的槽
 * （自带 widget 与 label，所以画布上显示短名 image_N）。
 * 手工插进去的裸对象会被当成普通输入，连线建不上，
 * 画布上就会显示成 images.image_N 这种全名（前端没给它 display name）。
 *
 * 正确做法：借用前端自己的扩张逻辑——它监听「线接到本组最后一个槽」
 * （onConnectionsChange -> autogrowInputConnected）并自动补出下一个槽。
 * 这里直接调它的 autogrow 定义来补，而不是伪造对象。
 */
/**
 * 找第 ordinal 个 autogrow 槽位的下标；没有就返回 -1，**绝不自己造槽**。
 *
 * 这里踩过这个节点包最狠的一个坑，记清楚，别再走回头路：
 *
 * 前端 1.55 起把「哪条 link 接在哪个槽上」搬进了 graph 内部索引
 * （slotLinks.ts 的 inputLink / inputLinkId / outputHasLinks），
 * node.inputs 只剩一个 legacy 视图。前端自己的扩槽函数 addAutogrowGroup
 * 是靠 commitMutatedInputs -> replaceNodeInputs 把这套索引整体重建一遍才落地的。
 *
 * 老版本这里用 `node.inputs.splice()` 手工塞槽位，只动了数组、没重建索引，
 * 于是连锁反应：
 *   1. graph 认为这些槽「没连接」-> connectSlots 里 replacingLink 查成 null
 *      -> 不替换旧线，直接 _addLink 追加；
 *   2. 一个输入槽上叠出多条 link，inputs[slot].link 只显示最后一条，
 *      其余全变孤儿（graph.links 里还在，但没人认领）；
 *   3. 孤儿会被序列化写进工作流 JSON；
 *   4. 重开工作流时前端照着 graph.links 画线 —— 所有孤儿都画在
 *      ref_image_0 上，看起来就是「好几张图全连到参考图 1」= 连错线。
 *
 * 正确做法是根本不造槽：按 0,1,2… 顺序连线时，每连上「本组最后一个槽」，
 * 前端 onConnectionsChange -> autogrowInputConnected 会同步补出下一个槽
 * （dynamicWidgets.ts 里连接分支是同步调用，不是 rAF）。所以查不到就返回 -1，
 * 交给外层 markRetry 下一轮再试。
 */
function ensureAutogrowInput(node, groupPrefix, info, ordinal) {
  return findAutogrowSlot(node, groupPrefix, info, ordinal);
}

/**
 * 叫前端把本组再扩一个槽出来。
 *
 * 前端只在「一条线刚连上本组最后一个槽」时才补下一个槽
 * （autogrowInputConnected）。所以如果最后那个槽本来就连着正确的线，
 * 我们判定同源直接跳过，扩张就永远不会发生 —— 表现为：脏工作流打开后
 * 只有第 1 张图连得上，后面几张一直空着，补试 5 次也没用。
 *
 * 办法是把本组最后一条线「断开再原样接回去」，借这次连接把扩张唤醒。
 * 全程走官方 connect / disconnectInput，不碰 node.inputs，索引不会脏。
 *
 * @returns 是否真的多出了一个槽
 */
function growAutogrowByReconnect(loader, target, groupPrefix) {
  const graph = target.graph || app.graph;
  if (!graph) return false;

  const before = findLastAutogrowSlot(target, groupPrefix);
  if (before === -1) return false;

  const links = linksIntoSlot(graph, target.id, before);
  if (!links.length) return false;
  // 只动自己接的线，别人的连接不去碰
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
 * 取 graph.links 里所有指向 (nodeId, slotIndex) 的 link —— 包括孤儿。
 *
 * 为什么不直接用 inputs[slot].link：那只是 legacy 视图，只反映「最后一条」。
 * 一个槽上叠了多条时，除最后一条外都只能从这里翻出来。修理脏工作流靠它。
 */
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
    // Map: forEach(value, key)；数组: forEach(value, index)。两种都能取到 link
    links.forEach((v, k) => visit(v ?? (typeof links.get === "function" ? links.get(k) : null)));
  } else {
    for (const k in links) visit(links[k]);
  }
  return out;
}

/** 硬删一条 link：官方 API 删不掉的孤儿走这里，顺手把两端槽位上的残留 id 清干净 */
function removeLinkHard(graph, link) {
  if (!graph || !link) return false;
  let gone = false;
  try {
    if (typeof link.disconnect === "function") {
      link.disconnect(graph);
      gone = getLink(graph, link.id) == null;
    }
  } catch (e) {
    /* 走下面的兜底 */
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
      console.warn("[TaiYangMultiImage] 清理残留连线失败", e);
    }
  }
  if (!gone) return false;

  // 两端槽位的 legacy 列表里可能还留着这个 id，一并抹掉
  const origin = graph.getNodeById?.(link.origin_id);
  const target = graph.getNodeById?.(link.target_id);
  const strip = (arr) => {
    if (!Array.isArray(arr)) return;
    const at = arr.indexOf(link.id);
    if (at !== -1) arr.splice(at, 1);
  };
  strip(origin?.outputs?.[link.origin_slot]?.links);
  const tin = target?.inputs?.[link.target_slot];
  if (tin && (tin.link === link.id || tin.link == null)) tin.link = null;
  return true;
}

/**
 * 断开某个输入槽。
 *
 * 不能用 `if (inp.link == null) return` 提前退：脏工作流里恰恰就是
 * inputs[slot].link 指向别的一条，而 graph.links 里还挂着孤儿 ——
 * 提前返回等于永久放弃清理，孤儿会跟着工作流一起存下去。
 */
function disconnectSlot(node, slotIndex) {
  const graph = node.graph || app.graph;
  const inp = node.inputs?.[slotIndex];
  if (!graph || !inp) return;

  const doomed = linksIntoSlot(graph, node.id, slotIndex);

  // 先走官方入口：它会维护索引、触发 onConnectionsChange、顺带收拾 reroute
  if (typeof node.disconnectInput === "function") {
    try {
      node.disconnectInput(slotIndex, true);
    } catch (e) {
      console.warn("[TaiYangMultiImage] 断开失败", e);
    }
  }

  // 官方入口只删得掉「索引认为属于本槽」的那一条，剩下的孤儿逐个硬删
  for (const link of doomed) {
    if (getLink(graph, link.id)) removeLinkHard(graph, link);
  }

  if (inp.link != null && !getLink(graph, inp.link)) inp.link = null;
  node.setDirtyCanvas?.(true, true);
}

/**
 * 清理目标组里的脏连线：同一个槽上挂了多条 link 的，只留一条。
 *
 * 留哪条：优先留「来自本 loader 且 origin_slot 与本槽序号对得上」的那条
 * （那才是上一轮 sync 该连的），否则留最后一条。其余全部硬删。
 * 这既是给已经存坏的工作流做自愈，也顺手避免下一轮连出新孤儿。
 */
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
    console.warn(`[TaiYangMultiImage] 清理了 ${removed} 条残留连线（同一槽位重复）`);
    target.setDirtyCanvas?.(true, true);
  }
  return removed;
}

/**
 * 掐掉「输出序号 ≠ 槽位序号」的错位连线。
 *
 * 这是脏连线最后一条产生路径，也是「切走再切回来就乱连线」留下的残渣：
 * 前端 autogrow 扩槽时把新槽插在本组末尾，索引里的 link 会被整体 +1 修正，
 * 但**孤儿 link（索引里查不到的那条）不会被修正**；removeOutput 同理只给
 * 索引里的 link 做 origin_slot 自减。于是同一条孤儿会慢慢「漂」成别的槽：
 *   out1 → ref_image_1（正确那条）
 *   out1 → ref_image_2（孤儿漂过来的，画布上就是「图像_2 冒出两条线」）
 * 它不违反「一个槽一条线」，所以 pruneGroupLinks 抓不到，
 * 必须在「输出序号必须等于槽位序号」这条不变量上统一收口。
 *
 * 只处理来源是本 loader 的线，别家接进来的线一律不碰。
 */
function enforceGroupLinks(loader, target, prefix, info, cap) {
  const graph = target.graph || app.graph;
  const links = graph?.links;
  if (!links) return 0;

  const bad = [];
  const visit = (l) => {
    if (!l) return;
    if ((l.origin_id ?? null) !== loader.id) return;
    if ((l.target_id ?? null) !== target.id) return;
    const slot = target.inputs?.[l.target_slot];
    if (!slot || !isGroupSlot(prefix, slot.name)) return;
    const ord = ordinalOfSlot(prefix, info, slot.name);
    if (ord === null) return;
    // 超出图片数量的槽、以及输出序号与槽位序号对不上的，都是脏线
    if (ord >= cap || l.origin_slot !== ord) {
      bad.push({ link: l, ord, out: l.origin_slot, name: slot.name });
    }
  };
  if (typeof links.forEach === "function") {
    links.forEach((v, k) => visit(v ?? links.get?.(k)));
  } else {
    for (const k in links) visit(links[k]);
  }

  let removed = 0;
  for (const it of bad) {
    if (removeLinkHard(graph, it.link)) removed++;
  }
  if (removed) {
    console.warn(
      `[TaiYangMultiImage] 清理了 ${removed} 条错位连线（输出/槽位序号对不上）`,
      bad.map((b) => `out${b.out}→${b.name}`).join(", ")
    );
    target.setDirtyCanvas?.(true, true);
  }
  return removed;
}

/**
 * 删掉「来源输出槽已经不存在」的悬空连线。
 *
 * syncOutputSlots 是按 outputs[i].links 决定收缩到几个，孤儿不在这个数组里，
 * 于是可能出现「输出只剩 2 个，graph 里还挂着 out2 的线」。这条线画不出来，
 * 却会被序列化进工作流，下次打开又变成幽灵。
 */
function pruneDanglingOutputLinks(node) {
  const graph = node.graph || app.graph;
  const links = graph?.links;
  if (!links) return 0;
  const n = (node.outputs || []).length;

  const bad = [];
  const visit = (l) => {
    if (!l) return;
    if ((l.origin_id ?? null) !== node.id) return;
    if ((l.origin_slot ?? 0) >= n) bad.push(l);
  };
  if (typeof links.forEach === "function") {
    links.forEach((v, k) => visit(v ?? links.get?.(k)));
  } else {
    for (const k in links) visit(links[k]);
  }

  let removed = 0;
  for (const l of bad) {
    if (removeLinkHard(graph, l)) removed++;
  }
  if (removed) {
    console.warn(`[TaiYangMultiImage] 清理了 ${removed} 条悬空连线（输出槽已不存在）`);
  }
  return removed;
}

/**
 * 排查用：把本节点与各目标之间的所有连线（含孤儿）打出来。
 * 控制台执行 __tyAuditImageLinks() 即可；连线出问题时把输出发出来就能定位。
 */
function auditImageLinks() {
  const g = app?.graph;
  if (!g) return "no graph";
  const rows = [];
  const all = typeof g.links?.values === "function" ? [...g.links.values()] : [];
  for (const n of g._nodes || []) {
    if (n.type !== NODE_NAME) continue;
    rows.push(`多图载入 #${n.id}：图片 ${getImageFiles(n).length} 张，输出槽 ${(n.outputs || []).length} 个`);
    for (const t of collectTargets(n)) {
      const ag = findImageAutogrow(t);
      rows.push(`  目标 #${t.id}（${t.type}）组=${ag?.prefix ?? "(无)"}`);
      const mine = all.filter((l) => l.origin_id === n.id && l.target_id === t.id);
      if (!mine.length) rows.push("    （无连线）");
      for (const l of mine) {
        const slot = t.inputs?.[l.target_slot];
        const ord = ag && slot ? ordinalOfSlot(ag.prefix, ag.info, slot.name) : null;
        const bad = ord !== null && ord !== l.origin_slot ? "   ← 错位" : "";
        rows.push(`    out${l.origin_slot} → [${l.target_slot}] ${slot?.name ?? "?"} 序号=${ord}${bad}`);
      }
    }
  }
  const text = rows.join("\n") || "没有多图载入节点";
  console.log(text);
  return text;
}

// ---------------------------------------------------------------- 载入期保护 + 载入后收口
//
// 「切走再切回来就乱连线」的真正成因（用户实测：什么都没动）：
//
//   切标签页 = 前端走一次 loadGraphData -> 把整张图拆掉重建。
//   重建时节点是一个一个 configure 的：本节点的 onConfigure 会先跑，
//   而对端节点（H3 那种带 autogrow 的大节点）此时还没 configure 完、
//   graph.links 也还没把存档里的线恢复回来。
//   我们在这个「半成品的图」上跑 syncConnections -> 建链成功；
//   紧接着前端继续 configure，把存档里原本正确的线也恢复回来
//   -> 同一个输入槽上就有了两条线 -> 画布上看着就是「图像_2 冒出两条线」。
//
// 所以：载入期间一律不建链、不拆线，只记个标记；等
// afterConfigureGraph 之后再做一次收口（清理 + 补齐）。
// 存档本来是干净的，收口就没有任何动作，图形保持原样。

let graphLoadDepth = 0;
let loadWatchdog = null;

/** 图是不是正在载入/重建中 */
function graphBusy() {
  return graphLoadDepth > 0;
}

function beginGraphLoad() {
  graphLoadDepth++;
  if (loadWatchdog) clearTimeout(loadWatchdog);
  // 兜底：万一 afterConfigureGraph 没来（被别的扩展打断 / 抛异常），
  // 别把保护状态永久挂着，否则之后所有自动连线都会失效。
  loadWatchdog = setTimeout(() => {
    loadWatchdog = null;
    if (graphLoadDepth > 0) {
      console.warn("[TaiYangMultiImage] 未收到载入结束信号，强制解除载入保护");
      graphLoadDepth = 0;
    }
    scheduleSettle();
  }, 15000);
}

function endGraphLoad() {
  graphLoadDepth = Math.max(0, graphLoadDepth - 1);
  if (graphLoadDepth === 0) {
    if (loadWatchdog) {
      clearTimeout(loadWatchdog);
      loadWatchdog = null;
    }
    scheduleSettle();
  }
}

let settleTimer = null;
let settlePass = 0;

/**
 * 载入结束后的收口：清理脏线 + 按需补齐。
 * 跑四轮（50ms / 310ms / 1.2s / 3.4s），因为 autogrow 扩槽、以及别的扩展
 * 对输入的二次加工都可能在我们之后发生，一轮不够稳。
 */
function scheduleSettle() {
  if (settleTimer) clearTimeout(settleTimer);
  settlePass = 0;
  const NEXT = [260, 900, 2200];
  const step = () => {
    settleTimer = null;
    if (graphBusy()) return;          // 又开始了新一轮载入，等它结束
    const g = app?.graph;
    if (!g) return;
    for (const n of g._nodes || []) {
      if (n.type !== NODE_NAME) continue;
      try {
        settleLoader(n);
      } catch (e) {
        console.warn("[TaiYangMultiImage] 载入后收口失败", e);
      }
    }
    settlePass++;
    if (settlePass < NEXT.length + 1) {
      settleTimer = setTimeout(step, NEXT[settlePass - 1] ?? 900);
    }
  };
  settleTimer = setTimeout(step, 50);
}

/**
 * 单个 loader 的收口：先清脏线，再补齐缺的槽，补完再核一遍。
 *
 * 补连之后再核一遍的原因：autogrow 扩槽会把新槽插进 inputs 中间，
 * 索引里的 link 会被前端顺手修正，孤儿的 target_slot 却不会 ——
 * 也就是说「补线这个动作本身」也可能当场漂出一条错位线。
 */
function settleLoader(node) {
  const graph = node.graph || app.graph;
  if (!graph) return;
  if (!(graph._nodes || []).includes(node)) return;   // 节点已经被删 / 换图了

  const files = getImageFiles(node);
  const sweep = () => {
    for (const t of collectTargets(node)) {
      const ag = findImageAutogrow(t);
      if (!ag) continue;
      const cap = Math.min(files.length, ag.info?.max ?? MAX_IMAGES, MAX_IMAGES);
      enforceGroupLinks(node, t, ag.prefix, ag.info, cap);
    }
    pruneDanglingOutputLinks(node);
  };

  sweep();
  if (files.length === 0) return;
  // 图已经完整就绪，这时候补连不会重复（同源的线 connectSlot 会直接跳过）
  syncConnections(node, { force: true });
  sweep();
}

/**
 * 建链。优先用节点级 connect(outSlot, targetNode, inputSlot)，
 * 它是前端对外的正规入口，内部会转调 connectSlots 完成
 * link id 分配 / graph.links 写入 / 两侧 slot 更新 /
 * beforeChange+afterChange / 脏画布 / autogrow 的 onConnectionsChange。
 * 注意参数是「输出槽下标 + 目标节点 + 目标输入槽下标」，
 * 不是 graph.connect(nodeId, ...)——后者在这个版本根本不存在。
 */
function connectSlot(srcNode, outSlot, dstNode, dstSlotIndex) {
  const inp = dstNode.inputs?.[dstSlotIndex];
  if (!inp || !srcNode.outputs?.[outSlot]) return false;

  const graph = srcNode.graph || app.graph;
  // 判断「这槽上有没有线」不能只看 inp.link（legacy 视图只反映最后一条），
  // 脏槽里可能挂着孤儿而 inp.link 是 null —— 那种情况直接 connect 会往上叠。
  const existing = linksIntoSlot(graph, dstNode.id, dstSlotIndex);
  if (existing.length) {
    const sameOrigin =
      existing.length === 1 &&
      (existing[0].origin_id ?? null) === srcNode.id &&
      (existing[0].origin_slot ?? null) === outSlot;
    if (sameOrigin) return true;
    disconnectSlot(dstNode, dstSlotIndex);
  }

  // 以「输入槽是否真的挂上 link」判定成功，不依赖返回值
  if (typeof srcNode.connect === "function") {
    try {
      srcNode.connect(outSlot, dstNode, dstSlotIndex);
      if (inp.link != null) return true;
    } catch (e) {
      console.warn("[TaiYangMultiImage] connect 失败", e);
    }
  }
  // 兜底：直接调更底层的 connectSlots
  if (typeof srcNode.connectSlots === "function") {
    try {
      srcNode.connectSlots(srcNode.outputs[outSlot], inp, dstNode);
      if (inp.link != null) return true;
    } catch (e) {
      console.warn("[TaiYangMultiImage] connectSlots 失败", e);
    }
  }
  console.warn("[TaiYangMultiImage] 建链未生效", outSlot, "->", dstNode.type, inp.name);
  return false;
}

// ---------------------------------------------------------------- 自动连线主逻辑

function collectTargets(node) {
  const graph = node.graph || app.graph;
  if (!graph) return [];

  const mode = getMode(node);
  if (mode === MODE_OFF) return [];

  // 手动指定的节点类型（用户在菜单里设的），或某组 autogrow 组名
  const manual = node._qwenManualTarget || null;

  let candidates;
  if (manual) {
    candidates = (graph._nodes || []).filter((n) => n.type === manual);
  } else if (mode === MODE_AUTO) {
    // 自动发现：任何带「多图接入 autogrow 组」的节点，或已知固定槽位节点
    candidates = (graph._nodes || []).filter(
      (n) => n.type !== NODE_NAME && (findImageAutogrow(n) || staticCfgOf(n))
    );
  } else {
    const type = MODE_OPTIONS[mode];
    candidates = (graph._nodes || []).filter((n) => n.type === type);
  }
  if (candidates.length === 0) return [];

  // 「已连过的目标优先」只用来**排序**，不能用来过滤。
  // 早期版本写成 `already.length ? already : candidates`，导致一旦 loader 连过
  // Qwen，MiniMax H3 这类同样合法的多图接入节点就被整体排除，再也连不上。
  // 现在：全部候选都返回，只是把已连过的排前面，保证既有连线不被无谓改动。
  const linked = new Set();
  for (const out of node.outputs || []) {
    for (const lid of out.links || []) {
      const link = getLink(graph, lid);
      const tid = targetIdOf(link);
      if (tid != null) linked.add(tid);
    }
  }
  return [...candidates].sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)));
}

function syncOneTarget(node, target, count) {
  const graph = node.graph || app.graph;
  if (!graph) return;

  const stCfg = staticCfgOf(target);
  if (stCfg && !findImageAutogrow(target)) {
    // 固定槽位节点：槽名按各自规则生成（Edit Plus 是 image1/2/3，
    // TE MAN Qwen 增强是「图片」「图片2」…中文 1 基），直接找槽即可
    const cfg = stCfg;
    const cap = Math.min(count, cfg.cap);
    let missing = 0;   // 目标槽还没建出来的数量
    for (let i = 0; i < cap; i++) {
      const idx = target.inputs.findIndex((x) => x.name === cfg.slotName(i));
      if (idx === -1) {
        missing++;
        continue;
      }
      connectSlot(node, i, target, idx);
    }
    // 多余的固定槽断开
    const snapshot = target.inputs.slice();
    for (const inp of snapshot) {
      const ord = cfg.slotOrder(inp.name);
      if (ord < 0) continue;          // 不是本节点的图片槽
      if (ord < cap) continue;        // 仍在用，保留
      const idx = target.inputs.indexOf(inp);
      if (idx !== -1) disconnectSlot(target, idx);
    }
    target.setDirtyCanvas?.(true, true);
    // 目标槽缺失（工作流刚载入、对端输入槽还没初始化完）→ 记下待重试，
    // 否则这些槽会一直空着，用户必须手动点「重新自动连线」才能补上。
    if (missing > 0) markRetry(node);
    return;
  }

  const ag = findImageAutogrow(target);
  if (!ag) return;
  const { prefix, info } = ag;
  const cap = Math.min(count, info?.max ?? MAX_IMAGES, MAX_IMAGES);

  // 先把本组上「一个槽挂多条」的脏连线收拾干净。
  // 不收拾的话 connectSlot 判断不出已有连接，会在同一槽上继续叠孤儿。
  pruneGroupLinks(node, target, prefix, info);

  let missing = 0;
  for (let i = 0; i < cap; i++) {
    let idx = ensureAutogrowInput(target, prefix, info, i);
    if (idx === -1) {
      // 槽还没被前端扩出来。前面若刚好是「同源跳过」，扩张不会被触发，
      // 这里断开重连一次把前端唤醒；唤醒不了就记补试等下一轮。
      if (growAutogrowByReconnect(node, target, prefix)) {
        idx = ensureAutogrowInput(target, prefix, info, i);
      }
      if (idx === -1) {
        missing++;
        continue;
      }
    }
    connectSlot(node, i, target, idx);
  }

  // 多余的槽位断开（例如图片被删掉了）。
  // 先快照再遍历：autogrow 在断线时会顺手删掉末尾的空槽，
  // 直接遍历 target.inputs 会边改边读导致漏处理。
  const snapshot = target.inputs.slice();
  for (const inp of snapshot) {
    if (!isGroupSlot(prefix, inp.name)) continue;
    // 按尾部数字判断是否超出 cap（TemplateNames 1 基 / TemplatePrefix 0 基，
    // 这里统一换算成本组序号：用 slotLocalName 反查最稳妥）
    const ord = ordinalOfSlot(prefix, info, inp.name);
    if (ord === null || ord < cap) continue;
    const idx = target.inputs.indexOf(inp);
    // 这里不再用 inp.link != null 预判：脏数据里 link 可能指向别处而槽上仍有孤儿
    if (idx !== -1) disconnectSlot(target, idx);
  }

  if (missing > 0) markRetry(node);
  target.setDirtyCanvas?.(true, true);
}

/** 槽名 -> 本组内序号（0 基）；不是本组返回 null */
function ordinalOfSlot(groupPrefix, info, fullName) {
  if (!isGroupSlot(groupPrefix, fullName)) return null;
  const names = info?.names;
  if (Array.isArray(names) && names.length) {
    const local = fullName.slice(groupPrefix.length + 1);
    const i = names.indexOf(local);
    if (i !== -1) return i;
  }
  // TemplatePrefix：直接用生成函数反查，保证与 slotLocalName 口径一致
  const local = fullName.slice(groupPrefix.length + 1);
  for (let ord = 0; ord < (info?.max ?? 16) + 1; ord++) {
    if (slotLocalName(groupPrefix, info, ord) === local) return ord;
  }
  return null;
}

/** 把本节点的图片按顺序连到目标节点 */
function syncConnections(node, opts = {}) {
  // 载入/重建期间不许建链：这时候图是半成品，建出来的线会和
  // 前端稍后恢复的存档连线叠在一起（详见上面「载入期保护」的说明）。
  // 记一笔，等 afterConfigureGraph 之后的收口统一处理。
  if (!opts.force && graphBusy()) {
    node.__tyNeedSettle = true;
    return;
  }
  const files = getImageFiles(node);
  if (files.length === 0) {
    // 图片清空 -> 目标节点上所有由本节点提供的连线都断开
    const graph = node.graph || app.graph;
    const targets = collectTargets(node);
    for (const t of targets) {
      const ag = findImageAutogrow(t);
      const st = staticCfgOf(t);
      // 快照遍历：断线会让 autogrow 增删末尾槽位，边改边读会漏
      for (const inp of t.inputs?.slice() || []) {
        const isAutoSlot = ag && isGroupSlot(ag.prefix, inp.name);
        const isStaticSlot = !!st && st.slotOrder(inp.name) >= 0;
        if (!isAutoSlot && !isStaticSlot) continue;
        const idx = t.inputs.indexOf(inp);
        if (idx === -1) continue;
        // 同样不能靠 inp.link 预判：槽上可能只剩本节点留下的孤儿
        const mine = linksIntoSlot(graph, t.id, idx).some(
          (l) => (l.origin_id ?? null) === node.id
        );
        if (mine || inp.link != null) disconnectSlot(t, idx);
      }
    }
    // 断线全部处理完，再收敛输出槽（顺序很重要：反了会留悬空 link）
    syncOutputSlots(node, 1);
    return;
  }

  const targets = collectTargets(node);
  if (targets.length === 0) {
    console.debug("[TaiYangMultiImage] 未找到可连接的多图接入目标节点");
    // 没有目标节点时也要让输出槽跟着图片数走
    syncOutputSlots(node, files.length);
    // 对端节点可能还没建好输入槽，先记一次补试
    markRetry(node);
    return;
  }

  // 关键顺序：先把输出槽扩够，再连线，最后才收缩。
  // 少了第一步，第 N 张图连线时 outputs[N-1] 还不存在，connectSlot 会静默失败
  //（表现为最后一张图始终连不上）。
  growOutputSlots(node, files.length);
  const before = node._retryCount || 0;
  for (const t of targets) syncOneTarget(node, t, files.length);
  // 一次同步下来没有产生新的补试请求 -> 说明都连上了，清零计数
  if ((node._retryCount || 0) === before) clearRetry(node);
  // 收尾统一调整输出槽数量：几张图就显示几个 image_N
  syncOutputSlots(node, files.length);
}

/** 目标节点刚被创建时，反向把已有图片接上去 */
function syncAllLoaders() {
  const graph = app.graph;
  if (!graph) return;
  // 载入期一律不动：新建的其实是「正在被 configure 的存档节点」，
  // 这时候接线会和随后恢复的存档连线重复
  if (graphBusy()) {
    scheduleSettle();
    return;
  }
  for (const n of graph._nodes || []) {
    if (n.type !== NODE_NAME) continue;
    if (getImageFiles(n).length === 0) continue;
    syncConnections(n);
  }
}

// ---------------------------------------------------------------- 连线补试
// 工作流刚载入时，对端节点（尤其第三方节点）的输入槽可能还没初始化完，
// 那时 syncConnections 找不到目标槽会静默跳过，导致一直连不上。
// 这里用「延迟 + 有限次数」补试，成功后自动停止。

const RETRY_DELAYS = [120, 400, 1000, 2200, 4000];  // ms
const RETRY_MAX = RETRY_DELAYS.length;

/** 标记某个 loader 需要补试连线 */
function markRetry(node) {
  if (!node) return;
  if ((node._retryCount || 0) >= RETRY_MAX) return;
  node._retryCount = (node._retryCount || 0) + 1;
  const n = node._retryCount;
  setTimeout(() => {
    // 期间节点可能被删了 / 图被换掉
    const g = app?.graph;
    if (!g || !(g._nodes || []).includes(node)) return;
    if (getImageFiles(node).length === 0) return;
    // 补试正好撞上「又切了一次工作流」：别在这里接线（会重复），
    // 把次数还回去，改由载入结束后的收口统一处理
    if (graphBusy()) {
      node._retryCount = Math.max(0, n - 1);
      scheduleSettle();
      return;
    }
    syncConnections(node);
  }, RETRY_DELAYS[n - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1]);
}

/** 连线成功后清零计数（用户手动改图/拖拽时也要重置） */
function clearRetry(node) {
  if (node) node._retryCount = 0;
}

// ---------------------------------------------------------------- 上传

async function uploadOne(file) {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("type", "input");
  const res = await fetch("/upload/image", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// ---------------------------------------------------------------- 节点注册

app.registerExtension({
  name: "ComfyUI.TaiYangMultiImageLoader",

  // 工作流载入（含切标签页、撤销、导入）会用 loadGraphData 把整张图拆掉重建。
  // 这一对钩子是前端唯二能覆盖「从头到尾」的时机：
  //   beforeConfigureGraph -> 打上「在载入」标记，期间禁止一切建链/断线
  //   afterConfigureGraph  -> 载入完成，做收口（清脏线 + 按需补线）
  beforeConfigureGraph() {
    beginGraphLoad();
  },

  afterConfigureGraph() {
    endGraphLoad();
  },

  setup() {
    // 排查入口：控制台执行 __tyAuditImageLinks() 打印全部连线（含孤儿/错位）
    window.__tyAuditImageLinks = auditImageLinks;
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    // 目标节点：新建时反向触发一次连线。
    // 这里对**所有**节点类型挂这个钩子，而不是只挑已知几个：
    // 注册期拿不到实例的 comfyDynamic（autogrow 定义此时还没生成），
    // 无法判断它是不是多图接入节点，所以统一挂载、由 syncAllLoaders 运行时判断。
    // 代价只是极轻量的一次 setTimeout，非目标节点会立刻跳过。
    if (nodeData.name !== NODE_NAME) {
      const origTargetCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = origTargetCreated ? origTargetCreated.apply(this, arguments) : undefined;
        setTimeout(() => {
          // 只有确实带「多图接入 autogrow 组」的节点才触发反向连线
          if (findImageAutogrow(this) || staticCfgOf(this)) syncAllLoaders();
        }, 80);
        return r;
      };
      return;
    }

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated ? origCreated.apply(this, arguments) : undefined;
      this._qwenImages = [];
      this._qwenImgCache = {};
      this._gridPos = null;
      this._hoverCell = -1;
      this._hoverScaleBar = false;
      this._hoverScaleMp = false;
      this._hoverScaleSteps = false;
      // 拖拽状态（统一模型，见「拖拽排序（纯逻辑）」）：
      //   _press      已按下待判定 { from, x, y }
      //   _drag       已确认拖拽 { from, to }
      //   _anim       让位动画 { fromOrder, toOrder, t }
      //   _shownOrder 当前显示中的顺序（动画起点用）
      this._press = null;
      this._drag = null;
      this._anim = null;
      this._shownOrder = null;
      this._animRaf = null;

      this.size[0] = NODE_W;
      this.size[1] = NODE_H;

      // 新建节点先只留 1 个输出，加图后再长出来
      syncOutputSlots(this, getImageFiles(this).length || 1);

      // 老工作流按序号对齐时可能错位，这里自愈一下
      const modeWidget = getWidget(this, "auto_link");
      if (modeWidget && typeof modeWidget.value === "number" && !MODE_OPTIONS[modeWidget.value]) {
        modeWidget.value = MODE_AUTO;
      }

      // ------------------------------------------------------------------
      // 关于 auto_link 控件的位置（这里踩了三次坑，结论很重要）：
      //
      // ComfyUI 1.5x 前端会给每个**非 hidden** 的 widget 在画布上生成一个
      // 绝对定位的 DOM 元素盖在节点上，用来接收鼠标/输入事件。
      // 于是：
      //  1) 插一个高 spacer widget        -> DOM 覆盖网格 -> 点 + 没反应
      //  2) image_files 设 hidden          -> 布局里被 continue 跳过，高度为 0，撑不开
      //  3) image_files 不 hidden + 高高度  -> 又变成 612px DOM 盖住网格 -> 还是没反应
      //
      // 所以凡是「高、且要盖在网格上」的占位一律不可行。
      // 最终方案：所有 widget 都设 hidden（不产生 DOM、不占高度），
      // auto_link 与缩放参数的外观由 onDrawForeground 自己画，点击由 onMouseDown 处理，
      // 完全绕开 widget 的 DOM 层与布局。
      // widget 仍留在 widgets 数组里，后端才能按名字拿到值。
      const hideWidget = (w) => {
        if (!w) return;
        w.dontHide = true;
        w.hidden = true;
        w.computeSize = () => [0, 0];
        w.draw = () => {};
      };
      hideWidget(getWidget(this, "image_files"));
      hideWidget(getWidget(this, "upscale_method"));
      hideWidget(getWidget(this, "megapixels"));
      hideWidget(getWidget(this, "resolution_steps"));
      hideWidget(modeWidget);

      return r;
    };

    // 载入工作流时从 widget / properties 还原缩略图
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;

      const w = getWidget(this, "image_files");
      if ((!w || !w.value || w.value === "[]") && this.properties?.image_files) {
        if (w) w.value = this.properties.image_files;
      }
      // 恢复手动指定的目标
      this._qwenManualTarget = this.properties?.auto_link_target || null;
      const files = getImageFiles(this);
      this._qwenImages = files.slice();
      this._qwenImgCache = {};
      files.forEach((name, i) => {
        this._qwenImgCache[i] = makeThumb(name);
      });

      // 载入工作流时按图片数收敛输出槽。
      // 下限取「已连线的输出数」，避免把工作流里存着的有效连线给剪掉。
      //
      // 载入期跳过：这时候 outputs[i].links 还是空的（link 尚未恢复），
      // linkedCount 数不准，贸然 removeOutput 会把还没恢复的存档连线一起删掉。
      // 输出槽的收敛交给载入后的收口（settleLoader -> syncConnections）。
      if (!graphBusy()) {
        const linkedCount = (this.outputs || []).filter((o) => (o.links || []).length > 0).length;
        syncOutputSlots(this, Math.max(files.length, linkedCount));
      }

      // 老工作流可能存着过窄的宽度（没留输出槽标签的位置），这里强制拉齐宽度，
      // 否则载入后右侧标签仍会压在图片上。
      // 高度**不**按NODE_H 拉满：最小高度是动态的（按已用行数），
      // 图片少时节点应该允许更矮，多余空间留着反而空。clampNodeSize 负责兜下限。
      clampNodeSize(this);
      if (this.size[0] < NODE_W) this.size[0] = NODE_W;
      this.setDirtyCanvas?.(true, true);

      // 载入后按已保存的连线重建一次缺失的槽位。
      //
      // 但**载入期绝对不许动**：切标签页会走 loadGraphData 把整张图拆了重建，
      // 此时对端节点还没 configure 完、存档里的线也还没恢复回来，
      // 在这里建链 -> 稍后前端又把存档的线恢复一遍 -> 同一个槽两条线，
      // 就是「本来对的，切走再切回来就乱了」。所以载入期只打标记，
      // 由 afterConfigureGraph 之后的收口统一处理（清脏线 + 补缺失）。
      this._retryCount = 0;
      if (graphBusy()) {
        this.__tyNeedSettle = true;
      } else {
        syncConnections(this);
      }
      return r;
    };

    /**
     * 手动缩放节点时钳住最小尺寸。
     * 缩到小于「网格 + 底部控件区」时，底部两条控件会和图片/彼此重叠，
     * 这里直接顶回下限，用户拖不动更小。
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
        this.properties.image_files = getWidget(this, "image_files")?.value ?? "[]";
        // 记住手动指定的目标，载入后仍生效
        if (this._qwenManualTarget) this.properties.auto_link_target = this._qwenManualTarget;
        else delete this.properties.auto_link_target;
      }
      return origSerialize ? origSerialize.apply(this, arguments) : this;
    };

    // 菜单：手动指定目标 / 重连 / 断开
    const origMenu = nodeType.prototype.getNodeMenuItems;
    nodeType.prototype.getNodeMenuItems = function (opts) {
      const items = origMenu ? origMenu.apply(this, arguments) : [];

      // ---- 手动指定自动连线目标（需求3：支持任意多图接入节点）----
      // 自动模式已在「自动发现」里覆盖所有带 images / ref_images 组名的节点；
      // 这里让用户可以显式锁定某个节点类型，覆盖白名单之外的节点。
      const graph = this.graph || app.graph;
      const present = [...new Set((graph?._nodes || []).map((n) => n.type))].filter(
        (t) => t && t !== NODE_NAME
      );
      const capable = present.filter((t) => {
        const n = (graph._nodes || []).find((x) => x.type === t);
        return n && (findImageAutogrow(n) || staticCfgOf(n));
      });
      const others = present.filter((t) => !capable.includes(t));

      const pickTarget = (node, type) => {
        node._qwenManualTarget = type;
        syncConnections(node);
        node.setDirtyCanvas(true, true);
      };
      const backToAuto = (node) => {
        node._qwenManualTarget = null;
        syncConnections(node);
        node.setDirtyCanvas(true, true);
      };
      const asRows = (types, node) => [
        ...types.map((t) => ({
          content: `　→ ${t}${node._qwenManualTarget === t ? "  ✓当前" : ""}`,
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

      // ---- 缩放（等价内置 ImageScaleToTotalPixels）----
      // 百万像素与分辨率倍数都支持填任意数字（底部缩放条左键，或这里）
      const curMp = getMegapixels(this);
      const curMethod = getUpscaleMethod(this);
      const curSteps = getResolutionSteps(this);
      items.push({
        content: `🔍 缩放：输入百万像素（当前：${curMp > 0 ? `${trimNum(curMp)} MP` : "关闭"}）`,
        callback: () => editScale(this, "mp"),
      });
      items.push({
        content: `🔢 分辨率倍数：输入数字（当前：×${curSteps}）`,
        callback: () => editScale(this, "steps"),
      });
      items.push({
        content: "⏹ 关闭缩放（保持原分辨率）",
        callback: () => setMegapixels(this, 0),
      });
      items.push({
        content: `⚙ 插值算法（当前：${curMethod}）`,
        callback: () =>
          items.push(
            ...UPSCALE_METHODS.map((m) => ({
              content: `　${m}${curMethod === m ? "  ✓当前" : ""}`,
              callback: () => setUpscaleMethod(this, m),
            }))
          ),
      });

      // 多图节点子菜单：自动发现已覆盖这类，手动指定用于锁定/排除
      if (capable.length) {
        items.push({
          content: `🎯 指定多图目标${this._qwenManualTarget ? `（当前：${this._qwenManualTarget}）` : ""}`,
          callback: () => items.push(...asRows(capable, this)),
        });
      }
      // 其余节点类型：白名单外的节点，按类型手动指定
      if (others.length) {
        items.push({
          content: `🧩 指定其他节点为目标${this._qwenManualTarget && others.includes(this._qwenManualTarget) ? `（当前：${this._qwenManualTarget}）` : ""}`,
          callback: () => items.push(...asRows(others, this)),
        });
      }
      if (this._qwenManualTarget) {
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
    // 布局常量统一在文件顶部定义（NODE_W / NODE_H / CELL / GAP ...）
    const GRID = { cell: CELL, gap: GAP, cols: COLS, startX: START_X, startY: HEADER_H };

    const origDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      origDraw?.apply(this, arguments);

      // 已挂 DOM 面板（multi_image_dom.js）时不再自绘：
      // Node 2.0（Vue 节点）根本不画画布，自绘内容会整个消失，
      // 所以界面统一交给 DOM，画布这边只负责“什么都不画”。
      if (this.__tyDomPanel) return;

      // 折叠时必须整体跳过自绘：LiteGraph 折叠后仍会调用 onDrawForeground，
      // 若继续画，网格与底部条会跑到节点框外的画布上（节点只剩一条标题栏）。
      if (isCollapsed(this)) return;

      // 节点被手动缩小后，本节点的布局常量（NODE_W/NODE_H）会大于实际尺寸，
      // 自绘内容就会溢出到节点框外。这里用 clip 把整个自绘限制在节点真实范围内，
      // 无论节点被缩到多小都不会画到框外。收尾在末尾 restore。
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.size[0], this.size[1]);
      ctx.clip();

      const images = this._qwenImages || [];
      const { cell, gap, cols, startX, startY } = GRID;
      this._gridPos = { ...GRID };

      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";

      // 连线状态
      // 注意：这里必须按「有连线的输出槽个数」计数，不能按 link 条数累加。
      // 同一个输出会同时连到 Qwen / H3 / Star7 等多个目标节点，
      // 4 张图 × 3 个目标 = 12 条 link，若按条数统计会显示「已连线 12」，
      // 而实际只有 4 张图接上了——数字对不上就是这个 bug。
      let linked = 0;
      const graph = this.graph || app.graph;
      for (const out of this.outputs || []) {
        const hasLive = (out.links || []).some((lid) => getLink(graph, lid));
        if (hasLive) linked++;
      }

      // 标题/状态文字要居中在「网格区」而不是整个节点，
      // 否则右侧多留的槽位标签空白会让文字整体偏左。
      const gridW = COLS * CELL + (COLS - 1) * GAP;
      const centerX = START_X + gridW / 2;

      ctx.fillStyle = "#8fd0ff";
      ctx.font = "bold 13px Arial";
      ctx.fillText(
        `参考图 ${images.length}/${MAX_IMAGES}   已连线 ${linked}`,
        centerX,
        startY - 34
      );

      // 手动指定了目标就显示出来，方便确认当前绑的是哪个节点
      const manual = this._qwenManualTarget;
      const dragging = !!this._drag;
      ctx.fillStyle = dragging
        ? "#ffd479"
        : linked === images.length && images.length > 0
          ? "#8fe08f"
          : "#c8c8c8";
      ctx.font = "12px Arial";
      ctx.fillText(
        images.length === 0
          ? "点击下方 + 添加图片（可多选，最多 16 张）"
          : dragging
            ? "松开放置 · 顺序改变后连线会自动跟随"
            : linked === images.length
              ? `✓ 已连接${manual ? " " + manual : " 多图节点"} · 可拖动图片调顺序`
              : `还有 ${images.length - linked} 张未连接`,
        centerX,
        startY - 16
      );

      // ------------------------------------------------------------------
      // 绘制图片网格（含拖拽让位动画）
      //
      // 统一模型：order[p] = 位置 p 上放原来第几张图。
      // 每张图 i 的渲染位置 = 它在动画起点顺序里的槽 -> 终点顺序里的槽，按 t 插值。
      // 被拿起的图和让位的图走同一套逻辑，没有特例分支。
      // ------------------------------------------------------------------
      const count = images.length;
      const drag = this._drag;
      const targetOrder =
        (drag ? computeOrder(count, drag.from, drag.to) : null) || identityOrder(count);
      // 动画起点 = 上一次的目标顺序；没有动画时起止相同，图静止在新位置
      const anim = this._anim;
      const fromOrder = anim ? anim.fromOrder : targetOrder;
      const toOrder = anim ? anim.toOrder : targetOrder;
      const t = anim ? anim.t : 1;

      // 格子坐标
      const cx = (i) => startX + (i % cols) * (cell + gap);
      const cy = (i) => startY + Math.floor(i / cols) * (cell + gap);

      for (let i = 0; i < count; i++) {
        const slotFrom = fromOrder.indexOf(i);
        const slotTo = toOrder.indexOf(i);
        const x = cx(slotFrom) + (cx(slotTo) - cx(slotFrom)) * t;
        const y = cy(slotFrom) + (cy(slotTo) - cy(slotFrom)) * t;

        const isHover = this._hoverCell === i;
        const isGrabbed = !!drag && drag.from === i;   // 正被按住的那张
        const isShifted = slotFrom !== slotTo;          // 正在移动（让位/归位）

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

        const img = this._qwenImgCache[i];
        const RES_BAR_H = 18; // 底部分辨率条高度
        if (img && img.complete && img.naturalWidth > 0) {
          // 固定区域内显示**完整**图片：用 Math.min 保证整张图都在框内（contain）
          const scale = Math.min(cell / img.naturalWidth, cell / img.naturalHeight);
          const w = img.naturalWidth * scale;
          const h = img.naturalHeight * scale;
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(x, y, cell, cell, 6);
          ctx.clip();
          // 给底部分辨率条让出空间：图片只在「格子 - 条高」的区域里 contain
          const availH = cell - RES_BAR_H;
          const scale2 = Math.min(cell / img.naturalWidth, availH / img.naturalHeight);
          const w2 = img.naturalWidth * scale2;
          const h2 = img.naturalHeight * scale2;
          ctx.drawImage(img, x + (cell - w2) / 2, y + (availH - h2) / 2, w2, h2);
          ctx.restore();
        }

        // ---------------------------------------------------------------
        // 分辨率条：显示**缩放后**的实际尺寸（真正送进模型的分辨率），
        // 缩放关闭时就是原图尺寸。与内置 ImageScaleToTotalPixels 同一套公式。
        // -----------------------------------------------------------------
        const nat = img && img.complete && img.naturalWidth > 0 ? img : null;
        if (nat) {
          const mp = getMegapixels(this);
          // 必须用真实的 resolution_steps，否则显示的分辨率与实际送进模型的不一致
          const [dw, dh] = scaledSize(nat.naturalWidth, nat.naturalHeight, mp, getResolutionSteps(this));
          const by = y + cell - RES_BAR_H;
          ctx.fillStyle = "rgba(12,16,20,0.82)";
          ctx.beginPath();
          // 下两角贴格、上面平齐，形成贴底的信息条
          ctx.moveTo(x, by);
          ctx.lineTo(x + cell, by);
          ctx.lineTo(x + cell, y + cell - 6);
          ctx.quadraticCurveTo(x + cell, y + cell, x + cell - 6, y + cell);
          ctx.lineTo(x + 6, y + cell);
          ctx.quadraticCurveTo(x, y + cell, x, y + cell - 6);
          ctx.closePath();
          ctx.fill();

          const scaled = mp > 0;
          ctx.fillStyle = scaled ? "#8fe08f" : "#c8d2dc";
          ctx.font = "11px Arial";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            scaled ? `${dw} × ${dh}` : `${nat.naturalWidth} × ${nat.naturalHeight}`,
            x + cell / 2,
            by + RES_BAR_H / 2
          );
          ctx.textBaseline = "alphabetic";
        }
        // 序号角标
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.font = "bold 12px Arial";
        ctx.fillText(String(i + 1), x + 16, y + 18);

        // 删除按钮：拖拽期间隐藏，避免和拖动手势冲突
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

      // 加号格：固定排在所有图片后面
      if (count < MAX_IMAGES) {
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
        ctx.fillText("添加图片", ax + c, ay + c + 44);
      }

      // ---------------------------------------------------------- 底部缩放条
      // 等价内置 ImageScaleToTotalPixels：按总像素数缩放。
      // 左区=目标百万像素，右区=分辨率整数倍，两区都可点击填任意数字。
      // 宽度跟随节点实际宽度，位置用 bottomLayout 贴着节点底边（随缩放一起动）。
      const sbw = Math.max(80, this.size[0] - 24);
      const sbx = 12;
      const { scaleY: sby, modeY } = bottomLayout(this.size[1]);
      const mp = getMegapixels(this);
      const steps = getResolutionSteps(this);
      // 左区要放得下「缩放图像 0 百万像素(填0不缩放)」，左区给 58% 宽
      const splitX = sbx + sbw * 0.58;
      this._scaleBar = { x: sbx, y: sby, w: sbw, h: SCALE_BAR_H };
      this._scaleMpZone = { x: sbx, y: sby, w: splitX - sbx, h: SCALE_BAR_H };
      this._scaleStepsZone = { x: splitX, y: sby, w: sbx + sbw - splitX, h: SCALE_BAR_H };

      const hoverMp = this._hoverScaleMp === true;
      const hoverSteps = this._hoverScaleSteps === true;

      // 底板
      ctx.fillStyle = "#2a2f36";
      ctx.beginPath();
      ctx.roundRect(sbx, sby, sbw, SCALE_BAR_H, 5);
      ctx.fill();

      // 左区：缩放图像 <N> 百万像素(填0不缩放)
      ctx.fillStyle = hoverMp ? "#3d4a58" : "#2a2f36";
      ctx.beginPath();
      ctx.roundRect(sbx, sby, splitX - sbx - 1, SCALE_BAR_H, 5);
      ctx.fill();
      ctx.strokeStyle = hoverMp ? "#8fd0ff" : "#4a5560";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const barMidY = sby + SCALE_BAR_H / 2 + 1;
      // 铅笔图标（提示可点击编辑）
      ctx.fillStyle = hoverMp ? "#8fd0ff" : "#7d8894";
      ctx.font = "11px Arial";
      const iconW = ctx.measureText("✎").width;
      ctx.fillText("✎", sbx + 8, barMidY);

      // 「缩放图像」
      ctx.fillStyle = hoverMp ? "#eaf6ff" : "#c8d2dc";
      ctx.font = "12px Arial";
      const prefix = "缩放图像 ";
      const prefixW = ctx.measureText(prefix).width;
      const px = sbx + 8 + iconW + 4;
      ctx.fillText(prefix, px, barMidY);

      // 数值（缩放生效时高亮绿色）
      ctx.fillStyle = hoverMp ? "#eaf6ff" : mp > 0 ? "#8fe08f" : "#8a939c";
      ctx.font = "bold 12px Arial";
      const valText = trimNum(mp);
      const valW = ctx.measureText(valText).width;
      ctx.fillText(valText, px + prefixW, barMidY);

      // 「百万像素(填0不缩放)」
      ctx.fillStyle = hoverMp ? "#c8d2dc" : "#7d8894";
      ctx.font = "11px Arial";
      ctx.fillText(" 百万像素(填0不缩放)", px + prefixW + valW, barMidY);

      // 分隔线
      ctx.strokeStyle = "#4a5560";
      ctx.beginPath();
      ctx.moveTo(splitX, sby + 4);
      ctx.lineTo(splitX, sby + SCALE_BAR_H - 4);
      ctx.stroke();

      // 右区：分辨率对齐N整数倍（默认 32，点击可改）
      ctx.fillStyle = hoverSteps ? "#3d4a58" : "#2a2f36";
      ctx.beginPath();
      ctx.roundRect(splitX + 1, sby, sbx + sbw - splitX - 1, SCALE_BAR_H, 5);
      ctx.fill();
      ctx.strokeStyle = hoverSteps ? "#8fd0ff" : "#4a5560";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = "left";
      const sx = splitX + 8;
      // 「分辨率对齐」
      ctx.fillStyle = hoverSteps ? "#eaf6ff" : "#c8d2dc";
      ctx.font = "11px Arial";
      const sPrefix = "分辨率对齐";
      const sPrefixW = ctx.measureText(sPrefix).width;
      ctx.fillText(sPrefix, sx, barMidY);
      // 数值（高亮，一眼看到当前值）
      ctx.fillStyle = hoverSteps ? "#eaf6ff" : "#8fd0ff";
      ctx.font = "bold 12px Arial";
      const sVal = String(steps);
      const sValW = ctx.measureText(sVal).width;
      ctx.fillText(sVal, sx + sPrefixW, barMidY);
      // 「整数倍」
      ctx.fillStyle = hoverSteps ? "#eaf6ff" : "#c8d2dc";
      ctx.font = "11px Arial";
      ctx.fillText("整数倍", sx + sPrefixW + sValW, barMidY);
      ctx.textBaseline = "alphabetic";

      // ---------------------------------------------------------- 底部模式条
      // auto_link 不再用 widget 渲染（widget 会生成 DOM 覆盖层挡住网格），
      // 改为自绘：点一下在「自动 / 关闭」之间切换，长按菜单里可细选。
      // 宽度跟随节点实际宽度，位置用 bottomLayout 算出的 modeY（贴底）。
      const bw = Math.max(80, this.size[0] - 24);
      const bh = BAR_H;
      const bx = 12;
      const by = modeY;
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
      // 右侧小三角，提示可点击切换
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

/** 底部模式条的命中判定 */
const barAt = function (node, pos) {
  const b = node._modeBar;
  if (!b || !withinNode(node, pos)) return false;
  return pos[0] >= b.x && pos[0] <= b.x + b.w && pos[1] >= b.y && pos[1] <= b.y + b.h;
};

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

/** 底部缩放条的命中判定 */
const scaleBarAt = function (node, pos) {
  const b = node._scaleBar;
  if (!b || !withinNode(node, pos)) return false;
  return pos[0] >= b.x && pos[0] <= b.x + b.w && pos[1] >= b.y && pos[1] <= b.y + b.h;
};

/** 缩放条左半区（百万像素）命中判定 */
const scaleMpZoneAt = function (node, pos) {
  const b = node._scaleMpZone;
  if (!b || !withinNode(node, pos)) return false;
  return pos[0] >= b.x && pos[0] <= b.x + b.w && pos[1] >= b.y && pos[1] <= b.y + b.h;
};

/** 缩放条右半区（分辨率倍数）命中判定 */
const scaleStepsZoneAt = function (node, pos) {
  const b = node._scaleStepsZone;
  if (!b || !withinNode(node, pos)) return false;
  return pos[0] >= b.x && pos[0] <= b.x + b.w && pos[1] >= b.y && pos[1] <= b.y + b.h;
};

/**
 * 点击缩放条：弹窗输入精确数字。
 * 左区=百万像素（0 关闭，最大 16），右区=分辨率倍数（整数，1~256）。
 * 都用原生 prompt，不产生 DOM 覆盖层（见 onNodeCreated 里的坑注释）。
 */
const editScale = function (node, zone) {
  if (zone === "mp") {
    const cur = getMegapixels(node);
    const v = promptNumber("缩放：输入目标百万像素（0 = 关闭缩放）\n例如 1 表示总像素约 1024×1024", cur, {
      min: 0,
      max: 16,
    });
    if (v == null) return;
    setMegapixels(node, v);
    return;
  }
  const curSteps = getResolutionSteps(node);
  const v = promptNumber(
    `分辨率对齐整数倍（默认 ${DEFAULT_STEPS}，范围 1~256）\n宽高会对齐到该数字的整数倍`,
    curSteps,
    { min: 1, max: 256, integer: true }
  );
  if (v == null) return;
  setResolutionSteps(node, v);
};

    // ------------------------------------------------------------ 鼠标
    /** 格子命中判定：图片格 0..n-1，加号格固定是 n */
    const cellAt = function (node, pos) {
      if (!withinNode(node, pos)) return -1;
      const { cell, gap, cols, startX, startY } = GRID;
      const n = (node._qwenImages || []).length;
      const total = n < MAX_IMAGES ? n + 1 : n;
      for (let i = 0; i < total; i++) {
        const x = startX + (i % cols) * (cell + gap);
        const y = startY + Math.floor(i / cols) * (cell + gap);
        if (pos[0] >= x && pos[0] <= x + cell && pos[1] >= y && pos[1] <= y + cell) return i;
      }
      return -1;
    };

    /**
     * 推进让位动画：从 fromOrder 过渡到 toOrder。
     * 每次拖拽目标变化都会以「当前显示的顺序」为起点重新开一段，
     * 所以连续移动时图片是连贯地跟着走，不会跳。
     */
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
      // DOM 面板接管后，画布上不再有可点的网格 / 缩放条
      if (this.__tyDomPanel) return origMove?.apply(this, arguments);

      // 折叠时不更新 hover / 拖拽，自绘区域已不再显示
      if (isCollapsed(this)) return origMove?.apply(this, arguments);

      // 1) 已按下但未越阈值：等到越过阈值才升级为拖拽（保证单击无动作）
      if (this._press && !this._drag) {
        const dx = pos[0] - this._press.x;
        const dy = pos[1] - this._press.y;
        if (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD) {
          this._drag = { from: this._press.from, to: this._press.from };
          this._press = null;
          this.setDirtyCanvas(true, true);
          return true;
        }
        return true; // 待定状态，什么也不做
      }

      // 2) 拖拽中：更新落点，变了就重播一段让位动画
      if (this._drag) {
        const over = cellAt(this, pos);
        const n = (this._qwenImages || []).length;
        // 加号格（index === n）不是合法落点，忽略
        const target = over >= 0 && over < n ? over : this._drag.to;
        if (target !== this._drag.to) {
          this._drag.to = target;
          const next = computeOrder(n, this._drag.from, target);
          if (next) animateTo(this, next);
        }
        return true; // 吃掉事件，避免 LiteGraph 同时进入连线/拖动状态
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
      const onScale = scaleBarAt(this, pos);
      if (onScale !== this._hoverScaleBar) {
        this._hoverScaleBar = onScale;
        this.setDirtyCanvas(true, true);
      }
      const onMp = scaleMpZoneAt(this, pos);
      if (onMp !== this._hoverScaleMp) {
        this._hoverScaleMp = onMp;
        this.setDirtyCanvas(true, true);
      }
      const onSteps = scaleStepsZoneAt(this, pos);
      if (onSteps !== this._hoverScaleSteps) {
        this._hoverScaleSteps = onSteps;
        this.setDirtyCanvas(true, true);
      }
      return origMove?.apply(this, arguments);
    };

    const origUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function (e, pos) {
      // DOM 面板接管后，拖拽排序走 HTML5 drag / drop，画布这边不再介入
      if (this.__tyDomPanel) return origUp?.apply(this, arguments);

      // 1) 单击（按下后没越过阈值）：静默复位，不产生任何变化
      if (this._press) {
        resetDrag(this);
        return true;
      }

      // 2) 拖拽结束：落盘顺序 + 重建连线
      if (this._drag) {
        const { from, to } = this._drag;
        const images = this._qwenImages || [];
        const willReorder = to != null && to >= 0 && to < images.length && to !== from;
        resetDrag(this);
        if (willReorder) {
          setImages(this, reorderList(images, from, to));
          // 顺序变了 -> 必须重连，下游 image_N 会跟着换图
          syncConnections(this);
        }
        return true;
      }

      return origUp?.apply(this, arguments);
    };

    const origDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      // DOM 面板接管后，点击全在 DOM 里处理；这里必须放行，
      // 否则会按几何位置误判成“点在缩放条 / 模式条上”而吃掉事件
      if (this.__tyDomPanel) return origDown?.apply(this, arguments);

      // 折叠时节点只剩标题栏，自绘区域全部不可交互，直接交回 LiteGraph
      if (isCollapsed(this)) return origDown?.apply(this, arguments);

      // 底部缩放条：左半区改百万像素，右半区改分辨率倍数（弹窗填任意数字）
      if (e?.button === 0 && scaleBarAt(this, pos)) {
        if (scaleStepsZoneAt(this, pos)) editScale(this, "steps");
        else if (scaleMpZoneAt(this, pos)) editScale(this, "mp");
        return true;
      }

      // 底部模式条：左键在「自动 / 关闭」间切换；有手动目标时先清掉手动目标
      if (barAt(this, pos)) {
        if (this._qwenManualTarget) {
          this._qwenManualTarget = null;
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

      const images = this._qwenImages || [];
      const { cell, gap, cols, startX, startY } = GRID;
      const x = startX + (i % cols) * (cell + gap);
      const y = startY + Math.floor(i / cols) * (cell + gap);

      // 已有图片：优先判断右上角删除按钮
      if (i < images.length) {
        const bx = x + cell - 16;
        const by = y + 16;
        const dx = pos[0] - bx;
        const dy = pos[1] - by;
        if (dx * dx + dy * dy < 12 * 12) {
          const next = images.slice();
          next.splice(i, 1);
          setImages(this, next);
          syncConnections(this);
          return true;
        }
        // 左键按住图片 -> 只记录「待拖拽」，不立刻进入拖拽。
        // 只有移动超过 DRAG_THRESHOLD 才算真拖拽，这样单击不会有任何动作。
        if (e?.button === 0 || e?.button == null) {
          this._press = { from: i, x: pos[0], y: pos[1] };
          return true;
        }
      } else {
        // 唯一的空位（加号）：点了就追加上传
        if (images.length >= MAX_IMAGES) return true;
      }

      // 走到这里说明点在加号格上 -> 打开文件选择，追加到末尾
      // （点已有图片现在是拖拽排序，在上面已 return）
      const insertAt = images.length;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = async () => {
        const picked = Array.from(input.files || []);
        if (picked.length === 0) return;
        const uploaded = [];
        for (const f of picked) {
          try {
            uploaded.push(await uploadOne(f));
          } catch (err) {
            console.error("[TaiYangMultiImage] 上传失败:", f.name, err);
          }
        }
        if (uploaded.length === 0) return;
        const next = images.slice();
        uploaded.forEach((nm, k) => {
          next[insertAt + k] = nm;
        });
        // 上限 16 张
        setImages(this, next.filter(Boolean).slice(0, MAX_IMAGES));
        syncConnections(this);
      };
      input.click();
      return true;
    };
  },
});

/* ---------------------------------------------------------------------------
 * 供 multi_image_dom.js（DOM 面板）复用。
 * 业务逻辑只此一份，DOM 面板只负责画和收输入，避免两边各写一遍、行为漂移。
 * ------------------------------------------------------------------------- */
export {
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
  // 载入期保护与收口（测试需要直接驱动）
  beginGraphLoad,
  endGraphLoad,
  graphBusy,
  scheduleSettle,
  settleLoader,
  enforceGroupLinks,
  pruneDanglingOutputLinks,
};
