# 更新日志

按版本倒序。每条只写「做了什么」和「为什么值得记」，实验过程和推理细节不放在这里
（需要追溯的看 `docs/` 下的专题报告和 git 历史）。

---

## 0.21.0

**合并社区补丁 + 实现两项后续：smart 抽帧、全局并发闸门。**

补丁来自外部贡献者，针对「长视频重复下载」和「结果要自己解析」两个痛点。
原补丁基于 0.20.2 的发布包结构（`package/`），当前代码已到 0.20.5
且脚本在 `lib/`，所以手工移植而非 `git apply`。

### 一、跨任务下载缓存（补丁）

原来 `startJob` 每次用「时间戳+uuid」建新目录，`download_video` 只在
**同一个 outDir** 里复用 `video.mp4`。所以「先看 40–52 分钟，再看 60–70 分钟」
会把整条视频下两遍；116 分钟的片子一次几百 MB。

现在按「视频 id + 短边 + 时间段」缓存到 `$DSH_HOME/xiyoungtools/cache/video`，
命中就**硬链接**（同盘零拷贝）到本次 run 目录，跨盘回退 `copy2`。

### 二、只下载需要的那一段（补丁）

`start/end/duration` 原来只影响抽帧，下载仍是整条。现在追加
`--download-sections --force-keyframes-at-cuts --downloader ffmpeg`。

**失败自动退回整条**（有些站点/格式走不了 ffmpeg 下载器），可用
`--no-section-download` 显式关闭。

### 三、逐格结果直接返回（补丁）

`analysis.json` 里已有逐格结构化结果，但工具只返回 `reportPath`，
agent 要自己读文件、解析 Markdown 找时间点。

现在 python 额外落一份 `entries.json`（按时间排序的扁平表），
`video_summary` / `toolbox_job` 直接返回前 80 条 + `entriesTotal` /
`entriesPath`。旧 run 目录没有 `entries.json` 时从 `analysis.json` 现推。

### 四、`density: "smart"`（补丁列出的后续 1）

按画面变化抽帧，替代固定 `interval`。

**为什么要补帧**：纯 scene 检测在静态视频（访谈、板书）上抽不到帧。
所以先按 scene 阈值抽变化点，不足时补足到固定间隔应有的数量。

实测（60 秒片段，固定间隔 5 秒应该抽 12 帧）：

| 模式 | 帧数 |
|---|---|
| 固定间隔 | 13 |
| **smart（阈值 0.30）** | **20** |
| smart（阈值 0.50） | 12（触发保底补帧） |

阈值可调 `video.sceneThreshold`（默认 0.30），或工具参数 `sceneThreshold`。

### 五、全局并发闸门（补丁列出的后续 2）

原来每个任务独立 spawn python、各自开 ThreadPoolExecutor，
**N 个任务 × M 并发 = N×M 个请求同时打 Ollama**，显存直接爆。

现在用**跨进程锁文件**做闸门（`$DSH_HOME/xiyoungtools/locks/slot-N`），
限制同时进入模型调用的 worker 数。配置项 `model.maxConcurrency`（默认 1，0 = 不限制）。

**为什么用文件锁而不是内存信号量**：内存信号量只管本进程，跨进程无效。
**为什么不用 fcntl**：Windows 上不可用。`O_CREAT|O_EXCL` 更可移植。

实测：6 个进程、上限 2，峰值并发严格 = 2，分成 3 波，平均等待 1.61 秒。

**兜底**：拿不到槽位时等 180 秒后**照常放行**（记一行日志）。
卡死比慢一点更糟，限制是优化不是正确性要求。
僵尸槽位（进程崩溃没删）超过 10 分钟自动清理。

### 修复补丁里的两个 bug

**bug 1：`target != video` 时的 glob 路径错了**

```python
# 补丁原样：glob 的是 outdir，但 target 指向 cache_dir
hits = sorted(glob.glob(os.path.join(outdir, "video.*")))
```

yt-dlp 若给文件加了后缀（`video.mkv`），在 outdir 里找不到，
会误报「下载完成但找不到 video 文件」。改成按 `target` 所在目录 + 同 stem 查找。

**bug 2：`write_entries` 定义了但没调用**

补丁的 python 侧加了函数，但主流程里没有调用点，`entries.json` 不会生成。
已补在 `analyze_sheets` 之后。

### 新增配置项（41 → 43）

| 配置项 | 默认 | 作用 |
|---|---|---|
| `video.sceneThreshold` | 0.30 | smart 模式的画面变化阈值 |
| `model.maxConcurrency` | 1 | 全局同时打模型的请求数上限 |

### 验证

| 项 | 结果 |
|---|---|
| 缓存键唯一性 | 整条 / 分段 / 不同短边 各自区分 |
| 硬链接 | inode 相同，同盘零拷贝 |
| `write_entries` 归一化 | 「无」「None」→ 空串，`ok=False` 的跳过 |
| smart 抽帧 | 60 秒片段：固定 13 帧 vs smart 20 帧 |
| 全局闸门 | 6 进程上限 2，峰值严格 = 2 |
| 端到端 | 真实视频跑通：16 帧 / 4 拼图 / 16 条 entries |
| 配置审计 | 43 个配置项全部有通路，无死键 |
| 其余测试 | host / smoke / regression / check_after_restart 全过 |

---

## 0.20.5

**Python 脚本移进 lib/，根目录从 18 个文件收到 12 个。**

`	ext
<插件根>/
├── index.js  client.js        两个主文件
├── package.json  cordis.patch.yml  icon.svg
├── README.md  README.en.md  CHANGELOG.md  CONTRIBUTING.md  LICENSE
├── lib/       8 个运行时 Python 脚本
├── scripts/   测试和辅助脚本
├── docs/      9 份文档
├── locale/  models/  testdata/
`

**改了两处引用**：

1. index.js 的 8 处 
ew URL('./xxx.py') → 
ew URL('./lib/xxx.py')
2. 6 个脚本的 sys.path 各加一行 ROOT

**移动时踩到的两个坑**：

**坑 1：prosody.py 的模型查找静默失效**

它原来用 here = dirname(__file__) 找 here/models/。
移到 lib/ 后变成找 lib/models/（不存在），于是 **CAM++ 模型找不到、
静默退回 Resemblyzer，不报任何错**。

修法：显式算出 
oot = dirname(here)，用 
oot/models/。

这个坑很难发现——功能还是能用，只是精度悄悄降了。

**坑 2：scripts/ 里的脚本 import 不到已迁移的模块**

它们把 ROOT 加进了 sys.path，但 prosody.py 现在在 lib/。
修法：LIB = join(ROOT, lib) 也加进去。

**验证**：端到端检查 8/8 路径正确、8 个脚本能独立启动、
7 个脚本能 import prosody、CAM++ 模型能找到，并真跑了一次分析
（33 个特征、转写中文完好）。

---

## 0.20.4

**文档拆分与目录整理。功能无变化。**

README 涨到 964 行，新来的想知道「这是什么」要先滑过 200 行依赖说明。
拆成按需阅读的结构：

| 原来（都在 README） | 现在 |
|---|---|
| 依赖 194 行 | docs/INSTALL.md |
| 页面 222 行 | docs/UI.md |
| 会话工具 291 行 | docs/TOOLS.md |
| 配置 73 行 | docs/CONFIG.md |

README 从 964 行降到 182 行，只留概览和导航。

**目录整理**：

- INSTALL.md / HANDOVER.md 移进 docs/
- emotion-data-findings.md 改名 emotion-findings.md
- 测试/辅助脚本移进 scripts/
- 删掉 dist/（0.10.1 的旧包）和 __pycache__/

**移动文件踩的坑**：两个脚本移到 scripts/ 后 import 全挂了——
它们原来靠 HERE = dirname(__file__) 找 prosody.py 和 	estdata/，
移动后这两个都在上一级。修法是加 ROOT = dirname(HERE) 到 sys.path。

**教训**：移动文件后必须重跑测试。
egression_content_class.py 和
check_after_restart.py 都是这么发现的（移动前正常，移动后 5/6 项失效）。

---

## 0.20.3

**改名为 `dsh-auris-oculi`，补开源相关文件和许可证。**

原名 `xiyoungtools` 不好搜、也不说明用途。新名字来自拉丁语
auris（耳）+ oculi（眼）—— 给 agent 装上耳朵和眼睛。

**已改**：npm 包名、DSH 插件 id、界面显示名、文档标题。

**故意没改**（兼容性，详见 `docs/HANDOVER.md` 的「改名的兼容性决定」）：

- 数据目录 `~/.dsh/xiyoungtools/`（里面有 1212 条不可再生标注）
- 路由前缀 `/xiyoungtools/*`（前端 48 处引用）
- 环境变量 `XIYOUNG_*`（用户 config.json 在用）

**许可证**：LICENSE 从 MIT 改为 **GPL-3.0**。`package.json` 的 license
字段、两份 README 的许可章节同步更新。

**新增**：

- `CONTRIBUTING.md`：怎么跑测试、哪些已知问题不用报、三条不能碰的硬编码规则
- `.github/ISSUE_TEMPLATE/`：bug 报告 + 「数字不对」专用模板
- `.gitignore` / `.npmignore`
- `scripts/check_after_restart.py`：重启后自检（编码修复是否生效、后端是否可用）

---

## 0.20.2

修掉工具回执中文乱码。

**根因**：`runProcess()` 里的 `spawn()` 没传 `env`，Python 拿不到 `PYTHONIOENCODING=utf-8`，
在 Windows 上按 GBK 输出，Node 用 UTF-8 解码就成了 `�ܿ�����ͬһ����`。

表现是「数字能读、文字全废」，因为 ASCII 在两种编码里字节相同。

**为什么只有这个工具**：其他任务都走 `spawn(PYTHON, args, { env: pythonEnv() })`，
只有 `speaker_compare` 用的 `runProcess` 漏了。

**防复发**：新增 5 条测试断言，检查源码里所有 `spawn` 都带 `env`。

---

## 0.20.1

说话人可靠性实测，纠正两组之前算错的数字。

**修正 1**：早期用「区间均匀插值」算错误率，得出 CAM++ 30.9% / Resemblyzer 37.8%。
真实分数有长尾，均匀假设会低估。改用真实配对逐个阈值统计后：

| 后端 | 错误率 | EER |
|---|---|---|
| CAM++ | **6.4%** | 8.3% |
| Resemblyzer | 19.5% | 20.9% |

**修正 2**：早期「同人配对」用同一段音频切两半，内容几乎相同，分数虚高。
改成同一说话人来自不同录音的拼接才公允。

**新发现**：音频长度是决定因素。同一段录音切两半算同人相似度（CAM++）：

```text
1 秒 0.58   2 秒 0.56   4 秒 0.71   8 秒 0.88   12 秒 0.89
```

**8 秒是拐点**。已写进 `caveats`：1~3 秒会提示「判成不像时先别信」。

**顺带修**：`speaker_verdict()` 的阈值原来写死一套（0.70/0.65/0.55），
对 CAM++ 完全错误。现在按后端分开。

完整数据见 `docs/speaker-reliability.md`。

---

## 0.20.0

说话人嵌入支持多后端。

| 后端 | 维度 | 安装 | 异人基准 | 同人/异人 |
|---|---|---|---|---|
| `resemblyzer` | 256 | pip 装即可 | 0.52 | 1.44 |
| `campplus` | 192 | 需 .onnx（27 MB） | **0.26** | **2.02** |

CAM++ 的价值不在「同人更像」，而在**异人基准低**——
Resemblyzer 的各向异性把所有声音挤在一个锥角里，判断「不像」时很不可靠。

**三种模式**：`auto`（默认，有 CAM++ 就用）/ `campplus`（强制，缺模型报错）/ `resemblyzer`。

**三个入口**都能控制：配置文件 `speaker.backend`、界面「嵌入模型」下拉、工具参数 `backend`。

**⚠️ 两个后端的余弦坐标系完全不同**，不能混用阈值。campplus 异人通常 0.1~0.4，
resemblyzer 能到 0.5+。拿旧的 0.70 去看 CAM++ 会把同人全判成不像。

---

## 0.19.0

按用户逐项评估收尾。

- **删** `prosodyLabelsTool`（51 行死代码，0.18.0 漏掉的）
- **补** 4 个字段进 `prosody_label({action:'list'})`：`total` / `tally` / `datasets` / `file`
- **修** `count` 语义（现在是命中数，不受 limit 截断）
- **修** dataset 筛选统一走 `filterByDataset()`（原来和路由各写一份，处理不一致）
- **修** render 自己数 `labels` 算 tally 的错（labels 被 limit 截断）
- **改** `speaker_diarize` 加可信度判断

**关于 diarize**：用户实测真实 2 人对话被判成 1 人、单人录音被判成 2 人。
根因是 Resemblyzer 嵌入在短句上区分力不足（实测同人 0.79 / 异人 0.75，只差 0.04）。

现在返回 `minCohesion` / `contrast` / `pairSpan` / `caveats`，不可信时明确说
「这可能是分不出来，而不是真的只有一个人」。

---

## 0.18.0

减法：删 388 行死代码，功能零变化。

**删 7 个 `*_status` 工具对象**（378 行）。这些从 0.11.0 起就是「文档说删了、注册表里没有、
代码还在」——三处不一致持续了 7 个版本。

**删** `_intensity_note`（只定义未调用的 10 行）。

**审计发现但保留的**：

- `cluster_speakers`：`prosody.py` 里「只出现 1 次」，但被 `speaker_cluster.py:142`
  以 `P.cluster_speakers` 调用。正则查不出跨文件调用。
- 9 条 HTTP 路由：前端不 fetch，但 `/sheet` `/file` 是给用户点开文件用的。

**教训**：「全文只出现 1 次」不能直接判死刑，要先查跨文件引用和非 fetch 的访问。

---

## 0.17.0

补齐音强包络和语速，把「测量」这一层做完整。

**音强包络**：`dbRange` / `dbStd` / `dbSwing`（慢变化）/ `dbJitter`（快变化）

**语速**：`charsPerSec` / `speechDensity` / `segmentCount` / `avgSegmentSec`（需转写）

**实测**：真实说话 7 类情绪分类，5 维韵律 18.6% → 加频谱 25.7% → **加包络 34.3%**
（随机 14.3%）。音强包络贡献最大（+8.6 个百分点）。

但**边际/散布始终 0.06~0.08 没有改善**——各类在特征空间里始终挤在一起。
所以：能做「测量」，不能做「判断」。

---

## 0.16.0

新增四维频谱特征，并纠正一条被误解很久的结论。

**新增**：`spectralCentroid`（音色亮度）/ `spectralRolloff`（高频边界）/
`spectralFlatness`（噪声性，取 log10）/ `hnrMedian` + `hnrP10`（谐噪比）

**没有用共振峰 F1/F2**——代码里 `extract_formants` 的注释已记录：1~3 秒短句上
LPC 求根不稳定（同一人 F1 从 349 跳到 1736），实测失败，不重复踩。

**纠正**：交接书说「情绪识别失败（13.9%）」，但那是**让 LLM 用语言判断**的结果。
用 9 维韵律做 1-NN 分类，CASIA 上有 40.4%（随机 16.7%）。
不是「情绪分不开」，是「不该让 LLM 判断」。

**实测**：CNEV 上 5 维韵律 66.5% → 合并 10 维 71.1%，多轮抽样 +3.3 个百分点。
幅度不大但真实。

完整数据见 `docs/docs/emotion-findings.md`。

---

## 0.15.0

新增「非言语人声」识别（`nonverbal`）。

`detect_non_speech` 只回答「是不是人声」，于是打哈欠、磨牙、牙齿打颤全被判成「正常说话」。
它们确实是人的声音，但没有任何语言内容。

**判据取双端**：正常说话音域 8~15 半音，非言语要么极窄（磨牙 1.9）要么极宽（打哈欠 23.1）。
所以是 `音域 > 18` 或 `音域 < 3 且 f0 贴下限`。

**三重信号缺一不可**，加了两条踩坑得来的：

1. 音域判据
2. **有转写文字则排除**（两条真实中文朗读音域 26.7，形状和打哈欠几乎一样，区别只在有文字）
3. **转写必须真的跑过**（`transcriptStatus=None` 是「没跑」，`empty`/`punct` 才是「跑过没出字」）

**实测**：SLR99 670 条 15 类，未判成说话 76.1%。机械音接近 100%（磨牙/弹舌/咂嘴/打哈欠），
哭 25%、尖叫 17%——它们和说话共用发声机制，抓不住。

**75 条真实语料回归：nonverbal = 0，零误判。**

---

## 0.14.0

新增 `speaker_compare`（声纹比对）和「声音笔记」的嵌入存档。

**`speaker_compare`** 是同步工具（不进队列），比两段音频是不是同一个人。

同时给三个数：`raw`（原始余弦）/ `centered`（去中心化）/ `rankPercentile`（本批排位）。

**为什么给三个**：Resemblyzer 嵌入有各向异性，所有向量挤在同一锥角里（投影长度 0.604~0.926）。
后果是原始余弦系统性虚高——实测 1176 个配对里 29.4% 被判成「同一人」，
去中心化后降到 5.5%。f0 78 vs 138 的两条不同声音，raw 给 0.918。

**声音笔记**：`prosody_label` 改为 note-first，存嵌入向量，可用 `label-find-similar`
在笔记池里找最像的几条。

---

## 0.13.0

标注功能改造：从「攒情绪训练样本」变成「记声音观察」。

原来叫「语气标注」，定位是给情绪分类攒训练集。但那条路已被证伪（见 0.12.1）。
现在改为**声音笔记**：记一条观察（「7.76 秒里断了 9 次」），可选短标签（「哭腔」）。

理由：「断几次」「自相关多少 Hz」这类观察是可靠的，值得记下来回看；
「这是什么情绪」不可靠，不该假装能标。

---

## 0.12.1

修正 `cosine_similarity()` 对 numpy 数组的处理。

`if not a` 对 numpy 数组会抛 `ValueError: truth value of an array is ambiguous`。
现有代码一直传 list 所以没暴露，加 CAM++ 后端时才踩到。改用 `len()` 判长度。

---

## 0.12.0

抽帧密度可自定义，配置项全面对齐。

**新增三个旋钮**：`minInterval`（密度下限）/ `density`（budget 或 max）/ `perRow`（拼图每行几格）。

**修**：`video.*` 六个配置项之前没注入 `pythonEnv()`，配置完全不生效。
`interval` 原来被夹在 >=1 秒，短视频怎么调都是 1 秒/帧。

**新增 `scripts/audit-config.mjs`**：交叉检查 39 个配置项 × 72 个工具参数 × 环境变量注入，
确保每个配置项都有明确通路。这条测试后来抓到过多次「加了配置但没接上」。

---

## 0.11.1

视频分析精度提升（用户要求「牺牲速度换精度」）。

**竖屏自适应**：拼图单格宽高比跟随首帧（夹在 0.5~2.2），不再把竖屏压成方块。

**1080p 下载**：`probe_best_format()` 用 `-j` 元数据按像素降序选，拿精确的 `format_id`。
之前的 `bv*[height<=1080]+ba` 会选到 480（B站 1080P60 需要会员）。

**OCR 精度**：`sheetWidth` / `frameWidth` 从 640/800 提到 1000，单格从 101×180 提到 500×889。

对比图在 `docs/precision-compare/`。

---

## 0.11.0

- 统一 `pumpLog()`，替换 8 处重复的日志泵
- 清理规则改为表驱动（`CLEAN_KEEP` / `CLEAN_ROOTS`），覆盖 8 个根目录
- **修** `maxAgeDays` 在 `all:true` 时被忽略导致误删全部
- 背景音时间轴（人声/背景/交织分段）
- 回执瘦身：曲线默认不带（3 MB 回执对模型没用）

---

## 0.10.2

`health` 端点从 3196 ms 降到 107 ms（`probeResemblyzer()` 缓存），并在页面挂载时调用。

修 `video_summary: 目前只支持 null`——`DEFAULT_MODEL` 是 `null`，守卫条件永远为真。

---

## 0.10.x 及更早

初始化阶段：视频逐帧观看、截取、韵律分析、说话人聚类/分离、特征评测、缓存清理。
细节见 git 历史。
