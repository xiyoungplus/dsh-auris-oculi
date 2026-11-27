# 说话人模型放这里

`speaker_compare` / `speaker_cluster` / `speaker_diarize` 三个工具需要说话人嵌入模型。
两个后端可选，**都不装也能跑**（会明确报错，不会静默出错）。

## 两个后端

| 后端 | 维度 | 安装 | 异人基准 | 同人/异人比值 |
|---|---|---|---|---|
| `resemblyzer` | 256 | `pip install resemblyzer webrtcvad-wheels` | 0.52 | 1.44 |
| `campplus` | 192 | 放一个 .onnx 到这里 | **0.26** | **2.02** |

实测数据来自 CNEV（12 个说话人 × 2 条）。**异人基准越低越好**——
resemblyzer 会把不同人拉到 0.52，所以「判断不像」时很不可靠。

## 怎么装 CAM++

下载这个文件，放到本目录：

```
3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx   约 27 MB
```

地址：

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
```

（注意 URL 里 `recongition` 是官方拼错的，不是笔误）

还要装运行时：

```bash
pip install sherpa-onnx
```

## 查找顺序

程序会按这个顺序找模型，找到就用：

1. 配置里的 `speaker.modelPath`
2. **本目录**（`models/`）
3. `datasets/speaker-models/`（工作区上一级或上两级）
4. `~/.dsh/xiyoungtools/speaker-models/`

优先选中文模型（文件名含 `zh-cn`），其次 `3dspeaker`，最后任意 `.onnx`。

## 选哪个

配置项 `speaker.backend`：

- `auto`（默认）—— 有 CAM++ 就用它，没有退回 resemblyzer
- `campplus` —— 强制用，模型缺失会报错（不静默降级）
- `resemblyzer` —— 强制用

**默认 auto 保证不装模型也能用。**

## ⚠️ 两个后端的数字不能混用阈值

它们的余弦坐标系完全不同：

```text
campplus     异人 0.1~0.4    同人 0.4~0.8
resemblyzer  异人 0.3~0.5    同人 0.6~0.9   （基准被抬高）
```

**拿 resemblyzer 时代的 0.70 去看 CAM++ 的数字，会把所有同人判成「不像」。**

程序在 `caveats` 里会按实际后端给对应提示。
跨后端比较会被拒绝（维度不同，算余弦没有意义）。

## 已知局限

CAM++ 更好，但不是万能药：

- 最优阈值错误率仍 30.9%，**只能看相对排位，不能自动判定**
- 同人最低分（0.16）比异人最高分（0.53）还低，重叠区很宽
- 推测主因是测试音频太短（0.9–1.5 秒）。**这点没验证**——
  用 3 秒以上的音频复测才能确认
