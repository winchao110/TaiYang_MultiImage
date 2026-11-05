"""与 ComfyUI 0.43+ 的「显存编译图」（aimdo malloc graph）互斥 —— 只在本模型前向的这一瞬间让路。

为什么要让路
------------
ComfyUI 0.43 起，CUDA 上跑模型时会开一张 malloc graph：

    comfy/ldm/minimax/model.py    malloc_graph_begin(device)
    comfy/model_prefetch.py       prefetch_queue_pop(..., malloc_scope="block")

它对每个 block 记录一遍 cudaMallocAsync 的申请/释放序列，编译成一份分配计划，
下一步照计划预占显存。前提是**块内的分配序列逐步完全一致**。

本包的两个节点（模型计算FP16 / 显存分块加载）恰好都破坏这个前提：
残差流每块转 FP32、每层把 int8 权重反量化成 FP16（32 MiB/层）、按 token 段申请缓冲。
第二遍真实采样时这些临时块被 PyTorch 缓存复用后再释放，与计划对不上，aimdo 的 DLL
直接返回失败：

    RuntimeError: aimdo memory compile error

v1 的做法与它的两个坑
--------------------
v1 是运行时把命令行开关 `args.disable_comfy_compiler` 置 True，等节点被关掉再还原。
这有两个问题：

  1. 它改的是**整个进程**。开关一翻，之后所有模型（包括 25 GB 的 int8 文本编码器）
     都按「无分配计划」重新 staging。2080 Ti 上实测：文本编码器在开关翻转之后重新
     staging，会把 int8 convrot 反量化用的 vbar 映射搞坏，下一次前向直接
         RuntimeError: CUDA INT8 convrot dequantization failed: invalid argument
     而且这个坑不会自己好，只能重启 ComfyUI —— 也就是「跑完这个节点、再跑别的工作流
     就报错，必须重启」的真正原因。
  2. 节点一旦从工作流里拿掉，release() 永远不会被调用，开关就永久留在 True。

v2 的做法：按次作用域，一个全局开关都不碰
----------------------------------------
钩住 `comfy.model_prefetch.malloc_graph_enabled()` 与 `prefetch_queue_pop()`，
用一个**线程局部的深度计数**，只在本模型 forward 的调用栈里返回 False / 清掉
malloc_scope。`MiniMaxH3Model.forward` 开头那一句

    compile_allocations = comfy.model_prefetch.malloc_graph_enabled(x[0].device)

拿到 False 就整条走原生路径（不 begin、不 copy 到预分配缓冲、block 作用域也不
iterate），效果与 `--disable-comfy-compiler` 对这**一次**前向完全等价；前向一结束
立刻恢复，进程里其它模型（文本编码器、VAE、别的工作流）一个字节都不受影响。

钩子是进程级的，但只在作用域内生效。和 minimax-h3-chunk-star7 的同类钩子**可以叠加**：
各自查各自的线程局部深度，谁都顶不掉谁（我们包装的是当时的函数对象，链式调用）。
"""

import logging
import threading
import weakref
from contextlib import ExitStack, contextmanager
from types import MethodType

_PREFIX = "[H3显存编译图]"

# 打在「已套过作用域」的 forward 上的标记，避免两个节点重复包一层
SCOPE_MARK = "_taiyang_graph_scope"

_OWNERS = set()
_TLS = threading.local()
_HOOKS_INSTALLED = False

# ---- 诊断开关（排查「让路作用域为何没生效」时置 True，平时保持关闭）----
_DIAG = False


def _diag(msg, *a):
    if _DIAG:
        logging.info("[H3诊断] " + msg, *a)


# ---------------------------------------------------------------- 线程局部开关


def _depth():
    return getattr(_TLS, "depth", 0)


def _prefetch_module():
    """延迟导入：ComfyUI 还没加载完时不能碰 comfy.model_prefetch。"""
    try:
        import comfy.model_prefetch as prefetch
    except Exception:
        return None
    return prefetch


def _install_hooks():
    """装一次进程级钩子（幂等）。返回当前 ComfyUI 是否支持按次让路。"""
    global _HOOKS_INSTALLED
    if _HOOKS_INSTALLED:
        return True

    prefetch = _prefetch_module()
    if prefetch is None:
        return False

    enabled_fn = getattr(prefetch, "malloc_graph_enabled", None)
    pop_fn = getattr(prefetch, "prefetch_queue_pop", None)
    if not callable(enabled_fn) or not callable(pop_fn):
        # 老版本 ComfyUI 没有显存编译图，不需要让路
        return False

    if getattr(enabled_fn, SCOPE_MARK, False):
        _HOOKS_INSTALLED = True
        return True

    def malloc_graph_enabled_scoped(device):
        if _depth():
            return False
        return enabled_fn(device)

    def prefetch_queue_pop_scoped(
        queue, device, module, dtype=None, core=None, enable_graph=False,
        generator=None, malloc_scope=None, **kwargs,
    ):
        # 只掐「逐块分配计划」这一路：队列消费、VBAR 取权重、预取全部保留，
        # 其它作用域（模型级 scope）和别的模型照常。
        if _depth() and malloc_scope is not None:
            malloc_scope = None
        elif malloc_scope == "block":
            # 诊断：本应在「让路作用域」里，但 _depth()==0 —— 说明包装没套上
            n = getattr(_TLS, "diag_blocks", 0)
            if n < 3:
                _TLS.diag_blocks = n + 1
                _diag(
                    "逐块分配计划未被让路 depth=0 scope=%r module=%s id=%s",
                    malloc_scope, type(module).__name__ if module is not None else "None",
                    id(module) if module is not None else "None",
                )
        return pop_fn(
            queue, device, module, dtype=dtype, core=core,
            enable_graph=enable_graph, generator=generator,
            malloc_scope=malloc_scope, **kwargs,
        )

    setattr(malloc_graph_enabled_scoped, SCOPE_MARK, True)
    setattr(prefetch_queue_pop_scoped, SCOPE_MARK, True)
    prefetch.malloc_graph_enabled = malloc_graph_enabled_scoped
    prefetch.prefetch_queue_pop = prefetch_queue_pop_scoped
    _HOOKS_INSTALLED = True
    return True


@contextmanager
def scope():
    """在这个 with 块里，当前线程不录、也不重放显存分配计划。"""
    _install_hooks()
    outer = _depth() == 0
    _TLS.depth = _depth() + 1
    if outer:
        _TLS.diag_blocks = 0
        _diag("让路作用域进入 tid=%s", threading.get_ident())
    try:
        yield
    finally:
        _TLS.depth = max(0, _depth() - 1)
        if outer:
            _diag("让路作用域退出 tid=%s", threading.get_ident())


# ---------------------------------------------------------------- 给模型前向套作用域


def pending_forward(patcher, module):
    """取「下一次 patch_model 真正会用到」的 forward。

    add_object_patch 只是登记，不会立刻 setattr，所以这里要先看登记表，
    否则会把上一个节点布好的补丁绕过去。

    注意：这个函数**只反映登记表**，不反映模型上此刻真正挂着的东西。
    判断「作用域有没有生效」必须用下面的 live_forward()。
    """
    pending = patcher.object_patches.get("diffusion_model.forward")
    if pending is not None:
        return pending
    return module.forward


def live_forward(module):
    """模型对象上「此刻真正会被调到」的 forward。

    上一轮跑完时 unpatch_model() 会把 object_patches_backup 里的原始 forward
    还原回模型，并把备份表清空；但 object_patches **登记表还留着旧包装**。
    于是新 patcher（model.clone() 会连 object_patches 一起复制）里那条记录
    带着作用域标记，可模型上挂的已经不是它了 —— 只看登记表就会误判「已套过」
    而跳过安装，这一轮采样走的原生 forward，逐块分配计划照旧执行，
    malloc_graph_pop 返回 0，直接 aimdo memory compile error。
    """
    return getattr(module, "forward", None)


def install_forward(patcher, root, wrapped, full_key="diffusion_model.forward", rel_key="forward"):
    """登记补丁，并保证「当前这一刻」模型上挂的就是它。

    add_object_patch 只在下次 patch_model 时 setattr。如果模型已经处于
    patch 状态（上一轮跑完、forward 被还原成原生），光登记不会立刻生效，
    所以这里补一次即时 setattr，把备份补上，unpatch 时照旧能还原。
    """
    patcher.add_object_patch(full_key, wrapped)

    target = root
    parts = rel_key.split(".")
    for name in parts[:-1]:
        target = getattr(target, name, None)
        if target is None:
            return False
    attr = parts[-1]

    try:
        current = getattr(target, attr)
    except AttributeError:
        current = None

    if current is wrapped:
        return True

    try:
        if full_key not in patcher.object_patches_backup:
            patcher.object_patches_backup[full_key] = current
        setattr(target, attr, wrapped)
        _diag("install 即时挂载 %s（登记表与实机不一致，已补齐）", full_key)
    except Exception as exc:
        _diag("install 即时挂载失败 %s（%r），只能等下次 patch_model", full_key, exc)
    return True


def bind(module, function):
    """用弱引用持有模块，避免旧模型被补丁吊住不放。"""
    return MethodType(function, weakref.proxy(module))


def arm(patcher, module=None):
    """给模型前向套一层「关掉显存编译图」的作用域。

    幂等：上游节点已经套过就直接跳过，不会叠两层。
    """
    if not _install_hooks():
        return False

    if module is None:
        try:
            module = patcher.get_model_object("diffusion_model")
        except Exception:
            return False

    return arm_class(module)


# ---------------------------------------------------------------- 类级补丁
#
# 为什么不用 add_object_patch 装作用域
# ----------------------------------
# 那条路要经过 ModelPatcher 的 patch/unpatch 生命周期：unpatch_model() 会把
# forward 还原、清空 object_patches_backup，而 patch_model() 在模型已经处于
# patch 状态时不一定会重新 setattr。实测两轮里同一份代码，第一轮装上了、
# 第二轮就是没装上（日志 depth=0），靠推断没法保证下一次一定生效。
#
# 类上打补丁不参与这套生命周期：unpatch 不会碰它、clone 也不会丢，
# 只要进程里还有 TaiYang 节点启用（_OWNERS 非空）就恒生效。

_CLASS_EXTRA = {}          # owner -> contextmanager 工厂（FP16 累加开关等）


def arm_class(model, owner=None, extra=None):
    """在模型类上打一层 forward 补丁，让前向一定落进让路作用域。

    owner: 登记名（与 request() 一致），作用域外的东西按它生效/失效
    extra: 无参可调用，返回一个 contextmanager（例如 FP16 累加开关）
    """
    if owner is not None and extra is not None:
        _CLASS_EXTRA[owner] = extra

    cls = type(model)
    # 实例上若残留旧包装，会盖住类方法，先摘掉（旧包装内部指向的也是同一个原始
    # forward，摘掉不会丢行为）。
    if "forward" in getattr(model, "__dict__", {}):
        try:
            del model.__dict__["forward"]
        except Exception:
            pass

    if getattr(cls, "_taiyang_class_scoped", False):
        _diag("arm_class 跳过：类已打过补丁（%s）", cls.__name__)
        return False

    original = cls.forward

    def forward(self, *args, **kwargs):
        if not _OWNERS:
            return original(self, *args, **kwargs)
        with scope():
            if not _CLASS_EXTRA:
                return original(self, *args, **kwargs)
            with ExitStack() as stack:
                for name, factory in list(_CLASS_EXTRA.items()):
                    if name not in _OWNERS:
                        continue
                    try:
                        stack.enter_context(factory())
                    except Exception:
                        pass
                return original(self, *args, **kwargs)

    forward.__name__ = getattr(original, "__name__", "forward")
    setattr(forward, SCOPE_MARK, True)
    cls.forward = forward
    cls._taiyang_class_scoped = True
    _diag("arm_class 已装：%s forward 现在恒进让路作用域", cls.__name__)
    return True


# ---------------------------------------------------------------- 对外状态（兼容旧接口）


def request(owner):
    """登记一个需要让路的节点。只做记账与日志，不改任何全局开关。"""
    if owner in _OWNERS:
        return False
    _OWNERS.add(owner)
    ok = _install_hooks()
    if ok:
        logging.info(
            "%s 已登记「%s」：本节点会在自己的模型前向里临时让出显存编译图"
            "（aimdo malloc graph），前向一结束立刻恢复；全局命令行开关不动，"
            "文本编码器 / VAE / 其它工作流完全不受影响。",
            _PREFIX, owner,
        )
    else:
        logging.debug("%s 当前 ComfyUI 没有显存编译图，无需让路。", _PREFIX)
    return ok


def release(owner):
    """注销登记（节点被关掉时调用）。作用域本来就是按次生效，这里只更新状态。"""
    if owner not in _OWNERS:
        return False
    _OWNERS.discard(owner)
    return True


def state():
    return {"owners": sorted(_OWNERS), "hooks": _HOOKS_INSTALLED, "depth": _depth()}
