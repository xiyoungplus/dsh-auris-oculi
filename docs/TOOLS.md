# 工具手册

12 个会话工具，任何 DSH 会话都能直接调用。

时间类工具（除了 `speaker_compare`）都是「等结果」模式：超时没跑完会返回一个 id，
之后用 `toolbox_job({ id })` 查——它按 id 自动判断类型，不需要记该用哪个 status 工具。

> 想先知道「该用哪个」，看 [README](../README.md#十二个工具) 的总表。

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
真实说话 7 类情绪分类只有 34.3%（随机 14.3%）。详见 `docs/emotion-findings.md`。

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


---

## 相关

- 安装依赖 → [INSTALL.md](INSTALL.md)
- 页面上怎么操作 → [UI.md](UI.md)
- 算法细节 → [DETAIL.md](DETAIL.md)
