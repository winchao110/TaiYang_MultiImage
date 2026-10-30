"""显存分块加载 —— 把三处激活分块 + out_proj 保护独立出来。

QKV / RoPE / MLP 三处激活分块、out_proj 预算式保护、OOM 逐段减半，全部按本节点包的
约定重写，不依赖任何外部节点包。

只做「沿 token 维切分临时激活」，其它一律不碰：
  * 不改注意力后端（沿用当前生效的那一个）
  * 不改精度、不改权重格式、不改采样器 / sigma / latent / VAE / 时长 / 分辨率
  * 不减少计算量（FLOPs 不变），只降低临时显存峰值

三处峰值与对应开关：
  QKV 投影       —— `qkv_proj(x)` 的全序列输出及其 GEMM 工作区（int8 走 INT32 收缩，最肥）
  RMSNorm+RoPE   —— 分块后逐段原地写回 Q/K，freqs 按同一 token 区间切片
  MLP 扩展       —— `fc1 -> SwiGLU -> fc2`，按行独立，逐段算完写回
  out_proj       —— 按当前可用显存预算决定「整段一次」还是「切块」，只在实际吃紧时才切
"""

import gc
import logging
import types

import torch

from . import compiler_guard

_LOG = logging.getLogger("TaiYangChunk")
_PREFIX = "[显存分块]"

_MIN_CHUNK = 256          # 分块下限，也是 OOM 减半的最低点
_ALIGN = 256              # 分块对齐（UI 的 step）
_OUT_PROJ_TILE_CAP = 4096  # out_proj 保护切块的验证上限

_KIND_CN = {"qkv": "QKV", "rope": "RoPE", "mlp": "MLP", "out_proj": "输出投影"}

_STATE = {
    "rope_orig": None,    # 原始 comfy_kitchen 的 rms_rope_split_half_
    "rope_patched": False,
    "warned": set(),
}

_CONFIG = {
    "qkv": 4096,
    "rope": 8192,
    "mlp": 4096,
    "eff_qkv": 4096,
    "eff_rope": 8192,
    "eff_mlp": 4096,
    "auto_halve": True,
    "verbose": True,
    "out_proj_guard": True,
    "logged": set(),
    "policy": {},
}


# ------------------------------------------------------------------ 0. 小工具
def _is_oom(exc: BaseException) -> bool:
    oom_cls = getattr(torch, "OutOfMemoryError", RuntimeError)
    if isinstance(exc, oom_cls):
        return True
    text = str(exc).lower()
    return "out of memory" in text or "would exceed allowed memory" in text


def _clear_after_oom(device) -> None:
    gc.collect()
    if getattr(device, "type", None) == "cuda" and torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass


def _log_once(tag, message, *args) -> None:
    if not _CONFIG["verbose"]:
        return
    logged = _CONFIG["logged"]
    if tag in logged:
        return
    logged.add(tag)
    _LOG.info(message, *args)


def _warn_once(tag, message, *args) -> None:
    if tag in _STATE["warned"]:
        return
    _STATE["warned"].add(tag)
    _LOG.warning(message, *args)


def _resolve_chunk(kind: str, sequence: int) -> int:
    """返回本段实际使用的分块大小；>= sequence 表示整段一次。"""
    configured = int(_CONFIG["eff_" + kind])
    sequence = max(1, int(sequence))
    if configured <= 0:
        return sequence
    return max(_MIN_CHUNK, min(sequence, configured))


def _remember(kind: str, failed: int) -> int:
    """OOM 后把该段的分块减半，并让后续 block 沿用。"""
    key = "eff_" + kind
    new_chunk = max(_MIN_CHUNK, int(failed) // 2)
    previous = int(_CONFIG[key])
    if previous > 0:
        new_chunk = min(previous, new_chunk)
    _CONFIG[key] = new_chunk
    _LOG.warning(
        "%s %s 显存不足：本次 %d 行 → 后续改用 %d 行",
        _PREFIX, _KIND_CN.get(kind, kind), int(failed), new_chunk,
    )
    return new_chunk


# ------------------------------------------------------------------ 1. RoPE 分块
def _rope_original():
    """原始（未分块）的 H3 融合 RMSNorm + 半转 RoPE 原地算子。"""
    if _STATE["rope_orig"] is not None:
        return _STATE["rope_orig"]
    import comfy.quant_ops as quant_ops

    return quant_ops.ck.rms_rope_split_half_


def _slice_freqs(freqs, start: int, end: int, sequence: int):
    if freqs is None:
        return None
    if freqs.ndim < 2 or freqs.shape[1] != sequence:
        raise ValueError(
            f"H3 RoPE 频率形状异常 {tuple(freqs.shape)}，与序列长度 {sequence} 不匹配"
        )
    return freqs[:, start:end, ...]


def _chunked_rope(q, k, freqs, q_scale, k_scale, epsilon=1e-6, rot_dim=0):
    """把融合 RMSNorm+RoPE 按 token 段原地写回。

    RMSNorm 只在 head_dim 上归约、RoPE 只看各自位置，所以逐段计算与整段
    结果逐元素相同；这里不做任何近似。
    """
    rope = _rope_original()
    sequence = int(q.shape[1])
    chunk = _resolve_chunk("rope", sequence)
    if chunk >= sequence:
        return rope(
            q, k, freqs, q_scale, k_scale, epsilon=epsilon, rot_dim=rot_dim
        )

    _log_once(
        ("rope", sequence, chunk),
        "%s RoPE 分块 | S=%d | %d 行 x %d 段 | rot_dim=%d",
        _PREFIX, sequence, chunk, (sequence + chunk - 1) // chunk, rot_dim,
    )

    current = chunk
    start = 0
    while start < sequence:
        end = min(start + current, sequence)
        try:
            rope(
                q[:, start:end, ...],
                k[:, start:end, ...],
                _slice_freqs(freqs, start, end, sequence),
                q_scale, k_scale, epsilon=epsilon, rot_dim=rot_dim,
            )
            start = end
        except Exception as exc:
            if not (_CONFIG["auto_halve"] and current > _MIN_CHUNK and _is_oom(exc)):
                raise
            exc.__traceback__ = None
            _clear_after_oom(q.device)
            current = _remember("rope", current)
    return q, k


def _chunked_rms_rope_split_half_inplace(
    q, k, freqs_cis, q_scale, k_scale=None, epsilon=1e-6, rot_dim=0,
):
    """替换 comfy_quant_ops.ck.rms_rope_split_half_ 的进程级入口。

    只接管 H3 的标准形态（[1,S,H,D] + 匹配的 freqs），其它一律回原始实现，
    保证不影响任何非 H3 模型。
    """
    if k_scale is None:
        k_scale = q_scale
    compatible = (
        torch.is_tensor(q) and torch.is_tensor(k)
        and q.ndim == 4 and k.ndim == 4
        and q.shape[0] == 1 and k.shape[0] == 1
        and q.shape[1] == k.shape[1]
        and q.shape[-1] == k.shape[-1]
        and torch.is_tensor(freqs_cis) and freqs_cis.ndim >= 2
        and freqs_cis.shape[1] == q.shape[1]
        and q.device == k.device
    )
    if not compatible:
        return _rope_original()(
            q, k, freqs_cis, q_scale, k_scale, epsilon=epsilon, rot_dim=rot_dim
        )
    return _chunked_rope(
        q, k, freqs_cis, q_scale, k_scale, epsilon=epsilon, rot_dim=rot_dim
    )


def install_rope_patch() -> bool:
    """把全局 RoPE 算子换成按段执行的版本（幂等）。"""
    if _STATE["rope_patched"]:
        return True
    import comfy.quant_ops as quant_ops

    ck = getattr(quant_ops, "ck", None)
    if ck is None or not hasattr(ck, "rms_rope_split_half_"):
        _LOG.warning("%s comfy_kitchen 没有 rms_rope_split_half_，RoPE 分块不可用", _PREFIX)
        return False
    current = ck.rms_rope_split_half_
    if getattr(current, "_rtx20_chunk_rope", False):
        _STATE["rope_patched"] = True
        return True
    _STATE["rope_orig"] = current
    _chunked_rms_rope_split_half_inplace._rtx20_chunk_rope = True
    ck.rms_rope_split_half_ = _chunked_rms_rope_split_half_inplace
    _STATE["rope_patched"] = True
    return True


def restore_rope_patch() -> bool:
    """还原全局 RoPE 算子（节点关闭时调用）。"""
    original = _STATE["rope_orig"]
    if not _STATE["rope_patched"] or original is None:
        return False
    try:
        import comfy.quant_ops as quant_ops

        quant_ops.ck.rms_rope_split_half_ = original
    except Exception as exc:
        _LOG.warning("%s 还原 RoPE 算子失败：%r", _PREFIX, exc)
        return False
    _STATE["rope_patched"] = False
    _STATE["rope_orig"] = None
    return True


# ------------------------------------------------------------------ 2. QKV 分块
def _is_pristine_attention(function) -> bool:
    """判断注意力前向是否仍是 ComfyUI 原生实现（或我们自己的分块版）。"""
    func = getattr(function, "__func__", function)
    if getattr(func, "_rtx20_chunk_qkv", False):
        return True
    try:
        from comfy.ldm.minimax.model import Attention

        return func is Attention.forward
    except Exception:
        return False


def _run_chunked_qkv_attention(attn, x, rope_freqs, transformer_options, upstream):
    """按 token 段算 QKV 投影 + Norm/RoPE，再交给当前生效的注意力后端。

    只替换「投影 + 归一化 + RoPE」这一段；注意力内核、后端选择、
    transformer_options 一律原样透传，因此与其它注意力补丁互不干扰。
    """
    import comfy.model_management as mm
    from comfy.ldm.modules.attention import (
        AttentionTensorContainer,
        optimized_attention,
    )

    if isinstance(x, list):
        x = x.pop()

    sequence = int(x.shape[0])
    heads, head_dim = int(attn.heads), int(attn.head_dim)
    inner = heads * head_dim
    chunk = _resolve_chunk("qkv", sequence)

    # 整段一次：完全不改变原生行为
    if chunk >= sequence:
        return upstream(x, rope_freqs=rope_freqs, transformer_options=transformer_options)

    device, dtype = x.device, x.dtype
    # 三个累加缓冲与原生 qkv 输出同尺寸，真正省下的是每段投影的工作区
    q_out = torch.empty((1, sequence, heads, head_dim), device=device, dtype=dtype)
    k_out = torch.empty((1, sequence, heads, head_dim), device=device, dtype=dtype)
    v_out = torch.empty((1, sequence, heads, head_dim), device=device, dtype=dtype)

    q_scale = k_scale = None
    rot_dim = 0
    if rope_freqs is not None:
        q_scale = mm.cast_to(attn.q_norm.weight, device=device)
        k_scale = mm.cast_to(attn.k_norm.weight, device=device)
        rot_dim = int(rope_freqs.shape[-3]) * 2

    _log_once(
        ("qkv", sequence, chunk),
        "%s QKV 分块 | S=%d | %d 行 x %d 段 | heads=%d head_dim=%d",
        _PREFIX, sequence, chunk, (sequence + chunk - 1) // chunk, heads, head_dim,
    )

    current = chunk
    start = 0
    while start < sequence:
        end = min(start + current, sequence)
        rows = end - start
        projected = None
        try:
            projected = attn.qkv_proj(x[start:end])
            q_raw, k_raw, v_raw = projected.split(inner, dim=-1)
            if rope_freqs is not None:
                q_view = q_out[:, start:end]
                k_view = k_out[:, start:end]
                q_view.copy_(q_raw.view(1, rows, heads, head_dim))
                k_view.copy_(k_raw.view(1, rows, heads, head_dim))
                # 原地写回，逐段与整段等价
                _chunked_rope(
                    q_view, k_view,
                    _slice_freqs(rope_freqs, start, end, sequence),
                    q_scale, k_scale,
                    epsilon=attn.q_norm.eps, rot_dim=rot_dim,
                )
            else:
                q_out[:, start:end].copy_(
                    attn.q_norm(q_raw.view(rows, heads, head_dim)).view(1, rows, heads, head_dim)
                )
                k_out[:, start:end].copy_(
                    attn.k_norm(k_raw.view(rows, heads, head_dim)).view(1, rows, heads, head_dim)
                )
            v_out[:, start:end].copy_(v_raw.view(1, rows, heads, head_dim))
            del projected, q_raw, k_raw, v_raw
            start = end
        except Exception as exc:
            del projected
            if not (_CONFIG["auto_halve"] and current > _MIN_CHUNK and _is_oom(exc)):
                raise
            exc.__traceback__ = None
            _clear_after_oom(device)
            current = _remember("qkv", current)

    q = AttentionTensorContainer(q_out[0].transpose(0, 1).unsqueeze(0))
    k = AttentionTensorContainer(k_out[0].transpose(0, 1).unsqueeze(0))
    v = AttentionTensorContainer(v_out[0].transpose(0, 1).unsqueeze(0))
    out = optimized_attention(
        q, k, v, heads,
        preferred_attention=attn.comfy_attention,
        mask=None, skip_reshape=True,
        transformer_options=transformer_options,
    )
    return attn.out_proj(out.squeeze(0))


def _make_attention_forward(upstream):
    def forward(self, x, rope_freqs=None, transformer_options=None, **kwargs):
        return _run_chunked_qkv_attention(
            self, x, rope_freqs, transformer_options or {}, upstream
        )

    forward._rtx20_chunk_qkv = True
    forward._rtx20_upstream = upstream
    return forward


# ------------------------------------------------------------------ 3. MLP 分块
def _run_chunked_mlp(mlp, x, upstream):
    import comfy.ops

    if not torch.is_tensor(x) or x.ndim != 2:
        return upstream(x)

    sequence = int(x.shape[0])
    chunk = _resolve_chunk("mlp", sequence)
    if chunk >= sequence:
        return upstream(x)

    _log_once(
        ("mlp", sequence, chunk),
        "%s MLP 分块 | S=%d | %d 行 x %d 段",
        _PREFIX, sequence, chunk, (sequence + chunk - 1) // chunk,
    )

    output = None
    current = chunk
    start = 0
    while start < sequence:
        end = min(start + current, sequence)
        result = None
        try:
            piece = x[start:end]
            result = upstream(piece)
            expected = (end - start, x.shape[1])
            if tuple(result.shape) != expected:
                raise RuntimeError(
                    f"H3 MLP 分块输出形状异常：{tuple(result.shape)} != {expected}"
                )
            if output is None:
                if start == 0 and end == sequence:
                    return result
                output = result.new_empty((sequence, x.shape[1]))
            elif result.dtype != output.dtype:
                raise RuntimeError(
                    f"H3 MLP 分块输出 dtype 变了：{output.dtype} -> {result.dtype}"
                )
            output[start:end].copy_(result)
            del result
            start = end
        except Exception as exc:
            del result
            if not (_CONFIG["auto_halve"] and current > _MIN_CHUNK and _is_oom(exc)):
                raise
            exc.__traceback__ = None
            _clear_after_oom(x.device)
            current = _remember("mlp", current)
    return output


def _make_mlp_forward(upstream):
    def forward(self, x, *args, **kwargs):
        if args or kwargs:
            # 第三方 MLP 补丁可能带额外参数，交回上游处理
            return upstream(x, *args, **kwargs)
        return _run_chunked_mlp(self, x, upstream)

    forward._rtx20_chunk_mlp = True
    forward._rtx20_upstream = upstream
    return forward


# ------------------------------------------------------------------ 4. out_proj 保护
def _cuda_budget(device):
    if getattr(device, "type", None) != "cuda" or not torch.cuda.is_available():
        return None
    try:
        free, _ = torch.cuda.mem_get_info(device)
        return int(free)
    except Exception:
        return None


def _out_proj_plan(x, out_features: int) -> dict:
    """按当前可用显存决定整段 / 切块，同一形状只判一次。"""
    sequence = int(x.shape[0])
    key = (
        x.device.index, str(x.dtype), sequence,
        int(x.shape[-1]), int(out_features),
    )
    plan = _CONFIG["policy"].get(key)
    if plan is not None:
        return plan

    free = _cuda_budget(x.device)
    if free is None:
        plan = {"chunk": sequence, "mode": "full", "reason": "无显存预算信息"}
        _CONFIG["policy"][key] = plan
        return plan

    gib = 1024 ** 3
    esize = int(x.element_size())
    output_bytes = sequence * out_features * esize
    activation_bytes = sequence * int(x.shape[-1]) * esize
    # SM75 的通用 int8 路径会实体化 INT32 收缩工作区，这一项最肥
    int32_workspace = sequence * out_features * 4
    margin = int(1.5 * gib)
    need = output_bytes + activation_bytes + int32_workspace + margin

    if free >= need:
        plan = {"chunk": sequence, "mode": "full", "need": need, "free": free}
    else:
        per_token = int(x.shape[-1]) + out_features * (4 + esize)
        budget = max(0, free - output_bytes - margin)
        affordable = budget // max(1, per_token)
        chunk = max(_MIN_CHUNK, min(_OUT_PROJ_TILE_CAP, (affordable // _ALIGN) * _ALIGN))
        plan = {
            "chunk": min(sequence, chunk), "mode": "chunk",
            "need": need, "free": free,
        }
    _CONFIG["policy"][key] = plan
    return plan


def _run_chunked_out_proj(out_proj, x, upstream):
    if not torch.is_tensor(x) or x.ndim != 2:
        return upstream(x)

    sequence = int(x.shape[0])
    out_features = int(getattr(out_proj, "out_features", x.shape[-1]))
    plan = _out_proj_plan(x, out_features)

    if plan["mode"] == "full" or int(plan["chunk"]) >= sequence:
        try:
            result = upstream(x)
            _log_once(
                ("out_proj_full", sequence, out_features),
                "%s 输出投影 | S=%d | N=%d | 整段一次（余量充足）",
                _PREFIX, sequence, out_features,
            )
            return result
        except Exception as exc:
            if not (_CONFIG["auto_halve"] and sequence > _MIN_CHUNK and _is_oom(exc)):
                raise
            exc.__traceback__ = None
            _clear_after_oom(x.device)
            plan.update(
                mode="chunk",
                chunk=min(_OUT_PROJ_TILE_CAP, max(_MIN_CHUNK, sequence // 2)),
            )

    current = max(_MIN_CHUNK, min(sequence, int(plan["chunk"])))
    _log_once(
        ("out_proj_guard", sequence, current),
        "%s 输出投影 | S=%d | N=%d | %d 行 x %d 段（预算保护）",
        _PREFIX, sequence, out_features, current,
        (sequence + current - 1) // current,
    )

    output = None
    start = 0
    while start < sequence:
        end = min(start + current, sequence)
        result = None
        try:
            result = upstream(x[start:end])
            if output is None:
                output = result.new_empty((sequence, result.shape[-1]))
            output[start:end].copy_(result)
            del result
            start = end
        except Exception as exc:
            del result
            if not (_CONFIG["auto_halve"] and current > _MIN_CHUNK and _is_oom(exc)):
                raise
            exc.__traceback__ = None
            _clear_after_oom(x.device)
            current = _remember("out_proj", current)
            plan["chunk"] = current
    return output


def _make_out_proj_forward(upstream):
    def forward(self, x, *args, **kwargs):
        if args or kwargs:
            return upstream(x, *args, **kwargs)
        return _run_chunked_out_proj(self, x, upstream)

    forward._rtx20_chunk_out_proj = True
    forward._rtx20_upstream = upstream
    return forward


# ------------------------------------------------------------------ 5. 安装
def _strip_own_wrapper(value, marker: str):
    """去掉本节点上一次套上的同类包装，避免重复执行时层层嵌套。"""
    current = value
    seen = 0
    while getattr(getattr(current, "__func__", current), marker, False) and seen < 8:
        current = getattr(current, "_rtx20_upstream", None)
        if current is None:
            break
        seen += 1
    return current


def _existing_patch(patched, path, native):
    """取该路径当前生效的前向（可能是别的节点装的补丁）。"""
    stored = patched.object_patches.get(path)
    return stored if stored is not None else native


def configure(qkv_chunk, rope_chunk, mlp_chunk, out_proj_guard, auto_halve, verbose):
    _CONFIG.update(
        qkv=int(qkv_chunk),
        rope=int(rope_chunk),
        mlp=int(mlp_chunk),
        eff_qkv=int(qkv_chunk),
        eff_rope=int(rope_chunk),
        eff_mlp=int(mlp_chunk),
        auto_halve=bool(auto_halve),
        verbose=bool(verbose),
        out_proj_guard=bool(out_proj_guard),
        logged=set(),
        policy={},
    )


def _load_h3_module():
    """H3 模型实现。优先用已加载的模块，避免被无关的导入错误误判。"""
    import sys

    module = sys.modules.get("comfy.ldm.minimax.model")
    if module is not None:
        return module
    from comfy.ldm.minimax import model as module

    return module


def install(
    model,
    enabled=True,
    qkv_chunk=4096,
    rope_chunk=8192,
    mlp_chunk=4096,
    out_proj_guard=True,
    auto_halve=True,
    verbose=True,
    announce=True,
):
    """返回打上分块补丁的模型；关闭时原样返回。

    verbose  —— 逐段 / 逐块的细节日志（默认关，正常跑不需要看）
    announce —— 采样前那一条汇总（默认开）
    """
    configure(qkv_chunk, rope_chunk, mlp_chunk, out_proj_guard, auto_halve, verbose)

    if not enabled:
        if restore_rope_patch():
            _LOG.info("%s 已关闭，RoPE 全局算子已还原", _PREFIX)
        compiler_guard.release("chunk")
        return model

    # 分块按 token 段申请/释放缓冲，且最后一段长度与前面不同，
    # 与 ComfyUI 0.43 的 aimdo 显存编译图（逐块预编译分配计划）不兼容，必须让路。
    compiler_guard.request("chunk")

    if rope_chunk != 0:
        install_rope_patch()

    try:
        h3 = _load_h3_module()
    except Exception as exc:
        _LOG.warning("%s 找不到 MiniMax H3 模型实现，未安装分块：%r", _PREFIX, exc)
        compiler_guard.release("chunk")
        return model

    patched = model.clone()
    diffusion = patched.get_model_object("diffusion_model")
    if not isinstance(diffusion, h3.MiniMaxH3Model):
        _LOG.warning("%s 收到非 H3 模型，未安装分块", _PREFIX)
        compiler_guard.release("chunk")
        return patched

    blocks = list(getattr(diffusion, "blocks", []))
    if not blocks:
        _LOG.warning("%s H3 模型没有 blocks，未安装分块", _PREFIX)
        compiler_guard.release("chunk")
        return patched

    installed = {"qkv": 0, "mlp": 0, "out_proj": 0}
    skipped_qkv = 0

    for index, block in enumerate(blocks):
        attn = getattr(block, "attn", None)
        mlp = getattr(block, "mlp", None)

        # ---- QKV：只在原生注意力前向上生效（第三方注意力补丁不动）
        if qkv_chunk != 0 and attn is not None:
            path = f"diffusion_model.blocks.{index}.attn.forward"
            current = _strip_own_wrapper(
                _existing_patch(patched, path, attn.forward), "_rtx20_chunk_qkv"
            )
            if _is_pristine_attention(current):
                patched.add_object_patch(
                    path, types.MethodType(_make_attention_forward(current), attn)
                )
                installed["qkv"] += 1
            else:
                skipped_qkv += 1

        # ---- MLP
        if mlp_chunk != 0 and mlp is not None:
            path = f"diffusion_model.blocks.{index}.mlp.forward"
            current = _strip_own_wrapper(
                _existing_patch(patched, path, mlp.forward), "_rtx20_chunk_mlp"
            )
            patched.add_object_patch(
                path, types.MethodType(_make_mlp_forward(current), mlp)
            )
            installed["mlp"] += 1

        # ---- out_proj
        if out_proj_guard and attn is not None and hasattr(attn, "out_proj"):
            path = f"diffusion_model.blocks.{index}.attn.out_proj.forward"
            current = _strip_own_wrapper(
                _existing_patch(patched, path, attn.out_proj.forward),
                "_rtx20_chunk_out_proj",
            )
            patched.add_object_patch(
                path,
                types.MethodType(_make_out_proj_forward(current), attn.out_proj),
            )
            installed["out_proj"] += 1

    if skipped_qkv:
        _warn_once(
            "qkv-skip",
            "%s 检测到 %d 个 block 的注意力已被其它节点替换，QKV 分块自动跳过"
            "（MLP / 输出投影分块不受影响）。需要 QKV 分块时请把本节点放到"
            "那个注意力补丁之前，或先关掉它。",
            _PREFIX, skipped_qkv,
        )

    if announce:
        _LOG.info(
            "%s 已开启：注意力每段 %d / 位置编码每段 %d / 前馈每段 %d｜共 %d 块"
            "（输出投影保护=自动，显存不足时自动减半）",
            _PREFIX, int(qkv_chunk), int(rope_chunk), int(mlp_chunk), len(blocks),
        )
    if verbose:
        _LOG.info(
            "%s 分块明细：QKV %d 块 / MLP %d 块 / 输出投影 %d 块",
            _PREFIX, installed["qkv"], installed["mlp"], installed["out_proj"],
        )
    return patched


def describe() -> str:
    return (
        f"注意力={_CONFIG['eff_qkv']} / 位置编码={_CONFIG['eff_rope']} / "
        f"前馈={_CONFIG['eff_mlp']} / out_proj={'自动' if _CONFIG['out_proj_guard'] else '关'}"
    )
