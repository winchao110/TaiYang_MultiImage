"""与 ComfyUI 0.43+ 的「显存编译图」（aimdo malloc graph）互斥。

为什么要这一步
--------------
ComfyUI 0.43 起，CUDA 上跑模型时会开一个 malloc graph：

    comfy/ldm/minimax/model.py:622   malloc_graph_begin(device)
    comfy/ldm/minimax/model.py:761   prefetch_queue_pop(..., malloc_scope="block")
    comfy/model_prefetch.py:210      malloc_graph.iterate("block")

它对每个 block 记录一遍 cudaMallocAsync 的申请/释放序列，编译成一份分配计划，
下一步照计划预占显存。前提是**块内的分配序列逐步完全一致**。

本包的两个节点（模型计算FP16 / H3 激活分块）恰好都破坏这个前提：

  · FP16 加速：残差流每块转 FP32、每层把 int8 权重反量化成 FP16（32 MiB/层 × 200 层）；
  · H3 激活分块：按 token 段申请 QKV/MLP 缓冲，最后一段长度与整段不同。

第一遍（Model Initializing，即 warmup）能录进计划，第二遍真实采样时这些临时块
被 PyTorch 缓存复用后再释放，与新建的计划对不上，aimdo 的 DLL 直接返回失败：

    RuntimeError: aimdo memory compile error

这不是数值问题，也不是我们算错了，是「逐块预编译分配计划」这个优化与
「块内动态申请临时显存」本质冲突。

处理方式
--------
启用这两个节点时，把 ComfyUI 自带的命令行开关 `--disable-comfy-compiler` 在运行时打开
（`args.disable_comfy_compiler = True`）。它的唯一作用就是让
`comfy.model_prefetch.malloc_graph_enabled()` 返回 False，也就是：
不再录/不再编译分配计划，其余（aimdo 动态显存 vbar、权重流式加载、预取队列）都不受影响。

多个节点可能同时要这个开关，所以用引用计数；节点关掉时归还，没人要了就恢复原值。
"""

import logging

_PREFIX = "[H3显存编译图]"
_OWNERS = set()
_SAVED = None


def _cli_args():
    try:
        from comfy.cli_args import args
    except Exception:
        return None
    return args


def _graph_active():
    """当前线程是否已经有一张在用的编译图（一般不会，节点执行时还没开始前向）。"""
    try:
        import comfy.model_prefetch as prefetch

        return bool(getattr(prefetch, "MALLOC_GRAPHS", None))
    except Exception:
        return False


def request(owner):
    """声明 owner 需要在块内动态分配显存 → 关掉显存编译图。返回是否发生了改动。"""
    global _SAVED

    if owner in _OWNERS:
        return False
    args = _cli_args()
    if args is None or not hasattr(args, "disable_comfy_compiler"):
        # 老版本 ComfyUI 没有这个特性，什么都不用做
        return False

    _OWNERS.add(owner)
    if getattr(args, "disable_comfy_compiler", False):
        # 用户自己就在用 --disable-comfy-compiler，不重复处理
        return False

    _SAVED = False
    args.disable_comfy_compiler = True
    logging.info(
        "%s 已关闭 ComfyUI 显存编译图（aimdo malloc graph）。原因：这两个节点会在每个 block 内部"
        "动态申请/释放临时显存（FP32 残差、逐层反量化权重、分块缓冲），与逐块预编译的分配计划"
        "不兼容，强行录制会报 aimdo memory compile error。动态显存加载、权重流式加载、"
        "预取队列都不受影响；节点全部关掉后自动恢复。",
        _PREFIX,
    )
    if _graph_active():
        logging.info("%s 检测到已有编译图在册，下一次前向起不再录制。", _PREFIX)
    return True


def release(owner):
    """owner 关闭时归还开关；所有 owner 都归还后恢复命令行原值。"""
    global _SAVED

    if owner not in _OWNERS:
        return False
    _OWNERS.discard(owner)
    if _OWNERS:
        return False

    args = _cli_args()
    if args is None or _SAVED is None:
        return False
    args.disable_comfy_compiler = _SAVED
    _SAVED = None
    logging.info("%s 这两个节点已全部关闭，显存编译图开关恢复为命令行原值。", _PREFIX)
    return True


def state():
    return {"owners": sorted(_OWNERS), "saved": _SAVED}
