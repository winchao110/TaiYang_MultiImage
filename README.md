# TaiYang Multi Image / Audio Loader

一套 ComfyUI 自定义节点：在单一节点内管理参考图或参考音频，并**自动连线**到下游的多图 / 多音频接入节点。

> **这两个节点主要为 MiniMax H3 与 Qwen Image 2.1 服务。**
> 有了它们，给 H3 / Qwen 喂多张参考图（音频）不需要再串一长串加载节点，
> 放好图就会自动接到对应的多图参考槽位上。

| 节点 | 用途 | 数量上限 |
|---|---|---|
| **Multi Image Loader** | 多图参考 + 尺寸缩放 | 最多 16 张 |
| **Multi Audio Loader** | 多音频参考 | 最多 8 个 |

## 功能

### 多图管理
- 单节点最多 16 张参考图，网格布局、大图预览（完整显示不裁切）
- 支持上传、删除、**拖拽排序**（带动画让位效果）
- 单击无副作用，只有按住并移动超过 8px 才触发拖拽
- 输出槽数量跟随图片数动态变化：传几张图就显示几个 `image_N`
- 每张图下方直接显示**实际送入模型的分辨率**（如 `978 × 1072`）

### 尺寸缩放（等价内置 ImageScaleToTotalPixels）
内置了 ComfyUI `Scale Image to Total Pixels` 的能力，省掉再串一个缩放节点。两项参数都**支持填任意数字**：

| 项 | 说明 | 范围 |
|---|---|---|
| 百万像素 | 目标总像素数 ÷ 1024²。`0` = 关闭缩放，保持原分辨率 | 0 ~ 16 |
| 分辨率倍数 | 缩放后的宽高会对齐到该数字的整数倍 | 1 ~ 256（默认 **32**） |
| 插值算法 | `nearest-exact` / `bilinear` / `area` / `bicubic` / `lanczos` | 默认 bilinear |

**操作方式**（两种都行）：
- 点节点底部**缩放条**：左半区改百万像素、右半区改分辨率倍数，弹窗直接输入数字
- 右键菜单：「缩放：输入百万像素」「分辨率倍数：输入数字」「插值算法」「关闭缩放」

**行为说明**：
- 算法与内置节点完全一致：按 `总像素数 = megapixels × 1024²` **等比**缩放，不裁剪、不变形
- 格子里的分辨率实时反映缩放结果（绿色 = 缩放生效，灰色 = 保持原分辨率）
- 缩放只影响送进模型的尺寸，画布预览始终显示原图

### 自动连线（auto_link）
自动把图片按顺序连到下游节点的多图输入槽，支持：

| 目标节点 | 槽位类型 | 示例 |
|---|---|---|
| `TextEncodeQwenImage21` | TemplateNames（1 基） | `images.image_1` |
| `MiniMaxH3ReferenceToVideo` | TemplatePrefix（0 基） | `ref_images.ref_image_0` |
| `MiniMaxH3MaterialPromptStar7` | TemplatePrefix（0 基） | `ref_images.ref_image_0` |
| `TextEncodeQwenImageEditPlus` | 固定槽位（3） | `image1` / `image2` / `image3` |
| `TE_Qwen_Image_2_1_Prompt_Enhancer`<br>（TE MAN Qwen Image 2.1 AI提示词增强） | 固定槽位（8，中文 1 基） | `图片` / `图片2` … `图片8` |

- **自动发现**：扫描画布，任何带 `images` / `ref_images` autogrow 组的节点都会被接入
- **手动指定**：右键菜单可锁定某个节点类型，或指定白名单外的任意节点
- **空槽安全**：没有图的输出返回 `None`，不会把 64×64 黑图当参考图喂给模型
- 目标节点槽位不足时会自动扩展（autogrow）

### 拖拽排序
- 按住图片拖动，其余图片实时**滑动让位**
- 松手后顺序落盘，下游连线**自动跟随**（`image_N` 接的是新顺序下第 N 位的图）
- 拖动中可随时改变目标位置，动画连贯衔接

### 多音频加载（Multi Audio Loader）
同包内第二个节点，专门给 **MiniMax H3** 喂参考音频。功能与多图节点一致，只是把图片换成音频。

**能力：**

| 能力 | 说明 |
|---|---|
| 多音频管理 | 单节点最多 **8 个音频**，**上下排列的长条形**布局，波形区长而扁，操作面积大 |
| **区间裁剪** | 每条音频有两条竖线：**左边 = 起始位置**、**右边 = 结束位置**，拖动即可裁剪，只把这一段送进模型 |
| **时间刻度** | 波形区下方一排刻度，**单位「秒」强制显示**（如 `0秒  5秒  10秒`），间隔按时长自动选，不挤在一起 |
| **点击试听** | 点音频从起点播到终点，**再点一次停止**；播放时有黄色播放头 |
| 拖拽排序 | 按住拖动实时让位，松手后顺序落盘、连线自动跟随 |
| 自动连线 | 自动接到下游多音频参考节点，无需手动连线 |
| 输出槽 | `audio_1` ~ `audio_8`，数量跟随音频数动态变化 |
| 空槽安全 | 没有音频的槽返回 `None`，不会把无效音频喂进模型 |

**裁剪竖线怎么用：**

- 绿线 = 起始位置（可拖到任意位置，但**不会越过结束线**）
- 蓝线 = 结束位置（**只能在起始线右侧**，拖到左边会自动修正）
- 区间外的部分会变暗，区间内高亮，顶部显示 `1.50秒 → 4.25秒`
- 结束线拖到最右边 = 「播放到结尾」
- 波形区下方的时间刻度**一律带「秒」字**，间隔按时长自动选（0.2 / 1 / 2 / 5 / 10 / 30 秒…）
- **裁剪后的区间会真正送进模型**（不只是显示）：后端按同样区间切片音频
- 区间会保存进工作流，下次打开依然有效
- 误操作了可以右键「↺ 重置所有裁剪区间」或「✂ 重置某条音频的裁剪区间」

**音频自动连线目标：**

| 目标节点 | 槽位类型 | 示例 |
|---|---|---|
| `MiniMaxH3ReferenceToVideo` | TemplatePrefix（0 基，autogrow 动态槽） | `ref_audios.ref_audio_0` |
| `MiniMaxH3MaterialPromptStar7` | 固定槽位 | `ref_audio_0` / `ref_audio_1` / `ref_audio_2` |

> 自动发现只认 `ref_audios` 组，**不会误连** H3 上的 `ref_video_audios`（那是参考视频的原声）。

**技术细节：**
- 音频经 ComfyUI 的 `/upload/image` 端点上传（唯一通用上传端点），落到 `input/` 目录
- 后端用 `torchaudio` 加载，输出 `{"waveform": ..., "sample_rate": ...}`，与内置 LoadAudio 节点一致
- 试听走 **Web Audio API**：先 `decodeAudioData` 解码，再用 `source.start(0, 起点, 时长)` 按**采样点**播放。
  浏览器对无 Xing 头的 CBR MP3 只能按码率估算 seek 位置（可能差数秒），解码后可完全避免
- 解码后的精确时长会回填给刻度与竖线（`HTMLAudioElement` 的 metadata 对 MP3 只是估算值）
- 波形区显示**真实波形**（由解码数据提取峰值绘制），区间内外一眼可辨
- 非图像类功能（缩放）仅多图节点提供，音频节点不带缩放

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/winchao110/TaiYang_MultiImage.git
```

重启 ComfyUI 即可。分类 `TaiYang` 下有两个节点：

- **Multi Image Loader** —— 多图参考
- **Multi Audio Loader** —— 多音频参考

## 使用

### 多图
1. 添加节点 `Multi Image Loader`
2. 点击网格中的 `+` 上传图片（可多选）
3. 在画布上放置一个支持多图参考的节点（如 `TextEncodeQwenImage21`）
4. 图片会自动连过去；若没有，用右键菜单的「重新自动连线」

### 多音频
1. 添加节点 `Multi Audio Loader`
2. 点击 `+` 上传音频（可多选）
3. 放置 `MiniMaxH3ReferenceToVideo` 或 `MiniMaxH3MaterialPromptStar7`
4. 音频会自动连到 `ref_audio` 槽；拖动可改顺序，连线自动跟随

底部状态条显示当前 `auto_link` 模式，点击可在「自动 / 关闭」间切换。
右键菜单可指定具体目标节点类型。

## 依赖

ComfyUI 本身已包含全部依赖，无需额外安装：

- 多图节点：`numpy`、`torch`、`Pillow`、`folder_paths`
- 多音频节点：额外用到 `torchaudio`（ComfyUI 音频功能自带）

## 兼容性

- ComfyUI 1.5x 及以上（前端 autogrow API）
- 纯前端扩展 + 后端节点，无外部服务依赖
- 节点可正常**折叠**与**手动缩放**，自绘控件不会溢出到节点框外

## 已知限制

- `auto_link` 自动发现模式下，一个 loader 会同时连接画布上**所有**符合条件的节点；
  如需只连某一个，请用右键菜单「指定多图目标」锁定

## License

MIT
