"""模型计算 FP16：把非量化权重统一到目标精度，量化权重保持存储形态。

MiniMax H3 的 supported_inference_dtypes 只有 [bf16, fp32]，整套模型原生是
「fp32 残差 + bf16 调制参数 + int8 权重 + 几处 fp32 岛」。本节点把它统一到
目标精度（默认 FP16），让每个 Linear 都落在真张量核上：

  ① 权重统一到 FP16（audio 链路除外）
     int8/int4/fp8 量化权重保持存储形态（含 convrot，省显存），前向时按层反量化成
     FP16 送进张量核，用完即弃、不常驻；fp32 / bf16 的权重（H3 的几处 fp32 岛：
     video_patch_proj、time_embedder、FinalLayer.video_out、adaln curves）直接
     就地换成 FP16。audio 专属的两处（audio_patch_proj、FinalLayer.audio_out）
     保持 checkpoint 原精度，防止音频转半精度后失声/爆音。
     另一档「全部权重转为FP16」会把 int8/int4 也 dequantize 成稠密 FP16 张量，
     权重占用直接翻倍（H3 约 20GB → 40GB），只有大显存、或内存充足且能 offload
     的机器吃得下；普通 24GB 卡选它一定 OOM，默认请用第一档。

  ② Tensor Core 调度
     把 DiT 块内部所有矩阵乘的输入统一成 FP16（残差流仍是 FP32），这样每一个
     Linear 都落到硬件的 HMMA / HMMA-equivalent 指令上，而不是 bf16 的模拟路径
     （没有 bf16 张量核的卡上，bf16 GEMM 会退化成慢十倍的模拟实现）。

  ③ FP16 数值保护（与显卡型号无关，是 FP16 格式本身的 65504 上限）
     H3 有三处会超出 FP16 的 65504 上限，不修就是黑图/NaN：
       · condition_proj 的输入（Qwen3-VL hidden 能到 ~96k）→ 用 FP32 输入
       · 残差流（attention sink 行从 ~81k 涨到 ~4.3M）→ 残差流保持 FP32
       · out_proj / fc2 的输出（能到 2M 以上）→ 输入先除以 K、输出再乘回 K
         K 取 2 的幂（out_proj 64，fc2 256），投影是线性的，所以这个缩放
         是**精确**的，只挪指数范围，不损失任何精度。

接法：模型 → 本节点 → 显卡分块 / kitchen 注意力加速。本节点只改权重与激活的
dtype，不碰注意力内核，所以下游节点照常生效。
"""

import logging
import weakref
from types import MethodType

import torch
import torch.nn.functional as F

from . import compiler_guard

_PREFIX = "[模型计算FP16]"

# 精确的 2 的幂缩放，来自 H3 在 FP16 下的实际数值范围
K_OUT_PROJ = 64.0
K_FC2 = 256.0

# 权重统一转换的预算：H3 的 fp32 岛（两个 patch_proj、time_embedder、final head）
# 加起来只有几十 MB；一旦有人把整个 bf16 模型塞进来（20GB），就停下并提示改用
# --fp16-unet，避免在显存里再复制一份。
CAST_BUDGET_BYTES = 1 << 30

PREC_FP16 = "FP16（推荐）"
PREC_BF16 = "BF16（H3 原生）"
# v1 的下拉值是「FP16（图灵张量核）」，老工作流存的就是它。ComfyUI 校验下拉值时会
# 直接 value_not_in_list 报错，所以必须留在列表里（并且映射到同样的 float16）。
PREC_LEGACY_FP16 = "FP16（图灵张量核）"
PRECISION_CHOICES = [PREC_FP16, PREC_BF16, PREC_LEGACY_FP16]

# 两档权重策略：
#   ① 只转非量化权重（fp32 / bf16 的岛），int8/int4 保持 int8 存储、前向那一瞬间
#      才反量化成 FP16 —— 显存不变，推荐的默认档；
#   ② 连 int8/int4 一起 dequantize 成稠密 FP16 —— 权重占用翻倍，24GB 卡会 OOM。
W_ALL = "BF16,FP32转为FP16"
W_EVERYTHING = "全部权重转为FP16"
WEIGHT_CHOICES = [W_ALL, W_EVERYTHING]

# 已下架的旧下拉值。ComfyUI 0.43 的 execution.py 会在校验阶段先按列表拦掉
# （value_not_in_list），所以这里的映射主要是兜底：绕过前端校验的旧 prompt
# 提交进来时，仍按当时的语义落到 W_ALL 上，不至于 KeyError。
# 「全部不转（fp32/bf16 也不动）」原本走 comfy_kitchen 的 int8 GEMM，
# 该档已按需求从列表移除，旧值一并落到 W_ALL。
_WEIGHT_ALIASES = {
    "其它全部转 FP16（int8/int4 不动）": W_ALL,   # v2 的名字
    "全部权重转 FP16": W_ALL,                     # v1 的名字
    "INT8 存储 + 动态转 FP16": W_ALL,             # v0 的名字
    "全部不转（fp32/bf16 也不动）": W_ALL,        # 已下架的 int8 GEMM 档
}
W_DEQUANT = W_ALL  # 旧引用别名

_TORCH_DTYPE = {
    PREC_FP16: torch.float16,
    PREC_BF16: torch.bfloat16,
    PREC_LEGACY_FP16: torch.float16,   # 旧下拉值的等价映射
}

# 日志里用的短名
_DTYPE_LABEL = {
    torch.float16: "FP16", torch.bfloat16: "BF16",
    torch.float32: "FP32", torch.float64: "FP64",
}


def _dtype_label(dtype):
    return _DTYPE_LABEL.get(dtype, str(dtype).replace("torch.", "").upper())

_STATE = {
    "enabled": False,
    "precision": PREC_FP16,
    "weights": W_DEQUANT,
    "guard": True,
    "verbose": True,
    "blocks": 0,
    "dequant_calls": 0,
    "logged": set(),
}

_SM = torch.cuda.get_device_capability() if torch.cuda.is_available() else (0, 0)


def _mm():
    """延迟导入：ComfyUI 还没加载完时不能碰 comfy.ldm。"""
    import comfy.ldm.minimax.model as mm

    return mm


def _bind(module, function):
    """把 function 绑到模块上，但用弱引用持有模块，避免旧模型被闭包吊住。"""
    return MethodType(function, weakref.proxy(module))


def _torch_dtype(precision):
    return _TORCH_DTYPE.get(precision, torch.float16)


# ---------------------------------------------------------------- 数值保护包装


def _block_forward(original_forward, guard):
    """残差流保持 FP32，两条分支的输入转成 FP16 送进张量核。"""

    def forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={},
                attention=None, **_kwargs):
        mm = _mm()
        if x.dtype != torch.float32:
            x = x.to(torch.float32)

        shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = self.adaln_proj(t_emb)

        h = mm._mod_scale_shift(self.norm1(x), shift_msa, scale_msa, mod_segments).to(torch.float16)
        attention_fn = self.attn if attention is None else attention
        rope = rope_freqs
        if rope is not None and rope.dtype != torch.float16:
            # rope 表原本按模型 dtype(bf16) 生成；kitchen 的 rms+rope 融合核要求同 dtype
            rope = rope.to(torch.float16)
        attention_output = attention_fn(h, rope_freqs=rope, transformer_options=transformer_options)
        x = mm._mod_gate(x, gate_msa, attention_output.to(torch.float32), mod_segments)

        h = mm._mod_scale_shift(self.norm2(x), shift_mlp, scale_mlp, mod_segments).to(torch.float16)
        mlp = self.mlp(h)
        return mm._mod_gate(x, gate_mlp, mlp.to(torch.float32), mod_segments)

    return forward


def _mlp_forward(original_forward, scale):
    """SwiGLU 在 FP32 里算，进 fc2 之前先除 scale，出去再乘回来。

    scale == 0 表示不开本节点的数值保护：这时**原样调用原来的 forward**，
    不自己拆 SwiGLU。因为 minimax_h3_fp16_fix.py 那类补丁已经在 fc2 前后做了
    /256 的缩放，一旦我们自己拆开重建就会把它绕过去，输出直接冲爆 fp16。
    """

    def forward(self, x):
        if not scale:
            return original_forward(x)
        if x.dtype != torch.float16:
            return original_forward(x)
        projected = self.fc1(x)
        gate, up = projected.chunk(2, dim=-1)
        activated = F.silu(gate.to(torch.float32)).mul_(up.to(torch.float32))
        return self.fc2((activated / scale).to(torch.float16)).to(torch.float32).mul_(scale)

    return forward


def _out_proj_forward(original_forward, scale):
    """注意力投影：输入先除 scale（避免超出 FP16 上限），输出以 FP32 乘回。

    scale == 0 时同样原样委托，理由同上（别绕过别的补丁的缩放）。
    """

    def forward(self, tensor):
        if not scale:
            return original_forward(tensor)
        if tensor.dtype != torch.float16:
            return original_forward(tensor)
        return original_forward((tensor / scale).to(torch.float16)).to(torch.float32).mul_(scale)

    return forward


def _condition_proj_forward(original_forward):
    """condition_proj 吃 Qwen3-VL 的 hidden（能到 ~96k），必须用 FP32 输入。"""

    def forward(self, tensor):
        return original_forward(tensor.to(torch.float32))

    return forward


# ---------------------------------------------------------------- 冲突检测


def _builtin_fix_present(diffusion_model):
    """检测 custom_nodes/minimax_h3_fp16_fix.py 这类实例级补丁。

    它和本节点的 out_proj 缩放会叠加（64×64），必须让用户二选一。
    """
    for block in getattr(diffusion_model, "blocks", [])[:1]:
        if getattr(block, "_h3_fp16_fix", False):
            return True
        out_proj = getattr(getattr(block, "attn", None), "out_proj", None)
        name = getattr(getattr(out_proj, "forward", None), "__name__", "")
        if name == "_safe_out_proj":
            return True
    return False


# ---------------------------------------------------------------- 权重统一精度


def _is_quantized_param(param, module, name):
    """int8/fp8 量化权重保持存储形态，交给 cast_bias_weight 在 forward 时反量化。"""
    if name == "weight" and getattr(module, "layout_type", None) is not None:
        return True
    try:
        from comfy.quant_ops import QuantizedTensor
    except Exception:
        return False
    try:
        return isinstance(param, QuantizedTensor)
    except TypeError:  # 某些版本 QuantizedTensor 只是个占位类
        return False


def _count_params(module):
    return sum(1 for p in module._parameters.values() if p is not None)


def _expand_quantized(module, pname, param, dtype):
    """把一条量化权重就地展开成稠密 dtype 张量，返回新张量字节数；失败返回 None。

    展开后必须把 module.layout_type 清掉，否则 MixedPrecisionOps.forward 里的
    `_use_quantized` 仍会为真，继续把这条已变成稠密张量的权重当量化的喂给
    comfy_kitchen 的量化 GEMM，直接报错。
    """
    dense = None
    for source in (param, getattr(param, "data", None)):
        if source is None:
            continue
        dequant = getattr(source, "dequantize", None)
        if dequant is None:
            continue
        try:
            dense = dequant()
        except Exception:
            continue
        break
    if dense is None or not torch.is_tensor(dense):
        return None
    if dense.is_meta:
        return None
    if dense.dtype != dtype:
        dense = dense.to(dtype)
    module._parameters[pname] = torch.nn.Parameter(
        dense.detach(), requires_grad=False
    )
    if pname == "weight":
        module.layout_type = None
    return dense.numel() * dense.element_size()


def _cast_all_weights(diffusion_model, dtype, verbose=True,
                      include_quantized=False, budget=CAST_BUDGET_BYTES):
    """把模型里的参数统一成 dtype（精度选 FP16 时就是「统统转 FP16」）。

    H3 刻意留了几处 fp32 岛，`set_model_compute_dtype` 管不到它们：
      · video_patch_proj / audio_patch_proj
      · time_embedder（timestep 嵌入，构造时写死 fp32）
      · FinalLayer.video_out / audio_out（checkpoint 自带的 fp32 岛）
      · adaln curves 打开时的 AdalnProj

    include_quantized=False（W_ALL）：int8 / int4 / fp8 量化权重一律「存量化、
    算 FP16」，显存不翻倍，前向时才由 cast_bias_weight 反量化。
    include_quantized=True（W_EVERYTHING）：连量化权重也 dequantize 成稠密张量，
    权重占用翻倍 —— 调用方要把 budget 传 None，否则会被预算中途截停，
    留下「一半稠密一半量化」的混合状态。

    固定豁免（保持原 dtype）：
      1. 名字里带 audio 的模块 —— audio_patch_proj、final_layer.audio_out。
         音频链路对精度更敏感，怕转 FP16 出现失声/爆音，保持 checkpoint 原样；
         （block 里的 attn/mlp/adaln 是音视频共用的，不算 audio 专属，照常转）
      2. 动态权重加载（aimdo vbar）托管的模块、meta 参数。

    返回统计字典，供日志与 state() 使用。
    """
    stats = {
        "converted": 0, "converted_bytes": 0, "already": 0, "quantized": 0,
        "expanded": 0, "expand_failed": 0,
        "audio": 0, "meta": 0, "vbar": 0, "budget_stop": False, "from": {},
    }
    for name, module in diffusion_model.named_modules():
        # audio 专属的投影/输出头保持原精度
        if "audio" in name.rsplit(".", 1)[-1].lower():
            stats["audio"] += _count_params(module)
            continue
        # 动态权重加载（aimdo vbar）管理的模块，权重挂在虚拟地址页表上，
        # 直接换张量会把页表打乱 —— 这类模块原样放过。
        if getattr(module, "_v", None) is not None:
            stats["vbar"] += _count_params(module)
            continue
        for pname, param in list(module._parameters.items()):
            if param is None:
                continue
            if param.is_meta:
                stats["meta"] += 1
                continue
            if _is_quantized_param(param, module, pname):
                if not include_quantized:
                    stats["quantized"] += 1
                    continue
                grown = _expand_quantized(module, pname, param, dtype)
                if grown is None:
                    stats["expand_failed"] += 1
                    continue
                stats["expanded"] += 1
                stats["converted_bytes"] += grown
                continue
            if param.dtype == dtype:
                stats["already"] += 1
                continue
            nbytes = param.numel() * param.element_size()
            if budget is not None and stats["converted_bytes"] + nbytes > budget:
                stats["budget_stop"] = True
                continue
            module._parameters[pname] = torch.nn.Parameter(
                param.detach().to(dtype), requires_grad=param.requires_grad
            )
            stats["converted"] += 1
            stats["converted_bytes"] += nbytes
            key = _dtype_label(param.dtype)
            stats["from"][key] = stats["from"].get(key, 0) + 1
    return stats


def _format_cast(stats, dtype):
    target = _dtype_label(dtype)
    text = (
        f"转成 {target} {stats['converted']} 个张量"
        f"（{stats['converted_bytes'] / (1 << 20):.1f} MiB"
    )
    if stats["from"]:
        text += "，原 " + "/".join(
            f"{k}×{v}" for k, v in sorted(stats["from"].items(), key=lambda kv: -kv[1])
        )
    text += "）"
    if stats["already"]:
        text += f"｜本来就是 {target} {stats['already']} 个"
    if stats["expanded"]:
        text += f"｜量化权重已展开 {stats['expanded']} 个"
    if stats["quantized"]:
        text += f"｜量化保留 {stats['quantized']} 个"
    if stats["expand_failed"]:
        text += f"｜⚠ 量化展开失败 {stats['expand_failed']} 个（保持量化存储）"
    if stats["audio"]:
        text += f"｜audio 保持原精度 {stats['audio']} 个"
    if stats["vbar"]:
        text += f"｜动态加载跳过 {stats['vbar']} 个"
    if stats["meta"]:
        text += f"｜meta 跳过 {stats['meta']} 个"
    if stats["budget_stop"]:
        text += "｜⚠ 超出预算已停止（整模型换精度请用 --fp16-unet 启动）"
    return text


def _quant_summary(diffusion_model):
    """统计块内的 int8 权重（含 convrot 标记），用于日志。"""
    from comfy.quant_ops import QuantizedTensor

    formats = {}
    total = 0
    for block in getattr(diffusion_model, "blocks", []):
        for module in (block.attn.qkv_proj, block.attn.out_proj, block.mlp.fc1, block.mlp.fc2):
            weight = getattr(module, "weight", None)
            total += 1
            if isinstance(weight, QuantizedTensor):
                layout = getattr(module, "layout_type", None) or type(weight).__name__
                params = getattr(weight, "params", None)
                convrot = bool(getattr(params, "convrot", False))
                key = f"{layout}{'+convrot' if convrot else ''}"
            else:
                key = f"dense-{weight.dtype}" if torch.is_tensor(weight) else "none"
            formats[key] = formats.get(key, 0) + 1
    return formats, total


def _format_quant(formats):
    return ", ".join(f"{k}×{v}" for k, v in sorted(formats.items(), key=lambda kv: -kv[1]))


# ---------------------------------------------------------------- Tensor Core 调度


def _tune_matmul():
    """把能省的精度开关都打开；只动对当前架构没有副作用的项。"""
    changed = []
    flags = [
        ("allow_fp16_reduced_precision_reduction", True),
        ("allow_fp16_accumulation", True),
    ]
    for name, value in flags:
        if not hasattr(torch.backends.cuda.matmul, name):
            continue
        if getattr(torch.backends.cuda.matmul, name) != value:
            setattr(torch.backends.cuda.matmul, name, value)
            changed.append(name)
    return changed


# ---------------------------------------------------------------- 主入口


def apply(model, precision=PREC_FP16, weights=W_DEQUANT, numeric_guard=True, verbose=True):
    try:
        mm = _mm()
    except Exception as exc:  # ComfyUI 结构变了
        logging.warning("%s 无法导入 comfy.ldm.minimax.model（%r），节点不生效。", _PREFIX, exc)
        return model

    patcher = model.clone()
    diffusion_model = patcher.get_model_object("diffusion_model")
    if not isinstance(diffusion_model, mm.MiniMaxH3Model):
        logging.warning(
            "%s 接的不是 MiniMax H3（%s），节点原样放行。",
            _PREFIX, type(diffusion_model).__name__,
        )
        return patcher

    # 本节点在每个 block 内部动态申请/释放临时显存（FP32 残差、逐层反量化权重），
    # 与 ComfyUI 0.43 的 aimdo 显存编译图（逐块预编译分配计划）本质冲突，必须让路。
    compiler_guard.request("fp16_turbo")

    # 老工作流存下来的旧下拉字符串，先归一化再解析 dtype
    if precision == PREC_LEGACY_FP16:
        precision = PREC_FP16
    if weights not in WEIGHT_CHOICES:
        weights = _WEIGHT_ALIASES.get(weights, W_ALL)
    expand_all = weights == W_EVERYTHING

    dtype = _torch_dtype(precision)
    use_fp16 = dtype == torch.float16
    guard = bool(numeric_guard) and use_fp16
    if not use_fp16:
        guard = False

    cast_stats = None
    _STATE.update(
        enabled=True, precision=precision, weights=weights,
        guard=guard, verbose=bool(verbose), cast=None,
        blocks=len(diffusion_model.blocks), dequant_calls=0,
    )

    # ---- 1. 计算精度：manual_cast_dtype 决定整体 calc dtype
    patcher.set_model_compute_dtype(dtype)
    if expand_all:
        # 连 int8/int4 一起展开成稠密张量：预算必须放开，否则会被中途截停，
        # 留下「一半稠密一半量化」的混合状态，比不转更糟。
        if verbose:
            logging.warning(
                "%s 「%s」会把量化权重 dequantize 成稠密 %s，权重占用约翻倍"
                "（H3 约 20GB → 40GB）。显存吃不住的机器请改用「%s」。",
                _PREFIX, W_EVERYTHING, _dtype_label(dtype), W_ALL,
            )
        cast_stats = _cast_all_weights(
            diffusion_model, dtype, verbose=verbose,
            include_quantized=True, budget=None,
        )
    else:
        # 只转目标精度里「本来不是这个精度」的那部分：fp32/bf16 的岛就地换掉，
        # int8/int4/fp8 保持量化存储，交给 cast_bias_weight 在前向时反量化。
        cast_stats = _cast_all_weights(
            diffusion_model, dtype, verbose=verbose,
            include_quantized=False, budget=CAST_BUDGET_BYTES,
        )
    _STATE["cast"] = cast_stats

    # ---- 2. 数值保护 + FP16 边界
    conflicts = _builtin_fix_present(diffusion_model)
    if conflicts and guard:
        logging.info(
            "%s 模型里已经有 minimax_h3_fp16_fix.py 的 FP16 数值保护"
            "（out_proj ÷64、fc2 ÷256 都已经装好了）。本节点不再重复缩放，"
            "数值保护交给它，本节点只负责计算精度与 INT8→FP16 权重路径；"
            "残差流 FP32、rope 表对齐、block 级 attention 覆盖仍由本节点提供。",
            _PREFIX,
        )
        guard = False

    _STATE["guard"] = guard          # 冲突判定之后要回写，state() 才是真实值

    if use_fp16:
        condition_proj = diffusion_model.condition_proj
        patcher.add_object_patch(
            "diffusion_model.condition_proj.forward",
            _bind(condition_proj, _condition_proj_forward(condition_proj.forward)),
        )

    for index, block in enumerate(diffusion_model.blocks):
        if not use_fp16:
            break
        out_proj = block.attn.out_proj
        patcher.add_object_patch(
            f"diffusion_model.blocks.{index}.attn.out_proj.forward",
            _bind(out_proj, _out_proj_forward(out_proj.forward, K_OUT_PROJ if guard else 0.0)),
        )
        patcher.add_object_patch(
            f"diffusion_model.blocks.{index}.mlp.forward",
            _bind(block.mlp, _mlp_forward(block.mlp.forward, K_FC2 if guard else 0.0)),
        )
        patcher.add_object_patch(
            f"diffusion_model.blocks.{index}.forward",
            _bind(block, _block_forward(block.forward, guard)),
        )

    # ---- 3. Tensor Core 调度
    changed = _tune_matmul() if use_fp16 else []

    # ---- 4. 日志
    if verbose:
        formats, total = _quant_summary(diffusion_model)
        backend = "FP16 张量核（HMMA）" if use_fp16 else "BF16（原生，无张量核加速）"
        target = _dtype_label(dtype)
        weight_desc = (
            f"全部权重（含 int8/int4）展开为稠密 {target}，占用翻倍"
            if expand_all else
            f"除 int8/int4 外统一 {target}（量化权重保持 int8 存储，前向才反量化）"
        )
        logging.info(
            "%s 生效 | sm%d%d | 计算=%s | 权重=%s | 数值保护=%s | 块数=%d | "
            "块内线性层权重: %s | 张量核开关: %s",
            _PREFIX, _SM[0], _SM[1], backend, weight_desc,
            "开" if guard else "关", _STATE["blocks"], _format_quant(formats),
            ",".join(changed) if changed else "已是默认",
        )
        if cast_stats is not None:
            logging.info("%s 权重精度统一：%s", _PREFIX, _format_cast(cast_stats, dtype))
        if _SM[0] < 8:
            logging.info(
                "%s 本卡（sm%d%d）没有 bf16 张量核，FP16 才是最快的半精度路径；"
                "非量化权重（含 fp32/bf16 的岛）统一 %s，量化权重保持存储形态、"
                "只在计算时反量化。", _PREFIX, _SM[0], _SM[1], target,
            )
    return patcher


def state():
    return dict(_STATE)
