# 配置参考

三层优先级：`工具参数 > 环境变量 > config.json > 预设 > 内置默认`

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
