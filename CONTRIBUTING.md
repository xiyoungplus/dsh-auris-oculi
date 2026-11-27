# 参与开发

这个插件是给 agent 装「耳朵和眼睛」的：让它能听音频、看视频，
并且把听到看到的东西变成**可验证的数字**。

最需要的帮助不是加功能，是**找问题**——尤其是下面「已知问题」之外的那些。

---

## 最快的参与方式：报一个问题

不需要会写代码。用得上这个插件就够。

开 issue 时**最好带上这几样**：

1. **你做了什么**（哪个工具、什么参数）
2. **你期望什么**
3. **实际发生了什么**（贴回执，或截图）
4. **环境**：操作系统、`ffmpeg -version` 第一行、Python 版本

回执里通常有 `caveats` 和 `outDir`，两个都贴上有用。

如果涉及到音频/视频，**能复现的最小文件**最有价值。不用整段，只要能触发问题的那几秒。

---

## 比报 bug 更有用的：报「数字不对」

这个插件输出的是数字，所以「感觉不对」要能落成「这个数不对」。

一个好的报告长这样：

> 同一段录音（附上文件），`prosody_analyze` 给出基频中位 152 Hz，
> 但用 Audacity 看频谱，基频在 220 Hz 附近。
> 音频是 44.1 kHz 立体声，转成 16 kHz 单声道后仍然如此。

这样的报告能直接定位问题。只说「基频不准」就没法查。

---

## 已知问题（这些不用再报）

| 问题 | 状态 | 原因 |
|---|---|---|
| 情绪识别不准 | **不会修** | 真实说话 34.3%（随机 14.3%），信噪比到头 |
| `speaker_diarize` 分错人数 | 已知限制 | 嵌入区分力不足，同人 0.79 / 异人 0.75 |
| `speaker_cluster` 分组太粗 | 已知限制 | 同上 |
| 短音频声纹不可靠 | 已在 `caveats` 提示 | 4 秒以下不可信，8 秒才稳定 |
| OCR 偶尔读错字 | 已知限制 | 4B 视觉模型能力边界 |
| `qwen3-vl:4b` 返回空 | 已知 | 请用 `qwen3.5:4b` |
| `webrtcvad` 装不上 | 已知 | 必须用 `webrtcvad-wheels` |

完整清单见 `docs/HANDOVER.md` 的「四、已知的失败结论」，
以及 `docs/` 下的两份实测报告。

---

## 开发环境

### 跑起来

```powershell
# 1. 确认依赖（缺什么装什么，见 INSTALL.md）
ffmpeg -version

# 2. 本地 link 到 DSH
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-auris-oculi" `
  -Target "你的插件目录" -Force

# 3. 在 profile 的 dsh.profile.bundles 里加上 dsh-auris-oculi
```

改 `client.js` 刷新页面就生效；改 `index.js` 需要重启 DSH。

### 跑测试

**改完代码必须跑这四条**：

```powershell
node scripts/test-host.mjs                      # 64 条断言：路由/配置/清理/编码/多后端
node scripts/smoke.mjs                          # client.js 真渲染
node scripts/audit-config.mjs                   # 41 个配置项都有通路
python scripts/regression_content_class.py      # nonverbal 分类（需要 testdata/）
```

`regression_content_class.py` 依赖 `testdata/`（44 MB 测试音频），
不在仓库里。没有数据时会跳过，不算失败。

外加语法检查：

```powershell
node --check index.js
node --check client.js
python -c "import ast,glob; [ast.parse(open(f,encoding='utf-8').read()) for f in glob.glob('*.py')]"
```

### 加配置项必须改三处

这是最容易漏的地方，`audit-config.mjs` 会抓：

1. `index.js` 的 `SPEC` 表（决定能读写、在哪一组）
2. `BUILTIN_DEFAULTS`（默认值）
3. `pythonEnv()`（注入到 python 子进程的环境变量）

**只改前两处不会报错，但配置完全不生效。** 0.11.x 踩过这个坑。

---

### 改名后为什么有些名字没变

插件叫 `dsh-auris-oculi`，但你会看到 `XIYOUNG_*` 环境变量、
`/xiyoungtools/*` 路由、`~/.dsh/xiyoungtools/` 数据目录。

**这些是刻意保留的**：
- 数据目录里有用户不可再生的标注，改路径等于删数据
- 路由和工具名被前端和调用方写死
- 环境变量在用户的 `config.json` 里

**不要「顺手」把它们改统一**，那会破坏兼容性。详见 `docs/HANDOVER.md`。

---

## 代码约定

> 动手前先看 [踩坑清单](docs/PITFALLS.md)——那里有真实发生过的坑，
> 尤其「静默失败」和「测试本身的坑」两节：前者不报错只是悄悄变差，
> 后者会让测试假装通过。

### 注释写「为什么」，不写「是什么」

```js
// 不好：这里是判断音域
if (semitoneRange > 18) { ... }

// 好：正常说话音域 8-15 半音，非言语声音要么极窄（磨牙 1.9）
//     要么极宽（打哈欠 23.1），所以取双端判据
if (semitoneRange > 18) { ... }
```

**实测数据和踩过的坑一定要写进注释**，否则下一个人会把同一个坑再踩一遍。

### 硬编码的名字不能随便改

这些是兼容层，改名会让用户数据或调用方失效：

| 保留 | 原因 |
|---|---|
| `XIYOUNG_*` 环境变量 | 用户的 `config.json` 在用 |
| `~/.dsh/xiyoungtools/` | 里面有 **1212 条不可再生的标注** |
| `toolbox_*` 工具名 | 调用方写死了 |
| `/xiyoungtools/*` 路由 | `client.js` 有 48 处引用 |

改名只改「对外标识」（包名、插件 id、显示名）。

### 不许碰 labels.json

`~/.dsh/xiyoungtools/labels/labels.json` 是唯一不可再生的数据。

任何清理逻辑都要跳过它，`test-host.mjs` 有断言检查这一点。
`writeLabels()` 每次写之前会自动存一份 `labels.bak.json`。

---

## 提交

commit message 用中文或英文都行，说清三件事：

```
修 speaker_compare 在 1 秒音频上的误判

原来没检查音频长度，1 秒的录音也会给出「很可能不是同一个人」。
实测同人 8 秒 0.88、1 秒 0.58，差距过大。

现在 < 3 秒时在 caveats 里提示「判成不像时先别信」。
```

改动涉及行为变化时，**同步更新 CHANGELOG.md**。

---

## 许可

GPL-3.0。提交的代码默认按此协议发布。

如果你改进了什么，欢迎提 PR——但按 GPL 的要求，
基于这个插件的衍生作品也需要以 GPL-3.0 开源。
