# Auris Oculi 感知工具箱

DSH 插件：左侧栏一个入口，装一组**全部在本机运行**的小工具。不联网、不上传、不依赖云服务。

## 能做什么

| 能力 | 说明 |
|---|---|
| 视频逐帧观看 | B 站链接 → 下载 → 抽帧拼图 → 本机视觉模型 → 报告 |
| 一站式分析 | 一条视频/音频，画面和声音同时看 |
| 音频截取 | 按起止截一段，有画面出 mp4，纯音频出 mp3 |
| 韵律分析 | 27 个客观数字（音高/音域/微颤/频谱/包络/语速）+ 转写 |
| 声音笔记 | 记一句对声音的观察，可回查、可找相似 |
| 批量导入 | 整个文件夹丢进来，自动推标签并逐条分析 |
| 声纹比对 | 两条音频像不像同一个人 |
| 说话人聚类 | 一批音频按说话人分组，回答「大致有几个人」 |
| 说话人分离 | 单条音频分出「谁说了哪段」 |
| 变化点检测 | 这段里哪里变了（换腔/音高突变/响度突变/停顿） |
| 特征评测 | 这批数字到底能不能分开人/情绪 |
| 缓存清理 | 清掉中间产物，保留报告和成品 |

## 说清楚三件事

**一、它测量声音，不判断情绪。**

27 个数字都是可验证的（基频 152 Hz、音域 11 半音、每秒钟 3.3 个字），
但「这段是什么情绪」做不到——真实说话的 7 类情绪分类只有 34.3%，随机是 14.3%。
那些数字承载的是「怎么发声」，不是「什么情绪」。

**二、聚类和分离不可靠，要看 `caveats`。**

`speaker_cluster` / `speaker_diarize` 都基于 Resemblyzer 嵌入，
而它在这类音频上区分力不足：同人内部 0.79、不同人之间 0.75，只差 0.04。
`speakerCount: 1` 可能是「只有一个人」，也可能是「我分不出来」。

**三、声纹比对可靠，但要看长度和阈值。**

`speaker_compare` 是这一组里唯一稳的，前提是给 **4 秒以上**音频
（8 秒才稳定），且看**相对排位**而不是绝对分数。

---

## 安装

### 从 npm（推荐）

```bash
npm install -g dsh-auris-oculi
```

然后在 DSH 里启用（Plugins 面板，或写进 profile 的 `dsh.profile.bundles`）。

### 从本地目录（开发用）

DSH → **Plugins → Add plugin** → 选这个目录。

装好后左侧栏会出现入口。插件本身没有构建步骤，改代码刷新就生效。

### 开发模式（改代码立刻生效）

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$pkg = Get-Content "$prof\package.json" -Raw | ConvertFrom-Json
$pkg.dependencies | Add-Member -NotePropertyName "dsh-auris-oculi" \
  -NotePropertyValue "link:E:/path/to/dsh-auris-oculi" -Force
if ($pkg.dsh.profile.bundles -notcontains "dsh-auris-oculi") {
  $pkg.dsh.profile.bundles += "dsh-auris-oculi"
}
$pkg | ConvertTo-Json -Depth 20 | Set-Content "$prof\package.json" -Encoding utf8

$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\node_modules\pnpm\bin\pnpm.cjs"
node $pnpm install --dir $prof
```

装完重启 DSH。

---

## 依赖

分三类：**运行时**（没有就完全跑不了）、**按功能**（缺了某个功能不可用）、
**可选**（更强的效果）。每项都给了安装和验证命令。

全部装好之后，页面底部会实时显示每项的检测结果——缺了哪个一眼能看到。

### 一、运行时（必须有）

| 依赖 | 本机实测 | 用途 |
|---|---|---|
| Node.js ≥ 20 | v26.4.0 | DSH 运行时，通常已自带 |
| ffmpeg / ffprobe | 9.0.2 | 抽帧、截取、音频解码 |

**ffmpeg 安装**（三选一）：

```powershell
# A. winget（Win10+ 自带）
winget install Gyan.FFmpeg

# B. Chocolatey（本机用的这个）
choco install ffmpeg

# C. 手动：下载后把 bin 目录加到 PATH
#    https://www.gyan.dev/ffmpeg/builds/  （选 release-essentials）
```

验证：

```powershell
ffmpeg -version      # 应输出 "ffmpeg version 7.x" 或更高
ffprobe -version
```

> 装完要**重开终端**，PATH 才会刷新。插件也会去 `C:\ProgramData\chocolatey\bin`
> 和几个常见位置直接找，所以 PATH 没刷新也能用。

### 二、按功能（缺了对应功能不可用）

#### Python + 基础科学库（韵律分析、批量导入、所有声纹功能）

DSH 自带一个 Python 运行时，直接用它：

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

# 确认路径存在
Test-Path $py

& $py -m pip install librosa soundfile scipy numpy
```

约 100 MB（含 numba、llvmlite、scikit-learn）。

验证（括号里是本机实测的版本，仅供参考）：

```powershell
& $py -c "import librosa, soundfile, scipy, numpy; print('ok', librosa.__version__)"
#   本机：librosa 1.0.1 / soundfile ok / scipy 1.18.1 / numpy 2.3.5
```

#### 语音转写（transcript + 语速四维）

```powershell
& $py -m pip install sherpa-onnx
```

装完还不够，**需要 SenseVoice 模型文件**。没有模型时转写会被跳过
（`transcriptStatus` 为 `no_model`），韵律数字不受影响。

模型下载：`https://github.com/k2-fsa/sherpa-onnx/releases`
（找 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-*` 那个）

#### 声纹比对 / 聚类 / 分离

两个后端二选一，也可以都装：

```powershell
# 后端 A：Resemblyzer（装了就可用，无需额外模型）
& $py -m pip install resemblyzer webrtcvad-wheels

# 后端 B：CAM++（需要 sherpa-onnx + 模型文件，更准）
& $py -m pip install sherpa-onnx
```

**⚠️ 必须用 `webrtcvad-wheels`，不能装 `webrtcvad`** ——
后者在 Python 3.12+ 上编译失败。

**⚠️ Resemblyzer 首次运行会下载 voice encoder（约 200 MB）**，
看起来像卡住，等它下完就好。

CAM++ 模型（27 MB）放到插件的 `models/` 目录：

```text
https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
```

> URL 里 `recongition` 是官方拼错的，不是笔误。

验证：

```powershell
& $py -c "from resemblyzer import VoiceEncoder; VoiceEncoder('cpu'); print('voice ok')"
& $py -c "import sherpa_onnx; print('sherpa', sherpa_onnx.__version__)"
#   本机：resemblyzer ok / sherpa_onnx 2.0.2
```

#### 下载 B 站链接（视频总结、音频分析）

```powershell
# 方式 A：pip 装（推荐，能跟着 Python 一起更新）
& $py -m pip install -U yt-dlp

# 方式 B：单独下 exe，放到 PATH 里
#   https://github.com/yt-dlp/yt-dlp/releases  下 yt-dlp.exe
```

本机实际位置：`%APPDATA%\Python\Python315\Scripts\yt-dlp.exe`

**这个不在 PATH 里也能用**——插件会去 Python 的 Scripts 目录找。

验证：

```powershell
& "$env:APPDATA\Python\Python315\Scripts\yt-dlp.exe" --version
```

> `yt-dlp` 更新很频繁，B 站接口变了会导致下载失败。遇到「下载失败」先试 `-U` 升级。

#### 视频逐帧观看（视觉模型）

```powershell
# 1. 装 Ollama
winget install Ollama.Ollama
#   或 https://ollama.com/download

# 2. 拉模型（选一个）
ollama pull qwen3.5:4b        # 推荐，3.3 GB
# ollama pull qwen3-vl:4b     # 备选

# 3. 确认服务在跑
ollama list
```

**用 `qwen3.5:4b`，不要用 `qwen3-vl:4b`** ——后者在本机实测会返回空内容。

也可以用远程 Ollama 或 OpenAI 兼容接口（LM Studio / vLLM / OneAPI）：
在配置里改 `model.provider` 和 `model.host`。

### 三、可选

| 依赖 | 用途 | 装法 |
|---|---|---|
| `openpyxl` | 读 CNEV 那类声学参数表 | `& $py -m pip install openpyxl` |
| `pyarrow` | 直接读 HuggingFace 的 parquet 数据集 | `& $py -m pip install pyarrow` |

### 一次性装全

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py -m pip install librosa soundfile scipy numpy sherpa-onnx resemblyzer webrtcvad-wheels yt-dlp
```

外加系统层：`ffmpeg`（必装）、`Ollama + qwen3.5:4b`（看视频才需要）。

### 检查装全了没有

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

& $py -c "import librosa; print('librosa', librosa.__version__)"
& $py -c "import soundfile; print('soundfile ok')"
& $py -c "import sherpa_onnx; print('sherpa', sherpa_onnx.__version__)" 2>$null
& $py -c "from resemblyzer import VoiceEncoder; print('resemblyzer ok')" 2>$null
ffmpeg -version | Select-Object -First 1
ollama list
```

**或者直接看页面底部** —— 插件启动时会探测每项依赖，缺哪个都标出来。

### 缺依赖时的表现

| 缺什么 | 症状 |
|---|---|
| ffmpeg | 所有视频/音频工具报「找不到 ffmpeg」 |
| librosa | 韵律分析、批量导入不可用 |
| yt-dlp | 只能处理本地文件，B 站链接报错 |
| Ollama / 模型 | 视频逐帧观看不可用，其他正常 |
| SenseVoice 模型 | 没有 `transcript`，语速四维缺省 |
| 声纹后端 | 三个 `speaker_*` 工具报「模型不可用」 |
| CAM++ 模型 | 自动退回 Resemblyzer（不报错） |

---

## 页面

左侧栏 **Auris Oculi 感知工具箱**，三个标签页：

### 视频逐帧观看

粘贴 B 站链接（或 BV 号）→ 开始分析。流程是：

1. yt-dlp 下载（默认短边 1080，自动挑可用的最高清档）
2. ffmpeg 按间隔抽帧
3. Pillow 拼成带时间戳的 2×2 拼图（格子宽高比跟随画面，竖屏片不会压成横条）
4. 逐张交给本机 Ollama 视觉模型
5. 生成 `report.md`（逐格记录）+ 可选 `summary.md`

页面显示实时日志、进度条、报告和拼图缩略图。离开页面不会丢任务，回来会自动接上。

> 推荐 `qwen3.5:4b`。`qwen3-vl:4b` 在这类机器上会返回空内容且极慢，插件已不再提供该选项。

#### 清晰度是怎么决定的

三个地方都会影响模型能读出多少字，都是 0.11.1 修过的：

| 参数 | 默认 | 说明 |
|---|---|---|
| `video.height` | 1080 | 下载短边上限。**不是所有视频都有 1080**，B 站的部分高帧率档位需要大会员，取不到时会自动退到实际可用的最高档 |
| `video.sheetWidth` | 1000 | 拼图总宽，2 格横排，所以单格宽 = 一半 |
| `video.frameWidth` | 1000 | 单帧缩放后的宽度 |

**单格画面的实际像素**才是关键。竖屏视频（宽高比 0.56）在 1000 宽拼图下，单格是 500×889；
以前写死 16:9 时同样设置只有 101×180，因为 68% 面积是黑边。

调小 `sheetWidth` 能省时间，但会直接损失 OCR 准确率。

#### 抽帧密度（0.12.0 大幅放开）

「看多细」由这几个参数决定，都可以从配置页和工具参数调：

| 参数 | 默认 | 作用 |
|---|---|---|
| `video.maxSheets` | 12 | 拼图张数上限，**已放开到 500** |
| `video.minInterval` | 1.0 | 自动规划时的间隔下限，**可调到 0.2 秒** |
| `video.density` | `budget` | `budget`=在预算内均匀铺满；`max`=不管预算，抽到 `minInterval` 那么密 |
| `video.framesPerSheet` | 4 | 每张拼图几帧（4/6/9） |
| `video.perRow` | 2 | 每行几格（2/3），影响单格宽高比 |

**以前有个 1 秒硬下限**，短视频怎么调都是 1 秒/帧。现在去掉���：

```ts
// 每半秒看一帧，一部长片全看完（本机不怕慢）
video_summary({ url: "BV...", interval: 0.5, maxSheets: 200, waitSeconds: 3600 })
```

| 配置 | 60 秒片段的帧数 |
|---|---|
| 默认（budget, 12 张 × 4 格） | 48 帧（1.25 秒/帧） |
| budget, 40 张 | 160 帧 |
| `interval: 0.5` | 120 帧 |
| `density: "max"`, `minInterval: 0.2` | 300 帧（0.2 秒/帧） |

`framesPerSheet: 9` + `perRow: 3` 可以一屏看 9 格，但每格更小——格数和清晰度是此消彼长的。

#### 每个配置项都能从工具调用覆盖（0.12.1）

以前有一批配置只有配置页能改，agent 调用时改不了。现在对齐了：

| 分组 | 工具参数 |
|---|---|
| `video` | `height` `sheetWidth` `frameWidth` `framesPerSheet` `maxSheets` `concurrency` `interval` `minInterval` `density` `perRow` |
| `model` | `model` `numCtx` `numPredict` `timeoutSec` |
| `audio` | `f0Min` `f0Max` `language` `hop` |
| `speaker` | `seed` `merge` `window` |
| `changes` | `minPauseSec` `loudnessFloorDb` `loudnessCeilDb` `minGapSec` `pitchJumpSemitone` `registerMaxSemitone` |

验证方式是跑审计脚本（已接入 `npm test`）：

```bash
node scripts/audit-config.mjs
```

它会列出每个配置项的「agent 参数 / 环境变量 / 配置页」三条通路，并检查有没有
「注入了但所有 python 脚本都没读」的死键。0.12.1 就是靠它抓到 3 个死键的。

#### 关于「token repeat limit」

细节多的拼图偶尔会让 `qwen3.5:4b` 陷入重复输出，接口返回
`HTTP 500: prediction aborted, token repeat limit reached`。
这不是图太大，加 `num_predict` 只会让它重复更久。

已做四档退避：原图×600 → 原图×1200 → 缩 60%×1200 → 缩 45%×1600。
日志里会看到「撞重复上限（图太大），继续缩小重试」，然后重试成功。

### 关于摘要和 OCR 的可靠性

**画面里的文字是 OCR 读出来的，可能读错。** 实测一条视频的书封面，同一个作者名被读成「周晓辉」12 次、「司城怜」4 次、「周晓波」4 次，而真实名字是「圆城塔」——一次都没读对。

为此做了三层防护：

1. **报告里的「⚠ OCR 不稳定」段**：同一处文字被读成多种写法时自动列出
2. **摘要头部警告**：明确写「这是模型生成的摘要，不是事实核对」
3. **摘要前面放「视频信息」**：标题、UP 主、简介来自 B 站，可信，方便对照

摘要 prompt 也加了规则：同一人名出现多种写法时标「（OCR 识别，可能有误）」，不给作品补全作者和背景，用「画面显示」而不是「书中探讨」。

### 音频 · 截取与韵律

**截取**：填来源（本地路径 / 直链 / B 站链接）、起始、长度，选精确或快速模式。

- 有视频轨 → mp4；纯音频 → mp3
- 时间可写秒数（`83.5`）或 `mm:ss` / `hh:mm:ss`
- 长度留空 = 截到结尾
- **只展示音频播放器**——截这段是为了听语气，画面在这里没用

截完**自动跑一次韵律分析**，点「看韵律分析」直接跳到结果。

**韵律分析**给四组曲线 + 一段文本：

| 层 | 内容 |
|---|---|
| 响度 | RMS / dB |
| 基频 | pyin + YIN 双路追踪，附相对说话人的半音曲线 |
| 微颤 | 去趋势后的局部半音标准差，**只统计浊音帧**（清音/静音段不给值） |
| 清浊 | 浊音 / 清音（气声）/ 静音 三分类 |
| **文本** | **本机 SenseVoice 转写，带逐句时间戳** |
| **说话人** | **Resemblyzer 256 维嵌入，可比较两段是不是同一个人** |

转写结果和韵律数字是**对齐**的：每句话都带上它那段的基频、半音、微颤。这样"抖在哪个字上"才有意义——光有数字不知道说的是什么，光有文字不知道哪里在抖。

**微颤只对浊音帧有意义**：气声段没有稳定周期，算出来的"抖动"是噪声不是颤。所以非浊音帧的 jitter 是 `null`，汇总里的 `jitterVoicedFrames` 说明统计了多少帧。

**换腔提醒**：全片中位参考在整段同一腔调时没问题，但一段里换了发声位置（或换了人）时，后半段会被算成"高出十几半音"。工具会按 2 秒窗口算局部参考，发现某段偏离全片中位超过 4 个半音就给出 `registerWarning` 和具体时间段。

**疑似非人声检测**：两类东西会被误当成人声，数字看着都很正常：

| 类型 | 特征 | 判据 |
|---|---|---|
| **噪声**（雨声、风声） | 基频在随机乱跳 | 相邻帧跳变 P90 > 1.5 半音 |
| **稳态信号**（纯音、持续嗡鸣） | 基频几乎不动、状态从不切换 | 状态切换 < 0.3 次/秒 + 基频跨度 < 1 半音 |

真人声介于两者之间：相邻帧只缓慢滑动（P90 约 0.3 半音），但**一定会切换状态**（换气、辅音、停顿，实测 1.5–3.6 次/秒）。

命中时：

- `summary.suspectedNonSpeech: true` + `nonSpeechReasons`（具体原因）
- 工具返回值里警告排在数字**前面**
- **批量导入时这类样本不会写进标注池**，汇总表的中位数也会排除它们

实测：30 秒雨声 → 跳变 P90 2.80 半音、浊音 99%、转写只有一个句号 → 正确标出；真人声不误报。

**说话人嵌入**（可选）：用 Resemblyzer 算 256 维向量，传 `compare` 参数就返回两段的余弦相似度。

为什么不用基频/共振峰：实测 CASIA 1200 条，基频的「人之间/人内」比值只有 0.84，共振峰 F1/F2 只有 1.03——**同一个人不同情绪的波动比人跟人的差别还大**，这些数不能当身份标志。

换成训练好的模型后成立：

| 对比 | 相似度 |
|---|---|
| 同一人（不同语气） | 0.72–0.76 |
| 不同人 | 0.39–0.41 |

判定：≥0.70 很可能同一人，0.55–0.65 说不准，<0.55 很可能不是。

需要额外装：

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install resemblyzer webrtcvad-wheels
```

（`webrtcvad` 在 Python 3.12 上编译失败，用 `webrtcvad-wheels` 预编译版。没装也能用其他功能。）

**说话人聚类**用同样的嵌入，两步：种子分组（阈值 0.82）+ 质心合并（阈值 0.75）。

真实场景验证（3 条自己的录音 + 2 个陌生人）：

```text
组 1（3 条，相似度 0.753）：我-催、我-试探、我-随口
组 2（1 条）：陌生人 A
组 3（1 条）：陌生人 B
```

**它不能做什么**：不说「这是谁」（没有身份库），声音相近的人会被并到一起。CASIA 实测里 `liuchanhg` 与 `zhaoquanyin` 之间就有 0.717，比前者自己的内部下限 0.720 只低 0.003——这是模型上限，不是 bug。

本机有 SenseVoice 模型就自动转，没有就跳过（不影响分析）。模型位置：

```text
%USERPROFILE%\.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\
├── model.int8.onnx
└── tokens.txt
```

这是 DSH 自带语音输入插件下载的模型，装了那个插件就已经有了。

第一层只能分“响/不响”，气声和停顿在响度上都是“不响”；靠基频有无才能分开——这是第二层补上的第一块。

**批量导入**：把录音按语气分到子目录，整个文件夹丢进来。

```text
E:\录音\语气样本\
├── 催\     001.m4a ... 008.m4a
├── 试探\   001.m4a ... 008.m4a
└── 随口\   001.m4a ... 008.m4a
```

也认文件名前缀（`催-001.m4a`）和 `labels.csv`（两列：文件名,标签）。

**语气标注**：给任意一段打标签，按标签统计条数。

### 缓存

报告生成后中间产物就没用了。清理按类型分别处理：

| 类型 | 保留 | 清掉 |
|---|---|---|
| 视频分析 | report.md、summary.md、拼图、job.* | 源视频、抽出的帧 |
| 音频截取 | 成品 mp4/mp3、clip.* | 下载的源素材 |
| 韵律分析 | prosody.json、prosody.md、job.* | 解码的 wav |
| 标注 | **永远保留** | — |

三种力度：只清中间产物 / 删掉整个任务目录 / 连成品片段一起删。

---

## 配置

所有默认值都能改，界面里能用选的就不用手输。

### 模型后端

不只支持本地 Ollama：

| 后端 | 协议 | 适合 |
|---|---|---|
| Ollama | `/api/generate` | 本机或远程 Ollama |
| OpenAI 兼容 | `/v1/chat/completions` | LM Studio、vLLM、OneAPI、云端 API |

**模型列表自动扫描**：界面里点「重新扫描」会去后端拉列表，只显示支持视觉的模型（带大小标记）。

实测本机：

```text
qwen3-vl:4b     3.3GB  · 视觉
qwen3.5:4b      3.3GB  · 视觉
bge-m3:latest   1.2GB  （纯嵌入，不显示在可选列表）
```

扫不到时退回手输。

### 机况预设

| 预设 | 适合 |
|---|---|
| 低配 | 4GB 显存 / CPU 也能跑 |
| 均衡 | 8GB 左右（默认） |
| 高配 | 12GB+ 独显 |
| 纯 CPU | 无可用 GPU |

### 配置文件

`<TOOLBOX_HOME>/config.json`，可用 `XIYOUNG_CONFIG` 指到别处。

```json
{
  "preset": "high",
  "model": { "provider": "openai", "host": "https://api.example.com", "apiKey": "sk-..." },
  "video": { "maxSheets": 8 }
}
```

### 环境变量

```bash
XIYOUNG_MODEL_PROVIDER=openai
XIYOUNG_MODEL_HOST=https://api.example.com
XIYOUNG_MODEL_API_KEY=sk-...
XIYOUNG_VIDEO_MAX_SHEETS=3
```

### 优先级

```text
工具调用参数 > 环境变量 > config.json > 预设 > 内置默认
```

手动设置的项会盖住预设；切换预设时接口会返回 `shadowed` 指出哪几项被盖住。

### 接口

```
GET  /xiyoungtools/models          → 扫描后端可用模型
GET  /xiyoungtools/config          → 当前配置 + 预设列表
POST /xiyoungtools/config { preset: "high" }
POST /xiyoungtools/config { patch: { video: { maxSheets: 8 } } }
POST /xiyoungtools/config { reset: true }
```

## 会话工具

12 个工具，装好后任何会话都能直接调用。

### 选哪一个

| 你想做的事 | 用这个 |
|---|---|
| 一条视频/音频，画面和声音一起看 | `toolbox_analyze` |
| 只看 B 站视频讲了什么 | `video_summary` |
| 从视频/音频截一段下来 | `media_clip` |
| 一段音频的客观数字（音高、微颤、振幅、语速） | `prosody_analyze` |
| 记一句对声音的观察 | `prosody_label` |
| 整个文件夹批量分析 | `prosody_batch` |
| 两条音频像不像同一个人 | `speaker_compare` |
| 一批音频里大概有几个人 | `speaker_cluster` |
| 一条录音里谁在第几秒说话 | `speaker_diarize` |
| 这批标注值不值得用（特征能不能分开） | `toolbox_benchmark` |
| 查前面某个任务跑到哪了 | `toolbox_job` |
| 清理中间产物腾空间 | `toolbox_cache_clean` |

---

### 总览表

| 工具 | 必填 | 调用方式 | 耗时 |
|---|---|---|---|
| `toolbox_analyze` | `source` | 等结果 | 分钟级 |
| `video_summary` | `url` | 等结果或给 `jobId` | 分钟级 |
| `media_clip` | `source` `start` | 等结果 | 秒级 |
| `prosody_analyze` | `source` | 等结果 | 秒到分钟 |
| `prosody_label` | 无 | 立即返回 | 瞬时 |
| `prosody_batch` | `dir` | 等结果 | 分钟级 |
| `speaker_compare` | `a` `b` | **同步返回** | 几秒 |
| `speaker_cluster` | `dir` | 等结果 | 分钟级 |
| `speaker_diarize` | `source` | 等结果 | 分钟级 |
| `toolbox_benchmark` | `dir` | 等结果 | 分钟级 |
| `toolbox_job` | `id` | 立即返回 | 瞬时 |
| `toolbox_cache_clean` | 无 | 立即返回 | 秒级 |

超时没跑完会返回一个 id，之后用 `toolbox_job({ id })` 查——它按 id 自动判断类型，
不需要记「该用哪个 status 工具」。

---

### toolbox_analyze · 一站式分析

```ts
toolbox_analyze({ source: "video.mp4" })
toolbox_analyze({ source: "BV1xx411c7mD", only: "audio" })
toolbox_analyze({ source: "a.wav", start: 30, duration: 60 })
```

视频走「抽帧拼图 + 视觉模型」，音频走「韵律 + 转写」，两条流水线并行。
`only` 可以只要其中一路。

**画面质量取决于 `video.*` 配置**（分辨率、拼图宽、每格帧数）。想看清屏幕上的字，
把 `video.sheetWidth` 和 `frameWidth` 调大——代价是慢。

---

### video_summary · B 站视频逐帧观看

```ts
video_summary({ url: "BV1xx411c7mD" })
video_summary({ url: "BV1xx411c7mD", interval: 0.5, maxSheets: 100 })
```

下载最高可用清晰度 → 按间隔抽帧 → 拼成带时间戳的图 → 逐张交给视觉模型。

**密度怎么控**：

| 参数 | 作用 |
|---|---|
| `interval` | 每隔几秒抽一帧。给了就严格按它走，不再受 1 秒下限限制 |
| `density` | `budget`（在 maxSheets 预算内铺满）/ `max`（按 minInterval 抽到最密） |
| `maxSheets` | 最多拼几张图。本机不怕慢可以给到 100 以上 |
| `framesPerSheet` | 每张拼图放几帧（1~12） |

想细看就给 `interval: 0.5` + `maxSheets: 100`，代价是时间长。

**B站清晰度限制**：1080P60 需要会员。程序会按像素降序选实际可用的最高格式，
选不到 1080 就是选不到，不会假装。

---

### media_clip · 截取片段

```ts
media_clip({ source: "video.mp4", start: "1:30", duration: 30 })
media_clip({ source: "audio.mp3", start: 83.5, end: 120 })
```

`precise` 模式重编码、帧级精确但慢；`fast` 流复制、快但起点会对齐到关键帧。

---

### prosody_analyze · 音频的客观数字

```ts
prosody_analyze({ source: "a.wav" })
prosody_analyze({ source: "BV1xx411c7mD", start: 60, duration: 120 })
```

**返回 27 个数字**，分四组：

| 组 | 字段 | 测什么 |
|---|---|---|
| 韵律 | `f0Median` `semitoneRange` `trendSemitone` `jitterMedian` `jitterP90` `voicedRatio` `unvoicedRatio` `silenceRatio` `dbMedian` `dbMax` | 音高、音域、微颤、清浊、响度 |
| 频谱 | `spectralCentroid` `spectralRolloff` `spectralFlatness` `hnrMedian` `hnrP10` | 音色亮度、高频边界、噪声性、嗓音沙哑度 |
| 音强包络 | `dbRange` `dbStd` `dbSwing` `dbJitter` | 音量动态范围、起伏快慢 |
| 语速 | `charsPerSec` `speechDensity` `segmentCount` `avgSegmentSec` | 每秒字速、说话占比 |

语速需要转写，没有转写时这四项缺省（不猜）。

**同时会做**：转写（SenseVoice）、变化点检测、内容类型判断、说话人嵌入。

**别拿它判断情绪**。27 个数字够用来**描述**声音，不够用来**判断**情绪——
真实说话 7 类情绪分类只有 34.3%（随机 14.3%）。详见 `docs/emotion-data-findings.md`。

---

### prosody_label · 声音笔记

```ts
prosody_label({ note: "7.76 秒里断了 9 次，平均 0.86 秒一次", label: "哭腔" })
prosody_label({ action: "list", dataset: "caisa", limit: 20 })
```

记一条对声音的观察，可选短标签。`action: "list"` 时列出已有的，
支持 `dataset` / `label` 筛选，返回 `total`（池子总数）/ `tally`（各标签条数）/
`datasets`（各数据集条数）/ `file`（文件路径）。

**这个功能不是攒情绪训练样本**——那条路已证伪。它记的是可验证的观察：
「断几次」「自相关多少 Hz」「响度标准差多大」。

---

### prosody_batch · 批量导入

```ts
prosody_batch({ dir: "D:/samples" })
prosody_batch({ dir: "D:/casia", dataset: "caisa", labelFrom: "directory" })
```

认三种标签来源：`<dir>/催/001.wav`（目录名）、`<dir>/催-001.wav`（文件名前缀）、
`<dir>/labels.csv`（两列）。

完成后默认写进标注池（`prosody_label` 能查到），`features` 字段带上全部韵律数字。

**会自动跳过三类**：疑似非人声、疑似音乐、疑似唱歌。它们会污染样本池。

---

### speaker_compare · 两条音频像不像同一个人

```ts
speaker_compare({ a: "1.wav", b: "2.wav" })
speaker_compare({ a: "1.wav", b: "2.wav", extra: ["3.wav", "4.wav"] })
speaker_compare({ a: "1.wav", b: "2.wav", backend: "campplus" })
```

**同步返回**，几秒出结果，不进任务队列。

返回三个数：

| 字段 | 含义 |
|---|---|
| `raw` | 原始余弦（和旧阈值同坐标系，便于对照历史结论） |
| `centered` | 去中心化余弦（用本批均值） |
| `rankPercentile` | 在本批次所有配对里排第几（样本 <10 对时拒绝给） |

**为什么给三个**：嵌入有各向异性，原始余弦系统性虚高。实测 1176 个配对里
29.4% 被判成「同一人」，去中心化后降到 5.5%。

**两个后端**（`backend` 参数或配置 `speaker.backend`）：

| 后端 | 异人基准 | 同人/异人 | 错误率 |
|---|---|---|---|
| `campplus`（192 维，需模型） | 0.26 | 2.02 | 6.4% |
| `resemblyzer`（256 维，装了就能用） | 0.52 | 1.44 | 19.5% |

**⚠️ 两个后端的坐标系完全不同，不能混用阈值。** campplus 异人通常 0.1~0.4，
resemblyzer 能到 0.5+。拿旧阈值看 CAM++ 会把同人判成不像。

**音频要多长**：4 秒起，**8 秒稳定**。实测同一段录音切两半的同人相似度：

```text
1 秒 0.58   2 秒 0.56   4 秒 0.71   8 秒 0.88   12 秒 0.89
```

给 1~3 秒的音频时 `caveats` 会提示「判成不像时先别信」。

详见 `docs/speaker-reliability.md`。

---

### speaker_cluster · 一批音频里有几个人

```ts
speaker_cluster({ dir: "D:/samples" })
speaker_cluster({ dir: "D:/samples", seed: 0.85, merge: 0.78 })
```

两步聚类：先用高阈值（默认 0.82）做单链接把明显相同的连起来，
再用质心合并（默认 0.75）。单链接一步到底的传递性太强——实测阈值 0.72 时 32 条全并成 1 组。

**回答的是「哪几条像」，不是「这是谁」**。声音相近的人会被并到一起
（实测 CASIA 里两个人之间相似度 0.717）。

准确度受和 `speaker_diarize` 同样的限制：四人 80 条样本可能输出 9 个组，
其中第 1 组含 72 条。

---

### speaker_diarize · 一段录音里谁在说

```ts
speaker_diarize({ source: "meeting.mp4" })
```

按 2 秒窗算嵌入、聚类、合并相邻同簇的窗成段。

**⚠️ 这个结果不可靠，用前必须看 `caveats`。**

实测：真实 2 人对话被判成 1 人（整段并成一段），单人录音被判成 2 人。
根因不是聚类算法，是 Resemblyzer 嵌入在这类音频上区分力不足——
同人内部 0.79、不同人之间 0.75，只差 0.04。

现在返回可信度信号：

| 字段 | 含义 |
|---|---|
| `minCohesion` | 最弱那簇的组内相似度 |
| `contrast` | 同簇均值 − 跨簇均值（>0.1 才算真分开） |
| `pairSpan` | 所有窗两两相似度的分布宽度（窄 = 分不开） |
| `caveats` | 不可信时逐条说原因 |

**`speakerCount: 1` 可能是「只有一个人」，也可能是「我分不出来」。** 看 `caveats`。

---

### toolbox_benchmark · 这批标注值不值得用

```ts
toolbox_benchmark({ dir: "D:/casia" })
```

给一个带标签的文件夹（子目录名 = 标签），跑三个任务：

1. **分标签**（N 选 1）
2. **判同标签**（2 选 1，看平衡准确率）
3. **距离间隔**

对比三档特征：韵律 6 维 / MFCC 13 维 / 说话人嵌入 256 维，每项都给随机基线。

**这个工具的价值不是「提取数字」，是「判断数字能不能支撑结论」。**
它回答「我这批录音够不够用」「这几个标签到底能不能分开」——别的工具都做不到。

**看结果时注意**：判同标签必须看**平衡准确率**，总准确率会被类别不平衡骗到。

样本不足会直接报错（比如「评测至少要 4 条音频」），不强行算。

---

### toolbox_job · 查任务

```ts
toolbox_job({ id: "20261125-abc123" })
toolbox_job({ list: true, kind: "prosody" })
```

按 id 自动判断是视频分析、截取、韵律、批量、聚类、分离、评测还是一站式分析。
不用记「该用哪个 status 工具」。

---

### toolbox_cache_clean · 清理

```ts
toolbox_cache_clean({ kind: "runs", maxAgeDays: 7 })
toolbox_cache_clean({ kind: "all", all: true, includeOutputs: true })
```

清理规则是表驱动的，每个任务类型有明确的「保留」和「删除」清单。

**`labels` 永远不碰**——那是唯一不可再生的数据，任何清理逻辑都跳过了它。

`maxAgeDays` 给值时只动够老的任务，**即使 `all: true` 也一样**
（之前 `all` 分支无视 `maxAgeDays` 直接整目录删，把「删 7 天前的」变成「全删」，已修）。

## 数据在哪

数据根目录跟着 DSH 的 `DSH_HOME` 走（默认 `%USERPROFILE%\.dsh`），所以装在自定义位置也不会指错。全部在：

```text
$DSH_HOME/xiyoungtools/
```

具体是：

```text
runs/      视频分析（报告、拼图）
clips/     截取出的片段
prosody/   韵律分析结果
labels/    标注池 labels.json
batches/   批量导入结果
```

可用环境变量改：

| 变量 | 默认 |
|---|---|
| `DSH_HOME` | `~/.dsh`（插件所有数据的根） |
| `XIYOUNG_WORK_ROOT` | `$DSH_HOME/xiyoungtools/runs` |
| `XIYOUNG_CLIP_ROOT` | `$DSH_HOME/xiyoungtools/clips` |
| `XIYOUNG_PROSODY_ROOT` | `$DSH_HOME/xiyoungtools/prosody` |
| `XIYOUNG_LABEL_ROOT` | `$DSH_HOME/xiyoungtools/labels` |
| `XIYOUNG_BATCH_ROOT` | `$DSH_HOME/xiyoungtools/batches` |
| `XIYOUNG_PYTHON` | DSH 自带 Python |
| `XIYOUNG_FFMPEG` | PATH 里的 ffmpeg |
| `XIYOUNG_MODEL` | `qwen3.5:4b` |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` |

---

## 韵律分析的技术细节

### 双路基频追踪

单用 `librosa.pyin` 有个实测的坑：某些录音整段返回 0 个有声帧，音频本身却完全正常。换任何音域参数都救不回来，但 `librosa.yin` 在同一文件上能给出合理结果。

所以两路都跑：pyin 为主，覆盖率低于 25% 时用 YIN 补齐空洞。

在 CASIA 语料上验证：修复前 1200 条里有 47 条检不出基频，修复后 0 条。

### 三层八度校正

1. **贴上限的失控段**：pyin 在噪声段会一路猜成接近 fmax 的值，按邻域偏低部分重建
2. **整段八度偏移**：中位超过 260 Hz 且降八度后落在合理人声区间的比例够高时，整体降回来
3. **孤立整倍跳变**：邻域中值一致性检查

### 精度

用已知频率正弦验证（16 kHz）：

| 输入 | 期望 | 实测 | 误差 |
|---|---|---|---|
| 纯音 | 220 Hz | 219.7 Hz | −0.1% |
| 纯音 | 120 Hz | 120.5 Hz | +0.4% |
| 两段 | 220→330 Hz | 219.7 / 331.1 Hz | 半音跨度 7.10（理论 7.02） |

---

## 已知限制

- **视觉模型 OCR 可能有错字**：4B 模型对中文画面的识别不完美，报告保留原始描述，关键帧建议人工核对
- **一次只跑一个同类任务**：视频分析、截取、韵律分析、批量导入各自独立排队
- **韵律分析只给数字**：不给“这句话是催还是试探”的判断，那需要标注样本
- **微颤需要多样本才有意义**：单条录音的抖动数字可能只是噪声

---

## 发布

- npm：https://www.npmjs.com/package/dsh-auris-oculi
- GitHub：https://github.com/xiyoungplus/dsh-auris-oculi

## 参与

这个插件的数字都是实测出来的，所以**报「数字不对」比报 bug 更有用**。

- 发现问题 → 开 issue（`.github/ISSUE_TEMPLATE/` 里有模板）
- 想改代码 → 先看 `CONTRIBUTING.md`
- **已知不会修的问题**（情绪识别、说话人分离精度）列在 `CONTRIBUTING.md` 里，
  请先确认不是这些

最需要的帮助不是加功能，是拿真实音频去试，然后说哪里的数字不对。

---

## 许可

MIT
