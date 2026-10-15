# TaiYang Multi Image Loader

一个 ComfyUI 自定义节点：在单一节点内管理最多 16 张参考图，并**自动连线**到下游的多图接入节点。

## 功能

### 多图管理
- 单节点最多 16 张参考图，网格布局、大图预览（完整显示不裁切）
- 支持上传、删除、**拖拽排序**（带动画让位效果）
- 单击无副作用，只有按住并移动超过 8px 才触发拖拽
- 输出槽数量跟随图片数动态变化：传几张图就显示几个 `image_N`

### 自动连线（auto_link）
自动把图片按顺序连到下游节点的多图输入槽，支持：

| 目标节点 | 槽位类型 | 示例 |
|---|---|---|
| `TextEncodeQwenImage21` | TemplateNames（1 基） | `images.image_1` |
| `MiniMaxH3ReferenceToVideo` | TemplatePrefix（0 基） | `ref_images.ref_image_0` |
| `MiniMaxH3MaterialPromptStar7` | TemplatePrefix（0 基） | `ref_images.ref_image_0` |
| `TextEncodeQwenImageEditPlus` | 固定槽位 | `image1` / `image2` / `image3` |

- **自动发现**：扫描画布，任何带 `images` / `ref_images` autogrow 组的节点都会被接入
- **手动指定**：右键菜单可锁定某个节点类型，或指定白名单外的任意节点
- **空槽安全**：没有图的输出返回 `None`，不会把 64×64 黑图当参考图喂给模型
- 目标节点槽位不足时会自动扩展（autogrow）

### 拖拽排序
- 按住图片拖动，其余图片实时**滑动让位**
- 松手后顺序落盘，下游连线**自动跟随**（`image_N` 接的是新顺序下第 N 位的图）
- 拖动中可随时改变目标位置，动画连贯衔接

### 多音频加载（Multi Audio Loader）
同包内第二个节点，功能与多图节点一致，只是把图片换成音频：

- 单节点最多 **8 个音频**，网格布局，格子内显示音符图标 + 文件名
- **拖拽排序**：按住拖动实时让位，松手后顺序落盘、连线自动跟随
- **自动连线**：连到各多音频参考节点（见下表），空音频槽返回 `None`

**音频自动连线目标：**

| 目标节点 | 槽位类型 | 示例 |
|---|---|---|
| `MiniMaxH3ReferenceToVideo` | TemplatePrefix（0 基，autogrow 动态槽） | `ref_audios.ref_audio_0` |
| `MiniMaxH3MaterialPromptStar7` | 固定槽位 | `ref_audio_0` / `ref_audio_1` / `ref_audio_2` |

- 音频经 ComfyUI 的 `/upload/image` 端点上传（唯一通用上传端点），落到 `input/` 目录
- 后端用 `torchaudio` 加载，输出 `{"waveform": ..., "sample_rate": ...}`，与内置 LoadAudio 节点一致

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

ComfyUI 本身已包含全部依赖（`numpy`、`torch`、`Pillow`、`folder_paths`），无需额外安装。

## 兼容性

- ComfyUI 1.5x 及以上（前端 autogrow API）
- 纯前端扩展 + 后端节点，无外部服务依赖

## 已知限制

- `auto_link` 自动发现模式下，一个 loader 会同时连接画布上**所有**符合条件的节点；
  如需只连某一个，请用右键菜单「指定多图目标」锁定

## License

MIT
