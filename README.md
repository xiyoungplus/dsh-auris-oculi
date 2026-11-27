# Auris Oculi 感知工具箱

给 agent 装上**耳朵和眼睛**。全本机运行，不联网、不上传、不依赖云服务。

> auris（耳）+ oculi（眼），拉丁语。

[![npm](https://img.shields.io/npm/v/dsh-auris-oculi)](https://www.npmjs.com/package/dsh-auris-oculi)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

---

## 它解决什么问题

人耳能听出很多：说话的是不是同一个人、语速急不急、声音抖不抖、有没有背景噪声。
但这些**感觉**没法量化，也就没法比较、没法复核。

这个插件把它们变成数字：

```
基频中位 152 Hz   音域 11.3 半音   微颤 0.38
音量起伏 3.2 dB   语速 3.3 字/秒   谐噪比 4.9
```

27 个数字，每一个都能复现、能对比、能被别人验证。

---

## 三件事先说清楚

### 一、它测量声音，不判断情绪

27 个数字都是可验证的，但「这段是什么情绪」做不到——
真实说话的 7 类情绪分类只有 **34.3%**（随机 14.3%）。

那些数字承载的是「怎么发声」，不是「什么情绪」。详见 [情绪可行性实测](docs/emotion-findings.md)。

### 二、聚类和分离不可靠，要看 `caveats`

`speaker_cluster` / `speaker_diarize` 基于 Resemblyzer 嵌入，
而它在这类音频上区分力不足：同人内部 0.79、不同人 0.75，**只差 0.04**。

`speakerCount: 1` 可能是「只有一个人」，也可能是「我分不出来」。

### 三、声纹比对可靠，但要看长度

`speaker_compare` 是这组里唯一稳的，前提是给 **4 秒以上**音频（8 秒才稳定），
且看**相对排位**而不是绝对分数。

详见 [声纹可靠性实测](docs/speaker-reliability.md)。

---

## 安装

```bash
npm install -g dsh-auris-oculi
```

然后在 DSH 的 Plugins 面板里启用，左侧栏会出现入口。

**依赖不止 npm**——还要 ffmpeg、Python 库、可选模型。
完整清单和已知陷阱见 **[安装指南](docs/INSTALL.md)**。

| 依赖 | 缺了会怎样 |
|---|---|
| **ffmpeg** | 所有音视频工具不可用 |
| Python + librosa | 韵律分析、批量导入不可用 |
| yt-dlp | 只能处理本地文件 |
| Ollama + qwen3.5:4b | 视频逐帧观看不可用 |
| 声纹后端 | 三个 `speaker_*` 工具不可用 |

页面底部会实时显示检测结果，缺了哪个一眼能看到。

---

## 十三个工具

| 工具 | 做什么 | 可靠性 |
|---|---|---|
| `toolbox_analyze` | 一条视频/音频，画面+声音同时看 | 好 |
| `video_summary` | B 站视频逐帧观看 | 好（OCR 有错字） |
| `media_clip` | 从视频/音频截一段 | 好 |
| `prosody_analyze` | 27 个客观数字 + 转写 + 变化点 | 好（数字） |
| `prosody_label` | 记一条声音笔记 | 好 |
| `prosody_batch` | 整个文件夹批量分析 | 好 |
| `speaker_compare` | 两条音频像不像同一个人 | **好**（4 秒以上） |
| `speaker_cluster` | 一批音频里有几个人 | 粗分组 |
| `speaker_diarize` | 一段录音谁在第几秒说 | ⚠️ 必看 caveats |
| `toolbox_benchmark` | 这批标注值不值得用 | 好 |
| `toolbox_job` | 查任务进度 | 好 |
| `toolbox_cache_clean` | 清理中间产物（含下载缓存） | 好 |
| `toolbox_doctor` | 环境体检：依赖、可用性、磁盘占用 | 好 |

**每个工具的参数、返回字段、实测限制** → [工具手册](docs/TOOLS.md)

---

## 页面

左侧栏三个标签页：

```
分析         ← B 站链接 / 本地文件，自动分流
截取与韵律    ← 子标签：截取 | 韵律与转写 | 声纹 | 批量分析 | 笔记
配置         ← 预设 + 43 个配置项 + 缓存清理
```

各页面的功能和操作 → [界面说明](docs/UI.md)

---

## 配置

三层优先级：`工具参数 > 环境变量 > config.json > 预设 > 内置默认`

7 个分组、41 个配置项：`model` `video` `audio` `speaker` `changes` `limits` `ui`

最常用的几个：

| 配置项 | 作用 | 默认 |
|---|---|---|
| `model.name` | 视觉模型 | `qwen3.5:4b` |
| `model.maxConcurrency` | 全局同时打模型的请求上限（跨任务） | 1 |
| `video.height` | 下载分辨率 | 1080 |
| `video.sheetWidth` | 拼图宽度（影响 OCR 精度） | 1000 |
| `video.density` | 抽帧策略：`budget` / `max` / `smart` | `budget` |
| `video.sceneThreshold` | `smart` 模式的画面变化阈值 | 0.30 |
| `speaker.backend` | 声纹后端 | `auto` |

完整列表 → [配置参考](docs/CONFIG.md)

---

## 文档

| 文档 | 内容 |
|---|---|
| [**项目介绍**](docs/INTRO.md) | 想先看懂这是什么、为什么值得用 → 读这个 |
| [安装指南](docs/INSTALL.md) | 依赖清单、每个坑的解法、换机器 |
| [工具手册](docs/TOOLS.md) | 12 个工具的参数和限制 |
| [界面说明](docs/UI.md) | 三个标签页怎么用 |
| [配置参考](docs/CONFIG.md) | 41 个配置项 |
| [实现细节](docs/DETAIL.md) | 算法怎么做的、阈值怎么定的 |
| [声纹可靠性实测](docs/speaker-reliability.md) | 24 说话人的完整数据 |
| [情绪可行性实测](docs/emotion-findings.md) | 六套语料的测试结论 |
| [踩坑清单](docs/PITFALLS.md) | 改代码前该知道的事、静默失败、测试本身的坑 |
| [开发与贡献](CONTRIBUTING.md) | 怎么跑测试、哪些问题不用报 |
| [交接书](docs/HANDOVER.md) | 状态、失败结论、踩过的坑 |
| [更新日志](CHANGELOG.md) | 每个版本做了什么 |

---

## 已知限制

- **OCR 可能读错字**：4B 视觉模型对中文画面不完美，关键帧建议人工核对
- **一次只跑一个同类任务**：视频、截取、韵律、批量各自独立排队
- **韵律只给数字**：不给「这句话是催还是试探」的判断，那需要标注样本
- **微颤需要多样本**：单条录音的抖动数字可能只是噪声
- **声纹工具需要长音频**：4 秒以下「不像」的结论不可信
- **跨设备未验证**：换麦克风、换嘈杂环境还没测

---

## 参与

这个插件的数字都是实测出来的，所以**报「数字不对」比报 bug 更有用**。

- 发现问题 → 开 [issue](https://github.com/xiyoungplus/dsh-auris-oculi/issues/new/choose)
- 想改代码 → 先看 [CONTRIBUTING.md](CONTRIBUTING.md)
- **已知不会修的问题**（情绪识别、说话人分离精度）写在 CONTRIBUTING 里，请先确认不是这些

最需要的帮助不是加功能，是拿真实音频去试，然后说哪里的数字不对。

---

## 许可

**GPL-3.0-or-later**

- **用**：随便用，个人、公司、商用都行
- **改**：可以改，改了自己用也没问题
- **分发**：如果把改过的版本发出去，必须也以 GPL-3.0 开源

不需要付费，也不需要联系我们。完整条文见 [LICENSE](LICENSE)。

> 为什么选 GPL：这里的每个数字和结论都是实测出来的，花了很多时间验证
> 「什么能做、什么做不到」。选 GPL 是希望改进能回流，而不是被拿走闭源后
> 让别人再踩一遍同样的坑。
