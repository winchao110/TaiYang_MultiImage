"""TaiYang · MiniMax H3 模型侧节点（两个）

    UNETLoader ──► 【模型计算FP16】 ──► 【显存分块加载】 ──► 【注意力后端】 ──► LoRA / 采样器

  1. 模型计算FP16   —— 把非量化权重统一到目标精度（默认 FP16），int8/int4 保持存储形态、
                       前向才反量化；顺带做 H3 在 FP16 下的三处数值保护。
  2. 显存分块加载 —— 沿 token 维切分注意力 / 位置编码 / 前馈三处临时激活峰值。

两个节点都不绑定显卡型号：FP16 / BF16 都是通用精度，数值保护来自 FP16 格式本身的
65504 上限，分块只是显存预算问题。20 系（图灵，sm75）上没有 bf16 张量核，收益最大；
30/40/50 系同样能跑，只是原生 bf16 张量核已经够快，收益没那么明显。

两个节点互不依赖，都可以单独使用；关掉即回到原生路径。

关于 ComfyUI 0.43 的「显存编译图」：这两个节点都会在每个 block 内部动态申请临时显存
（FP32 残差、逐层反量化权重、分块缓冲），与 aimdo 逐块预编译分配计划的做法本质冲突，
会在第二遍采样时抛 `aimdo memory compile error`。所以只要这两个节点里有任何一个处于
开启状态，本模块会在运行时把 ComfyUI 的 `--disable-comfy-compiler` 打开（只停显存
分配计划，动态显存加载 / 权重流式加载 / 预取队列全部保留）；两个都关掉后自动恢复。
"""

from . import compiler_guard
from .chunking import install as install_chunking
from .fp16_turbo import PRECISION_CHOICES, WEIGHT_CHOICES, apply as apply_fp16_turbo

_CATEGORY = "TaiYang"


class TaiYangH3FP16Turbo:
    """模型计算FP16：把非量化权重统一到目标精度，量化权重保持存储形态。"""

    DESCRIPTION = (
        "把 H3 的权重统一到目标精度，让每个 Linear 都落在真张量核上。"
        "MiniMax H3 声明的推理 dtype 只有 bf16/fp32，原生跑的是"
        "「fp32 残差 + bf16 调制参数 + int8 权重 + 几处 fp32 岛」。本节点做三件事：\n"
        "① 权重统一（int8/int4 除外）：int8/int4 量化权重一个都不转，原地不动继续"
        "省显存，只在前向那一瞬间反量化成 FP16 送给张量核，算完即弃、不驻留、不翻倍；"
        "fp32 与 bf16 的权重（video_patch_proj、time_embedder、FinalLayer.video_out、"
        "adaln curves）直接就地换成 FP16 张量。"
        "audio 专属的两处（audio_patch_proj、FinalLayer.audio_out）刻意保持原精度，"
        "避免音频转半精度后失声或爆音。\n"
        "② Tensor Core 调度：DiT 块内部所有矩阵乘的输入统一 FP16（残差流保持 FP32），"
        "让每个 Linear 落在 HMMA 类指令上，而不是 bf16 的模拟路径"
        "（没有 bf16 张量核的卡上，bf16 GEMM 会退化成慢十倍的模拟实现）。\n"
        "③ FP16 数值保护：H3 有三处会超出 FP16 上限 65504 —— condition_proj 输入（~96k）、"
        "残差流（attention sink 行会涨到 ~4.3M）、out_proj/fc2 输出（2M 以上）。"
        "处理方式是残差流用 FP32、投影前后乘以 2 的幂（out_proj 64、fc2 256），"
        "因为投影是线性的，这个缩放是精确的，只挪指数范围，不损失精度。\n"
        "「量化权重」有两档：默认的「BF16,FP32转为FP16」只换非量化权重，"
        "int8/int4 仍以 int8 存储、前向那一瞬间才反量化，显存占用不变；"
        "「全部权重转为FP16」会把 int8/int4 也 dequantize 成稠密 FP16，"
        "权重占用约翻倍（H3 约 20GB → 40GB），24GB 卡选它一定 OOM，"
        "只有大显存、或内存充足能 offload 的机器才吃得下。"
        "计算精度也可切 BF16（本来就快 bf16 的卡上它才是首选；没有 bf16 张量核的卡上"
        "会走模拟，最慢，仅在排查问题时用）。\n"
        "接法：模型 → 本节点 → 显存分块加载 / 注意力加速。本节点只改权重与激活的 "
        "dtype，不碰注意力内核，所以下游节点照常生效。\n"
        "注：本节点会在每个 block 内部动态申请/释放临时显存（FP32 残差 + 逐层反量化），"
        "与 ComfyUI 0.43 的 aimdo 显存编译图不兼容，启用本节点时会自动关闭那个编译图"
        "（只停分配计划，动态显存加载与权重预取不受影响）。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "启用": ("BOOLEAN", {"default": True,
                                    "label_on": "开",
                                    "label_off": "关",
                                    "tooltip": "关掉立刻还原成原生（bf16 + int8 内核），模型原样往下传。"}),
                "计算精度": (PRECISION_CHOICES, {"default": PRECISION_CHOICES[0],
                                               "tooltip": "要转成哪个精度。只影响 fp32 / bf16 的权重，"
                                                          "int8 / int4 量化权重永远不转。"
                                                          "FP16：任何显卡都有硬件张量核的半精度格式，推荐。"
                                                          "BF16：H3 的原生格式；有 bf16 张量核的卡"
                                                          "（sm80 及以上）用它最合适，"
                                                          "没有的卡上 bf16 GEMM 是模拟实现"
                                                          "（实测只有 fp16 的 1/10 速度），"
                                                          "只在排查数值问题时用。"}),
                "量化权重": (WEIGHT_CHOICES, {"default": WEIGHT_CHOICES[0],
                                            "tooltip": "BF16,FP32转为FP16：只转 fp32 / bf16 的权重"
                                                       "（video_patch_proj、time_embedder、"
                                                       "final video_out、adaln curves），"
                                                       "int8 / int4 / fp8 量化权重一个都不转，"
                                                       "存储仍是 int8（省显存），"
                                                       "只在前向那一瞬间反量化成 FP16 喂张量核。"
                                                       "audio 专属的 audio_patch_proj 与 audio_out "
                                                       "保持原精度，防止失声/爆音。"
                                                       "全部权重转为FP16：连 int8 / int4 也 "
                                                       "dequantize 成稠密 FP16 张量，"
                                                       "权重占用约翻倍（H3 约 20GB → 40GB），"
                                                       "24GB 卡选它一定 OOM，"
                                                       "只有大显存或内存充足能 offload 的机器才吃得下。"}),
                "数值保护": ("BOOLEAN", {"default": True,
                                       "label_on": "开（推荐）",
                                       "label_off": "关",
                                       "tooltip": "FP16 下 H3 的残差流、condition_proj 输入、"
                                                  "out_proj/fc2 输出都会溢出 65504，关掉会出现黑图或 NaN。"
                                                  "只在你想复现问题或做数值对比时关。"}),
                "显示信息": ("BOOLEAN", {"default": True,
                                       "label_on": "开", "label_off": "关",
                                       "tooltip": "在控制台打印生效后的精度、权重格式分布、"
                                                  "块数与开关状态。"}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = _CATEGORY
    OUTPUT_NODE = False
    # 搜 taiyang / sun / h3 都能找到（server.py 会把它当作 search_aliases 发给前端）
    SEARCH_ALIASES = [
        "taiyang", "tai yang", "sun", "H3", "MiniMax H3", "minimax",
        "模型计算FP16", "fp16", "half", "精度", "权重", "量化",
    ]

    def apply(self, model, 启用, 计算精度, 量化权重, 数值保护, 显示信息):
        if not 启用:
            compiler_guard.release("fp16_turbo")
            return (model,)
        return (apply_fp16_turbo(
            model,
            precision=计算精度,
            weights=量化权重,
            numeric_guard=数值保护,
            verbose=显示信息,
        ),)


class TaiYangH3ActivationChunk:
    """显存分块加载：只降临时显存峰值，不改算法、不改注意力后端。"""

    DESCRIPTION = (
        "显存分块加载：把一次要算的大批 token 拆成若干小段，逐段算完再拼回原样。"
        "与显卡型号无关，纯按显存预算决定切多大。\n"
        "把一次要算的大批 token 拆成若干小段，逐段算完再拼回原样，"
        "避开「一次性把整段激活全塞进显存」的峰值：\n"
        "① 注意力每段长度：投影的全序列输出与矩阵乘工作区（int8 权重路径会实体化 "
        "INT32 收缩空间，这一项最吃显存）；\n"
        "② 位置编码每段长度：归一化 + 位置旋转按段原地写回，频率表同步切片；\n"
        "③ 前馈网络每段长度：升维 → 门控 → 降维按行独立，逐段计算。\n"
        "输出投影保护与显存不足自动减半都是常开的，不占参数：输出投影按当前可用显存"
        "估算，余量够就整段一次（零开销），吃紧才自动切块；哪一段撞显存不足就把那一段"
        "减半重试，后续 block 沿用，其它参数不动。\n"
        "注意：分块降低的是峰值占用，不减少计算量，显存本来就够时不会更快，"
        "反而可能因为小矩阵乘变多而略慢；它的价值是让长序列不 OOM、不落共享显存。\n"
        "注意力后端、精度、权重格式、采样器、latent、VAE、时长、分辨率全部不碰。\n"
        "注：分块按段申请/释放缓冲，最后一段长度还与前面不同，与 ComfyUI 0.43 的 aimdo "
        "显存编译图（逐块预编译分配计划）不兼容；启用本节点时会自动关闭那个编译图，"
        "动态显存加载、权重流式加载与预取队列都不受影响。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        # 三个长度放在 optional：老工作流里存的是旧键名（QKV分块 / RoPE分块 / MLP分块），
        # 放 required 会因为「新键名缺失」直接报 required input missing，
        # 放 optional 就退回默认值，行为与老版本默认值完全一致。
        return {
            "required": {
                "model": ("MODEL",),
                "启用": ("BOOLEAN", {"default": True,
                                    "label_on": "开", "label_off": "关",
                                    "tooltip": "关掉即完全不装分块，模型原样往下传。"}),
            },
            "optional": {
                "注意力每段长度": ("INT", {"default": 4096, "min": 0, "max": 65536, "step": 256,
                                        "tooltip": "一次算多少个 token。0 = 整段一次（只保留显存不足兜底）。"
                                                   "数值越大越快、越吃显存。22G 显存建议 4096；"
                                                   "长序列报显存不足就往下调，最小 256。"}),
                "位置编码每段长度": ("INT", {"default": 8192, "min": 0, "max": 65536, "step": 256,
                                          "tooltip": "一次算多少个 token 的位置编码。这一项很便宜，"
                                                     "所以默认给得比另外两项大。22G 显存建议 8192；"
                                                     "0 = 整段一次。"}),
                "前馈网络每段长度": ("INT", {"default": 4096, "min": 0, "max": 65536, "step": 256,
                                          "tooltip": "一次算多少个 token 的前馈（升维→门控→降维）。"
                                                     "每一行独立，可以任意切。22G 显存建议 4096；"
                                                     "0 = 整段一次。"}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = _CATEGORY
    OUTPUT_NODE = False
    # 搜 taiyang / sun / h3 / 分块 都能找到
    SEARCH_ALIASES = [
        "taiyang", "tai yang", "sun", "H3", "MiniMax H3", "minimax",
        "显存分块加载", "显存分块", "分块", "chunk", "vram", "显存", "oom",
    ]

    def apply(self, model, 启用, 注意力每段长度=4096, 位置编码每段长度=8192, 前馈网络每段长度=4096):
        return (install_chunking(
            model,
            enabled=启用,
            qkv_chunk=注意力每段长度,
            rope_chunk=位置编码每段长度,
            mlp_chunk=前馈网络每段长度,
            out_proj_guard=True,   # 常开
            auto_halve=True,       # 常开
            verbose=False,         # 不逐段刷屏
            announce=True,         # 采样前只打一条汇总
        ),)


NODE_CLASS_MAPPINGS = {
    "TaiYangH3FP16Turbo": TaiYangH3FP16Turbo,
    "TaiYangH3ActivationChunk": TaiYangH3ActivationChunk,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TaiYangH3FP16Turbo": "模型计算FP16",
    "TaiYangH3ActivationChunk": "显存分块加载",
}
