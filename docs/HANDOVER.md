# Auris Oculi 感知工具箱 · 项目交接书

> 交接日期：2026-11-26
> 当前版本：**0.20.2**
> 上一位负责人：lead（AI agent）
> 交接目的：文档整理、可靠性验证、准备上线

---

## 〇、先读这一段

**这是一个「测量声音」的工具，不是「判断情绪」的工具。**

核心的 27 个数字（基频、音域、微颤、频谱、包络、语速）都是可验证、可复现的。
但「这段是什么情绪」做不到——真实说话的 7 类情绪分类只有 34.3%，随机是 14.3%。

这不是技术不够，是信噪比到头了。详见「四、已知的失败结论」。

**接手前必须知道的三件事**：

1. `labels/labels.json` 是唯一不可再生的数据（1212 条），任何清理都跳过它
2. 改 `index.js` 需要重启 DSH；改 `.py` 不用（每次 spawn 新进程）
3. 两个说话人后端（resemblyzer / campplus）的余弦坐标系不同，阈值必须分开

---

## 〇之二、0.11.0 → 0.20.2 做了什么

`0.10.2` 是上一位交接时的版本。之后 10 个版本的主要变化：

### 0.11.0–0.12.1 · 基建

- 统一 `pumpLog()`，替换 8 处重复的日志泵
- 清理规则改为表驱动，覆盖 8 个根目录
- **修** `maxAgeDays` 在 `all:true` 时被忽略导致的误删
- 背景音时间轴（人声/背景/交织分段）
- 视频精度提升：竖屏自适应、1080p 下载、OCR 宽度 640→1000
- 抽帧密度三旋钮（`minInterval` / `density` / `perRow`）
- **新增 `scripts/audit-config.mjs`**：交叉检查 41 个配置项 × 工具参数 × 环境变量

### 0.13.0–0.15.0 · 重新定位

- 「语气标注」改为「声音笔记」——不再假装能标情绪，改记可验证的观察
- 新增 `speaker_compare`（声纹比对，同步工具）
- 新增 `nonverbal` 内容类型（打哈欠/磨牙/牙齿打颤这类「是人声但不是说话」）

### 0.16.0–0.17.0 · 补特征

新增 9 个特征：四维频谱（质心/滚降/平坦度/HNR）+ 音强包络（4 维）+ 语速（4 维）。

**关键发现**：情绪分类从 5 维韵律的 18.6% 提到 14 维的 34.3%（随机 14.3%），
但「边际/散布」始终 0.06~0.08——各类始终挤在一起。所以能测量、不能判断。

### 0.18.0–0.19.0 · 减法

- 删掉 7 个 `*_status` 工具对象（378 行死代码，存在了 7 个版本）
- 删掉 `prosodyLabelsTool`（51 行，0.18.0 刚漏掉的）
- 补回 `prosody_label` 的 4 个字段（`total`/`tally`/`datasets`/`file`）
- `speaker_diarize` 加可信度判断

### 0.20.x · 多后端 + 可靠性

- 说话人嵌入支持 CAM++（错误率 6.4% vs Resemblyzer 19.5%）
- 实测音频长度是决定因素：**8 秒是同人识别的拐点**
- **修** 工具回执中文乱码（`runProcess` 的 spawn 没传 `env`，Python 按 GBK 输出）

---

## 〇之三、验证清单

接手时先跑这四条，全绿再动代码：

```bash
node scripts/test-host.mjs      # 64 条断言：路由/配置/清理/labels 保护/编码/多后端
node scripts/smoke.mjs          # client.js 真渲染
node scripts/audit-config.mjs   # 41 个配置项都有通路
python scripts/regression_content_class.py   # nonverbal 分类未退化
```

`test-host.mjs` 用临时目录 + `DSH_HOME` 隔离，**不碰真实数据**。

**打包前**：`node --check index.js && node --check client.js`，然后确认
`package.json` 的 `files` 里每个路径都存在（`testdata/` 故意不在里面）。

---

## 一、这个项目是什么

一个 DSH（DeepSeek Harness）插件，给会话提供**本机音视频分析工具**，并在左侧栏提供一个网页面板。

原始目标（用户原话）：

> 「让模型能听到，分清不同人，分清哪些是背景音，分清人说话的真正意思（情绪也就是为了这一步），不要陷入死胡同」

**这四个目标目前的实际状态**（务必先看这个，别被工具数量误导）：

| 目标 | 状态 | 说明 |
|---|---|---|
| 让模型能听到 | ✅ 完成 | 转写质量可用，8 秒块长最优 |
| 分清不同人 | ✅ 完成 | Resemblyzer 256 维嵌入，本人 0.72–0.78，陌生人 0.45–0.58 |
| 分清背景音 | ⚠️ 部分 | **能识别但无法分离**。能判断"这段不是人声"，不能把背景音单独抽出来 |
| 听懂真正意思（情绪） | ❌ **失败** | 试了三次都失败，见「四、已知的失败结论」 |

**接手后第一件事：不要试图重做情绪识别。** 已经证明这条路在 qwen3.5:4b 上走不通。

---

## 二、代码在哪、怎么跑

### 工作副本（改代码在这里）

```text
<插件目录>\
```

### 用户数据（不要手动改）

```text
%USERPROFILE%\.dsh\xiyoungtools\
├── config.json      用户配置（可删，删了回默认）
├── runs\            视频分析任务
├── clips\           截取任务
├── prosody\         韵律分析
├── labels\          语气标注样本（**唯一不可再生数据**）
├── batches\
├── clusters\
├── diarize\
├── bench\
└── analyze\         一站式分析
```

⚠️ `labels\labels.json` 是用户长期手工标注的样本，**不可再生**。打包时会被包含，任何清理逻辑都跳过了它。

### 文件结构

| 文件 | 行数 | 作用 |
|---|---|---|
| `index.js` | 6544 | **Host 半**：12 个工具 + 44 条路由 + 配置系统 + 任务调度 |
| `client.js` | 2872 | **浏览器半**：手写，无构建步骤，无 JSX，用 `h()` |
| `prosody.py` | 3082 | 韵律 + 频谱 + 包络 + 语速 + 转写 + 变化点 + 多后端嵌入 |
| `video_watch.py` | 1280 | 视频抽帧 + 拼图 + 视觉模型 + 模型后端抽象 |
| `speaker_diarize.py` | 429 | 单文件分离（含可信度判断） |
| `batch_import.py` | 354 | 批量导入 + 标签推断 |
| `benchmark.py` | 300 | 特征判别力评测 |
| `speaker_compare.py` | 278 | 两条音频比对（同步工具） |
| `speaker_cluster.py` | 191 | 批量聚类 |
| `list_models.py` | 31 | 扫描模型后端 |
| `cordis.patch.yml` | 5 | DSH 插件挂载声明 |
| `scripts/test-host.mjs` | — | Host 半单测（64 条断言，隔离目录） |
| `scripts/smoke.mjs` | — | client.js 真渲染冒烟 |
| `scripts/audit-config.mjs` | — | 41 个配置项 × 工具参数 × 环境变量交叉检查 |
| `scripts/regression_content_class.py` | — | nonverbal 分类回归（需 testdata/） |
| `scripts/check_after_restart.py` | — | 重启后自检（编码修复是否生效） |

**剩下的 8 个 `.py` 是核心脚本，被 `index.js` 的 spawn 调用，不能移。**
测试和辅助脚本都在 `scripts/` 下——它们需要 `ROOT` 在 `sys.path` 里才能 import `prosody`。

### 关键机制

**Host 半**（`index.js`）：
- 通过 `ctx.tools.register()` 注册工具
- 通过 `ctx.webServer.register()` 注册 HTTP 路由
- 用 `spawn` 起 python 子进程跑分析
- 任务存内存 Map + 磁盘 `job.json`

**浏览器半**（`client.js`）：
- 用 `window.__ModuleLoader__.load({ id, factory })`
- `factory` 里 `require('react')` 拿 `createElement` 等
- 注册 `main`（主页）+ `sidebar.panellist`（侧栏图标）两个 slot

**Python 半**：
- 不直接读 `config.json`，只认环境变量
- Host 用 `pythonEnv()` 把配置注入成 `XIYOUNG_*` 环境变量

---

## 三、当前交付状态（0.20.2）

### 工具（12 个）

| 工具 | 作用 | 可靠性 |
|---|---|---|
| `toolbox_analyze` | **一站式**：视频/音频，画面+声音同时 | 好 |
| `video_summary` | B 站视频逐帧观看 | 好（OCR 有错字） |
| `media_clip` | 片段截取 | 好 |
| `prosody_analyze` | 27 个客观数字 + 转写 + 变化点 + 说话人 | 好（数字） |
| `prosody_label` | 声音笔记 | 好 |
| `prosody_batch` | 批量导入 | 好 |
| `speaker_compare` | 两条音频像不像同一个人 | **好**（4 秒以上） |
| `speaker_cluster` | 说话人聚类 | ⚠️ 粗分组 |
| `speaker_diarize` | 说话人分离 | ⚠️ 不可靠，必看 caveats |
| `toolbox_benchmark` | 特征判别力评测 | 好 |
| `toolbox_job` | **统一查任务** | 好 |
| `toolbox_cache_clean` | 缓存清理 | 好 |

`_status` 工具已全部合并进 `toolbox_job({ id })`，按 id 自动判断类型。

### 路由（44 条，都在 `/xiyoungtools/` 下）

配置类：`models` `config` `health`
视频：`video-watch` `cancel` `job` `jobs` `report` `sheet` `file`
截取：`clip` `clips` `clip-cancel` `clip-file` `clip-preview`
韵律：`prosody` `prosodies` `prosody-curves` `prosody-cancel` `labels` `label-delete` `prosody-audio`
缓存：`cache` `cache-clean`
批量：`batch` `batches` `batch-result` `batch-import` `batch-cancel` `batch-report`
聚类：`cluster` `clusters` `cluster-result`
分离：`diarize` `diarizes` `diarize-result`
一站式：`analyze` `analyze-result` `analyzes`
评测：`bench` `bench-result`
笔记：`label-from-prosody` `label-find-similar` `speaker-compare`

### 界面（3 个主 tab + 5 个音频子标签）

```text
分析         ← 统一入口：B 站链接 / 本地文件，自动分流
截取与韵律    ← 子标签：截取 | 韵律与转写 | 声纹 | 批量分析 | 笔记
配置         ← 预设 + 逐项调整 + 缓存清理
```

### 配置系统

三层优先级：`工具参数 > 环境变量 > config.json > 预设 > 内置默认`

7 个分组：`model` `video` `audio` `speaker` `changes` `limits` `ui`
**41 个配置项**，每个都有明确通路（`scripts/audit-config.mjs` 会检查）
4 个预设：`low` `balanced` `high` `cpu`

### 说话人嵌入后端（0.20.0 新增）

| 后端 | 维度 | 安装 | 异人基准 | 错误率 |
|---|---|---|---|---|
| `resemblyzer` | 256 | pip 装即可 | 0.52 | 19.5% |
| `campplus` | 192 | 需 .onnx（27 MB） | **0.26** | **6.4%** |

配置项 `speaker.backend`：`auto`（默认）/ `campplus` / `resemblyzer`。
模型放 `models/` 或 `datasets/speaker-models/`，查找顺序见 `models/README.md`。

**⚠️ 两个后端的余弦坐标系完全不同，阈值必须分开**（代码里已按后端取值）。

### 模型后端

| provider | 协议 | 适用 |
|---|---|---|
| `ollama` | `/api/generate` | 本机或远程 Ollama |
| `openai` | `/v1/chat/completions` | LM Studio / vLLM / OneAPI / 云端 |

模型列表自动扫描，能识别"是否支持视觉"。

---

## 四、已知的失败结论（**别重复踩**）

这部分比功能列表重要。以下都是**实测结论**，不是猜测。

### ❌ 让 LLM 判断情绪：失败

- 三次实验，qwen3.5:4b 分类准确率 **13.9%**，随机基线 16.7%
- 置换检验显示 A=B=C **100% 相同** —— 模型根本没在看韵律

**根因**：模型缺少「韵律→语义」的映射能力。再调也调不出来。

### ⚠️ 但「情绪分不开」这个结论要修正

用声学特征做 1-NN 分类（不是让 LLM 判断），准确率完全不同：

| 做法 | 数据 | 准确率 | 随机 |
|---|---|---|---|
| qwen3.5:4b 判断 | CASIA | 13.9% | 16.7% |
| 9 维韵律 + 1-NN | CASIA | **40.4%** | 16.7% |
| 62 维 openSMILE | CNEV | **81.3%** | 22.8% |
| 插件 10 维 + 1-NN | CNEV（非言语发声）| 71.1% | 20.0% |

**但换成真实说话（有内容的句子），只有 34.3%**（随机 14.3%）。

原因是「边际/散布」始终 0.06~0.08——各类在特征空间里挤在一起。
非言语发声（啊——、哭喊）情绪在声学上极其显著，真实说话则被语言内容淹没。

**结论**：能做「测量」，不能做「判断」。详见 `docs/emotion-findings.md`。

### ⚠️ 说话人分离：不可靠，必须看 caveats

实测真实 2 人对话被判成 1 人、单人录音被判成 2 人。
根因不是聚类算法，是 Resemblyzer 嵌入区分力不足：
同人内部 0.79 / 不同人之间 0.75，只差 0.04。

现在返回 `minCohesion` / `contrast` / `pairSpan` / `caveats`，
不可信时明确说「这可能是分不出来，而不是真的只有一个人」。

### ⚠️ 音频长度对说话人嵌入是决定性的

同一段录音切两半算同人相似度（CAM++）：

```text
1 秒 0.58   2 秒 0.56   4 秒 0.71   8 秒 0.88   12 秒 0.89
```

**8 秒是拐点。** 4 秒以下判成「不像」时不可信，`caveats` 会提示。
详见 `docs/speaker-reliability.md`。

### ⚠️ 并发：本机不可靠，但做成了可选项

`video.concurrency` 可以调，但实测本机（模型只能部分进显存）并发反而更慢。

### ⚠️ 降分辨率：不可靠

视频降到 480 分辨率时 OCR 大面积失效，`video.height` 默认已提到 1080。

### ⚠️ MFCC：跨录音设备不可比

同一批录音内 MFCC 分标签 82.8%，跨来源时阈值怎么调都会错。

### ⚠️ OCR 不稳定

4B 视觉模型对中文画面识别不完美，同一处文字可能有多种读法。关键帧要人工核对。

### ⚠️ 转写质量随静音比例变化

静音多的录音，SenseVoice 容易把噪声转成无意义字符。
`transcriptStatus` 区分「跑过没出字」和「没跑」，别混为一谈。

---

## 五、接手后的优先事项

### P0 · 上线前必须做

**1. 跨平台验证**

当前只在 **Windows + 特定路径** 验证过。需要确认的点：

- `index.js` 的 `findCommand` 里有 `C:\ProgramData` 这类硬编码候选路径，macOS/Linux 的退化逻辑没测过
- `pythonEnv()` 的 `PYTHONIOENCODING` 在 Linux 上应该无害，但没实测
- 端口分配在非 Windows 系统上是否同样随机

**2. 依赖安装引导**

依赖重且有几个坑，现在只能靠用户自己踩：

| 坑 | 表现 | 正确做法 |
|---|---|---|
| `webrtcvad` | Python 3.12 编译失败 | 改用 `webrtcvad-wheels` |
| `sherpa_onnx` | 装了但没模型 | 另需下载 SenseVoice / CAM++ 模型 |
| `resemblyzer` | 首次运行卡住 | 会下载 voice encoder（约 200 MB） |

**建议写一个 `check_env.py`**：逐项检查并给出可直接复制的修复命令。
这是目前最影响「装得上但跑不起来」体验的一环。

### P1 · 强烈建议

**3. 错误信息可操作性**

现在大部分错误是「做了什么失败了」，但不太说「该怎么办」。
例如「没有生成 prosody.json」应该说清是 ffmpeg 失败、还是模型缺失、还是磁盘满。

**4. 声纹比对的跨设备验证**

目前只在「同一支录音、同一环境」上验证过（用户实测 4/4 判对，同人 0.82~0.89、
异人 −0.01，灰色地带是空的）。**换麦克风、换嘈杂环境还没验。**

这是 `speaker_compare` 唯一未证明的维度，也是最可能在实际使用中出问题的地方。

### P2 · 可选

- 音频页「批量分析」和「笔记」还能再合并
- `README.en.md` 落后很多版本，要么同步要么删掉
- `docs/DETAIL.md` 部分内容和 README 重复，可以合并

### 已完成（不用再做）

- ~~补自动化测试~~ → `test-host.mjs`（64 条断言）+ `smoke.mjs` + `audit-config.mjs`
- ~~把已知不可靠的地方加进回执~~ → `caveats` 字段已覆盖各个工具
- ~~`changes` 阈值暴露到 UI~~ → 已在配置面板

---

## 改名的兼容性决定

插件原名 `xiyoungtools`，0.20.2 起改为 **`dsh-auris-oculi`**。

但有三类东西**故意没有跟着改**。这不是遗漏，是为了不破坏已有数据：

| 保留什么 | 现在还是 | 为什么不能改 |
|---|---|---|
| 数据目录 | `~/.dsh/xiyoungtools/` | 里面有 **1212 条不可再生标注**。改了路径，用户的 `labels.json` 就找不到了 |
| 路由前缀 | `/xiyoungtools/*` | `client.js` 有 48 处引用，`index.js` 有 45 处。改了要动 93 处，而且对用户没有任何好处 |
| 环境变量 | `XIYOUNG_*` | 用户 `config.json` 里存的是这些键名。改了配置全部失效 |

**已改的**（纯对外标识，不影响任何已有数据）：

- npm 包名：`xiyoungtools` → `dsh-auris-oculi`
- DSH 插件 id：`cordis.patch.yml` 里的 `id`
- 界面显示名：`Auris Oculi 感知工具箱`
- 所有文档标题

### 以后要改的注意事项

如果将来真要统一命名，必须**先做数据迁移**：

1. 读旧目录 `~/.dsh/xiyoungtools/`，把内容搬到新目录
2. 确认搬完再删旧目录
3. 环境变量要保留一段时间的双读（新键优先，旧键兜底）

**绝对不能只改路径不迁移** —— 那等于删了用户的数据。

---

## 六、开发注意事项（踩过的坑）

### 1. 删重复代码必须按范围删

全局字符串替换删 state 曾导致：

```js
// 这一行在 4 个组件里字面完全相同
const [busy, setBusy] = useState(false)
```

替换第一处删掉的是主页面那个，后面补删时又删掉子组件的，**导致音频页崩溃**。

**正确做法**：先算括号配平的行号范围，按范围删。

### 2. 插入声明不能只判断"文本里有没有"

`if ('audioTab' not in text)` 这种判断不可靠 —— **引用本身也算"有"**，会跳过声明。

**正确做法**：判断 `const [x, setX]` 这个模式在不在。

### 3. 静态正则检查 JS 不可靠

处理不了解构、箭头函数参数、模板字符串，误报率极高。

**正确做法**：写真实渲染测试（mock 环境 + 真跑一遍）。

### 4. DSH schema 有硬限制

`type: ['string','null']` **会被拒绝**，工具静默不注册。

**必须用**：`oneOf: [{ type: 'string' }, { type: 'null' }]`

这个坑让 4 个工具静默消失过一次。

### 5. 改 Host 要重启 DSH

- `index.js` / `client.js` / schema 改动 → **必须重启 DSH**
- `.py` 改动 → 每次运行重新加载，不用重启

### 6. PowerShell 中文 + 反引号 + Markdown 符号会破坏命令

含中文、反引号、`**` 的复杂命令容易炸。

**正确做法**：写成 `.py` 文件再调用，或直接用 `write`/`edit` 工具。

### 7. 打包前确认 `package.json` 的 `files`

漏一个文件就是运行时缺模块。当前 20 项全部存在（已验证）。

### 8. 测试桩的 bug 会冒充被测代码的 bug

0.10.2 写 `scripts/smoke.mjs` 时，第一版 React 替身用**全局 hook 游标**，父组件和子组件共享同一段槽位。结果报出一堆：

```text
组件 ClipCard 渲染崩溃: Cannot read properties of null (reading 'length')
组件 LabelCard 渲染崩溃: labels.slice(...).reverse is not a function
```

看着像 client.js 有三个真 bug，**其实是测试自己的状态管理错了**。改成按组件名隔离 hook 状态后全部通过。

**教训**：冒烟测试报错时，先怀疑测试桩。判断方法——去 client.js 看那行的实际上下文，如果代码明显没问题（比如 `(clip.log || []).length` 前面已经有 `|| []`），那多半是桩的问题。

### 9. `Measure-Object -Line` 会跳过空行

用它数行数，每个文件都比 `ReadAllLines` 少数十到几百行（空行越多差得越多）。核对交接书行数时踩过：一度以为 `prosody.py` 少了 520 行。

**正确做法**：`[System.IO.File]::ReadAllLines($path).Count`

### 10. PowerShell 5.1 读 UTF-8 会把中文读成乱码

`Get-Content -Raw | ConvertFrom-Json` 对 UTF-8 无 BOM 的中文文件会报
「传入的对象无效，应为":"或"}"」。**文件本身没坏**，是 PowerShell 按 ANSI 解码了。

**正确做法**：用 `node` 或 `python` 校验 JSON，别用 PowerShell 的 `ConvertFrom-Json`。

### 11. 改 Host 后不要靠「重启」验证唯一一次

`index.js` 的改动必须重启 DSH 才生效，但重启会打断当前会话。更稳的顺序：

1. 先跑 `node scripts/test-host.mjs`（进程外、隔离目录，直接打真实路由函数）
2. 确认通过后再重启，重启后手动打一次 `/xiyoungtools/health` 和 `video_summary`

只靠重启验证的话，一次失败就得再来一轮，很慢。

---

## 七、环境依赖

### Python（3.12.14）

| 模块 | 版本 | 用途 |
|---|---|---|
| numpy | 2.3.5 | 全部 |
| librosa | 1.0.1 | 韵律 |
| soundfile | 0.14.0 | 音频读写 |
| resemblyzer | — | 说话人嵌入 |
| sherpa_onnx | 2.0.2 | 语音转写 |
| Pillow | 12.3.0 | 拼图缩放 |
| scipy | 1.18.1 | 信号处理 |

### 外部程序

- **ffmpeg / ffprobe** — 必需
- **yt-dlp** — B 站下载必需
- **Ollama** 或 OpenAI 兼容服务 — 视觉模型必需

### 当前机器实测

```text
GPU: 4096 MiB 总显存，已用 2656 MiB
模型 qwen3.5:4b: 3.89 GB，只有 1.88 GB 进显存（48%）
→ CPU/GPU 混合推理，单张拼图 45–84 秒，抖动 1.9 倍
```

**这是当前性能瓶颈的根因，不是代码问题。**

---

## 八、下一步建议

如果只能做三件事：

1. **补自动化测试**（尤其 UI 渲染测试）—— 我这次差点交出去一个崩溃版本
2. **跨平台验证** —— 现在只在 Windows 上跑过
3. **依赖检查脚本** —— 新用户装不上是最可能的上线阻碍

如果还有余力：把已知限制写进回执，让调用方在拿到数据时就知道哪部分可信、哪部分不可信。

---

## 附：文档索引

| 文档 | 内容 |
|---|---|
| `README.md` | 功能说明 + 配置 + 接口（中文，最新） |
| `README.en.md` | 英文版（**落后，需更新**） |
| `INSTALL.md` | 安装步骤 |
| `CHANGELOG.md` | 30 个版本的完整记录，含所有失败实验 |
| `docs/DETAIL.md` | 实现细节 |

**CHANGELOG 里有大量失败结论，接手前值得通读** —— 能省掉重复试错。
