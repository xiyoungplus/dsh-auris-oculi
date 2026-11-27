# 安装指南

两件事：**在别的机器上装起来**，以及**发布到 npm**。

---

# 一、装到另一台机器

## 1.1 插件本身

两种装法。

### A. 从 npm（推荐）

```bash
npm install -g dsh-auris-oculi
```

然后在 DSH 的 Plugins 面板里启用。

### B. DSH 界面

DSH → **Plugins → Add plugin** → 选插件文件夹。

### C. 手动 link（开发用，改代码立刻生效）

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$src  = "你的插件目录绝对路径"   # 例: E:/code/dsh-auris-oculi

# 1) 加依赖 + 加进 bundles
$pkg = Get-Content "$prof\package.json" -Raw | ConvertFrom-Json
$pkg.dependencies | Add-Member -NotePropertyName "dsh-auris-oculi" -NotePropertyValue "link:$src" -Force
if ($pkg.dsh.profile.bundles -notcontains "dsh-auris-oculi") {
  $pkg.dsh.profile.bundles += "dsh-auris-oculi"
}
$pkg | ConvertTo-Json -Depth 20 | Set-Content "$prof\package.json" -Encoding utf8

# 2) 用运行时自带的 pnpm（别用全局 pnpm，版本可能对不上）
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\node_modules\pnpm\bin\pnpm.cjs"
node $pnpm install --dir $prof
```

> 为什么不能手动往 `node_modules` 里拷文件夹：pnpm 会把不在依赖树里的东西移到 `.ignored\`，重启就没了。

装完**重启 DSH**。

## 1.2 Python 依赖

分三档：**必装**（韵律分析）、**按功能**（转写/声纹）、**可选**（更强模型）。

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
```

### 必装（没有它韵律和批量导入都跑不了）

```powershell
& $py -m pip install librosa soundfile scipy numpy
```

约 100 MB（含 numba、llvmlite、scikit-learn）。

验证：

```powershell
& $py -c "import librosa, soundfile, scipy, numpy; print('ok', librosa.__version__)"
```

### 按功能装

| 功能 | 装什么 | 不装的后果 |
|---|---|---|
| 语音转写 | `sherpa-onnx` + SenseVoice 模型 | 没有 `transcript`，语速四维缺省 |
| 声纹（Resemblyzer） | `resemblyzer` `webrtcvad-wheels` | 三个 speaker_* 工具报「模型不可用」 |
| 声纹（CAM++，更准） | `sherpa-onnx` + `.onnx` 模型 | 只能退回 Resemblyzer |

```powershell
# 转写 + CAM++ 共用 sherpa-onnx
& $py -m pip install sherpa-onnx

# Resemblyzer 后端
& $py -m pip install resemblyzer webrtcvad-wheels
```

**⚠️ `webrtcvad` 在 Python 3.12 上编译失败，必须用 `webrtcvad-wheels`。**

**⚠️ `resemblyzer` 首次运行会下载 voice encoder（约 200 MB），看起来像卡住。**

### CAM++ 模型（可选，但值得）

比 Resemblyzer 准得多——异人基准 0.26 vs 0.52，错误率 6.4% vs 19.5%。

下载放到插件的 `models/` 目录：

```text
https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
```

约 27 MB。（URL 里 `recongition` 是官方拼错的，不是笔误）

查找顺序：配置 `speaker.modelPath` → `models/` → `datasets/speaker-models/`
→ `~/.dsh/xiyoungtools/speaker-models/`。详见 `models/README.md`。

### SenseVoice 模型（转写用）

`sherpa-onnx` 装好后还需要模型文件。没有的话转写会被跳过，
`transcriptStatus` 会是 `no_model`，韵律数字不受影响。

### 一次性装全

```powershell
& $py -m pip install librosa soundfile scipy numpy sherpa-onnx resemblyzer webrtcvad-wheels
```

### 验证

```powershell
# 基础
& $py -c "import librosa, soundfile, scipy, numpy; print('base ok')"
# 转写
& $py -c "import sherpa_onnx; print('sherpa', sherpa_onnx.__version__)"
# 声纹
& $py -c "from resemblyzer import VoiceEncoder; VoiceEncoder('cpu'); print('voice ok')"
```

## 1.2b 可选 Python 包

不是必须的，只有特定场景用得上：

| 包 | 用途 | 装法 |
|---|---|---|
| `openpyxl` | 见下 | `& $py -m pip install openpyxl` |
| `pyarrow` | 见下 | `& $py -m pip install pyarrow` |
| `Pillow` | 见下 | `& $py -m pip install Pillow` |

其中 `$py` 就是 1.2 里定义的那个：

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
```

本机实测：openpyxl 3.1.5 / pyarrow 26.0.1 / Pillow 12.3.0，都在。

## 1.3 外部程序

四项，都可以独立装。缺了不致命，对应功能会在页面底部显示为缺失。

### ffmpeg + ffprobe（必须有）

没有它所有音视频工具都用不了。

```powershell
# A. winget（Win10+ 自带）
winget install Gyan.FFmpeg

# B. Chocolatey（本机用的这个）
choco install ffmpeg

# C. 手动
#    https://www.gyan.dev/ffmpeg/builds/  下 release-essentials
#    解压后把 bin 目录加进 PATH
```

验证：

```powershell
ffmpeg -version      # 应输出 ffmpeg version 7.x 以上
ffprobe -version
```

**坑**：装完要重开终端 PATH 才刷新。不过插件会额外去
`C:\ProgramData\chocolatey\bin`、`C:\ffmpeg\bin` 等位置直接找，
所以 PATH 没刷新通常也能用。

本机实测：`C:\ProgramData\chocolatey\bin\ffmpeg.exe`，版本 9.0.2。

### yt-dlp（只有下载 B 站链接才需要）

本地文件路径不需要它。

```powershell
# A. 用 DSH 自带的 Python 装（推荐）
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py -m pip install -U yt-dlp

# B. 单独下 exe
#    https://github.com/yt-dlp/yt-dlp/releases  下 yt-dlp.exe
```

验证：

```powershell
& "$env:APPDATA\Python\Python315\Scripts\yt-dlp.exe" --version
```

> 版本号按你机器上的 Python 目录改，可能是 `Python312` / `Python313` 等。

**坑 1**：`pip install yt-dlp` 会装到 Python 的 Scripts 目录，**通常不在 PATH 里**。
插件会主动去 `%APPDATA%\Python\Python*\Scripts\` 找，所以不用手动加 PATH。

**坑 2**：`yt-dlp` 更新很频繁，B 站接口一变就下载失败。
遇到「下载失败」先跑 `yt-dlp -U` 升级，别急着怀疑插件。

本机实测：`%APPDATA%\Python\Python315\Scripts\yt-dlp.exe`，版本 2026.10.26，
**不在 PATH 里**，但插件能找到。

### Ollama（只有视频逐帧观看需要）

```powershell
# 1. 装
winget install Ollama.Ollama
#   或 https://ollama.com/download

# 2. 拉视觉模型（推荐 qwen3.5:4b，3.3 GB）
ollama pull qwen3.5:4b

# 3. 确认服务和模型都在
ollama list
```

**⚠️ 用 `qwen3.5:4b`，不要用 `qwen3-vl:4b`。** 后者在本机实测会返回空内容。

**可选：用远程或别的后端**。配置里改 `model.provider`：

| provider | 协议 | 适用 |
|---|---|---|
| `ollama` | `/api/generate` | 本机或远程 Ollama |
| `openai` | `/v1/chat/completions` | LM Studio / vLLM / OneAPI / 云端 |

`model.host` 填地址，`model.name` 填模型名。模型列表会自动扫描并标出是否支持视觉。

### Python 侧的 Pillow

`video_watch.py` 拼图需要 Pillow。装 librosa 时通常会带上，
如果单独报「No module named PIL」：

```powershell
& $py -m pip install Pillow
```

本机实测：Pillow 12.3.0（随 librosa 一起装的）。

### 一览表

| 程序 | 缺了会怎样 | 装法 | 验证 |
|---|---|---|---|
| ffmpeg + ffprobe | 全部音视频工具不可用 | `choco install ffmpeg` / `winget install Gyan.FFmpeg` | `ffmpeg -version` |
| yt-dlp | 只能处理本地文件 | `& $py -m pip install -U yt-dlp` | 看 Scripts 目录 |
| Ollama | 视频逐帧观看不可用 | `winget install Ollama.Ollama` | `ollama list` |
| qwen3.5:4b | 同上 | `ollama pull qwen3.5:4b` | `ollama list` |
| Pillow | 拼图失败 | `& $py -m pip install Pillow` | `& $py -c "import PIL"` |

## 1.4 带数据

全部在 `%USERPROFILE%\.dsh\xiyoungtools\`：

```text
runs/      视频分析（报告、拼图）
clips/     截取出的片段
prosody/   韵律分析结果
labels/    标注池 labels.json   ← 最值得带
batches/   批量导入结果
```

只想带标注池的话，拷一个文件就够：

```text
%USERPROFILE%\.dsh\xiyoungtools\labels\labels.json
```

## 1.5 验证装好了

重启后：

1. 左侧栏出现 **Auris Oculi 感知工具箱**
2. 页面底部显示 `Python: 已检测 · ffmpeg: OK · yt-dlp: OK · Ollama: 在线`
3. 新建会话，工具表里能看到 `video_summary`、`prosody_analyze` 等 11 个

---

# 二、发布到 npm

## 2.1 一次性准备

### 注册 / 登录

```bash
npm login
npm whoami        # 确认登录了
```

如果开了两步验证，用 `npm login --auth-type=web` 走浏览器。

### 检查包名没被占

```bash
npm view xiyoungtools version
```

如果返回 404，说明名字可用。如果被占了，改成 `@你的用户名/xiyoungtools`：

```json
{
  "name": "@xiyoung/xiyoungtools",
  "publishConfig": { "access": "public" }
}
```

> scoped 包默认是 private 的，必须显式写 `"access": "public"` 才能公开装。

### 补 `repository` 字段

发布前建议在 `package.json` 里加上（npm 页面的链接会用到）：

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/你的用户名/xiyoungtools.git"
},
"homepage": "https://github.com/你的用户名/xiyoungtools#readme",
"bugs": { "url": "https://github.com/你的用户名/xiyoungtools/issues" }
```

没有仓库也可以不发这三个字段，只是 npm 页面上少几个链接。

## 2.2 发布前自检

```bash
# 1) 语法
node --check index.js
node --check client.js

# 2) Python 脚本语法
python -c "import ast; [ast.parse(open(p,encoding='utf-8').read()) for p in ['prosody.py','batch_import.py','video_watch.py']]; print('ok')"

# 3) 看会打包哪些文件（这一步不会真的发布）
npm pack --dry-run
```

`npm pack --dry-run` 会列出所有会进包的文件和总大小。确认清单对，再发。

## 2.3 发布

```bash
# 打一个真实的 tarball 先看看（可选）
npm pack
tar -tzf xiyoungtools-0.2.0.tgz

# 正式发
npm publish
```

发布成功后会打印：

```text
+ xiyoungtools@0.2.0
```

## 2.4 之后每次更新

```bash
npm version patch     # 0.1.0 → 0.1.1（修 bug）
npm version minor     # 0.1.0 → 0.2.0（加功能）
npm version major     # 0.1.0 → 1.0.0（不兼容改动）
npm publish
```

`npm version` 会自动改 `package.json` 并打 git tag。

## 2.5 常见问题

| 报错 | 原因 | 解决 |
|---|---|---|
| `ENEEDAUTH` | 没登录 | `npm login` |
| `403 Forbidden` | 包名被占，或 scoped 包没写 `access: public` | 改名或加 `publishConfig` |
| `402 Payment Required` | scoped 包默认私有，要付费 | 加 `"publishConfig": {"access": "public"}` |
| `E409 Conflict` | 这个版本号已经发过了 | 升版本号，**不能覆盖已发布版本** |
| 发的包里少了文件 | `files` 字段没列全 | 跑 `npm pack --dry-run` 看清单 |

> **已发布的版本不能删除也不能覆盖**（24 小时内可以 `npm unpublish`，但会留记录）。所以发之前一定先 `npm pack --dry-run` 确认。

## 2.6 撤销（谨慎）

```bash
# 24 小时内可以
npm unpublish xiyoungtools@0.1.0

# 或者只标记弃用，让别人看到警告
npm deprecate xiyoungtools@0.1.0 "这个版本有问题，请用 0.1.1"
```

---

# 三、包结构说明

发布出去的包长这样：

```text
xiyoungtools/
├── index.js          Host 半边：11 个工具 + 26 条路由
├── client.js         页面：3 个标签页
├── video_watch.py    视频逐帧观看
├── prosody.py        韵律分析
├── batch_import.py   批量导入
├── cordis.patch.yml  插件注册
├── package.json
├── icon.svg
├── locale/
│   ├── zh.json
│   └── en.json
├── docs/
│   └── DETAIL.md
├── README.md         中文说明
├── README.en.md      英文说明
├── INSTALL.md        本文件
├── CHANGELOG.md
└── LICENSE
```

关键字段：

| 字段 | 作用 |
|---|---|
| `main` | Host 入口 |
| `exports["./client"]` | 页面入口，DSH 靠它加载 |
| `exports["./cordis.patch.yml"]` | 插件注册文件 |
| `dsh.bundle.patch` | 指向 cordis.patch.yml |
| `dsh.client.platform` | `web` |
| `files` | 发布白名单，**少列就少发** |
| `engines.dsh` | 兼容的 DSH 版本范围 |

---

# 四、开发时怎么改

| 改什么 | 要重启吗 |
|---|---|
| `client.js`（页面） | 刷新页面即可（插件是 `link:` 装的） |
| `index.js`（Host、工具） | 要重启 DSH |
| `*.py`（分析脚本） | 不用，每次任务启动时重新调用 |

改完想验证：

```bash
node --check index.js
node --check client.js
```

Host 改动的日志看：

```text
%USERPROFILE%\.dsh\logs\ds-harness-remote\host.log
```

插件自己的错误会用 `console.error` 打上 `xiyoungtools:` 前缀。
