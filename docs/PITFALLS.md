# 踩坑清单

写这个插件时踩过的坑，按「动手前该知道什么」组织。

每一条都是**真实发生过**的：有现象、有原因、有判断方法。
不是编程常识，是代码看着对、跑起来不对的那类。

**动手改代码之前，扫一遍对应的章节。** 尤其是「改名前必读」和「静默失败」两节——
那两类错误不会报错，只会悄悄降级。

---

## 一、改名前必读

这个插件曾经叫 `xiyoungtools`，改名成 `dsh-auris-oculi` 时漏了四处，
**导致左侧栏入口整个消失**。

### 必须同步改的地方

| 位置 | 为什么 | 漏了会怎样 |
|---|---|---|
| `package.json` 的 `name` | 基准 | — |
| `cordis.patch.yml` 的 `id` | 插件挂载 id | Host 半不加载 |
| `cordis.patch.yml` 的 `name` | 同上 | 同上 |
| **`client.js` 的 `id`** | DSH 靠它匹配前端模块 | **左侧栏无入口** |
| **`client.js` 的 `PANEL_ID`** | `main` slot 的 key | 点图标打不开页面 |
| profile 的 `dependencies` | 依赖声明 | 插件找不到 |
| profile 的 `bundles` | 加载清单 | 插件不加载 |
| `node_modules` 的 junction 名 | 目录名必须等于包名 | 同上 |

DSH 文档原文（`references/ui-plugin.md`）：

> The browser artifact registers a lazy factory **whose id equals the package name**.

### 这个 bug 为什么特别阴险

**Host 半完全正常**：`/xiyoungtools/health` 返回 200，13 个工具都能调，Python 脚本都能跑。

只有前端挂不上 —— 左侧栏没有入口。

你会以为是前端代码坏了，去翻 `client.js` 的逻辑，但那里一点问题都没有。

**判断方法**：如果工具能用但页面打不开，**先查身份一致性，不要查前端逻辑**。

### 为什么测试没抓到

`grep xiyoungtools` 搜不到。因为要检查的是「**等于包名**」这个关系，
不是「等于某个具体值」——搜字符串天然搜不到这类约束。

现在有 16 条身份检查在 `scripts/test-host.mjs` 的「身份一致性」一节，
**任何一条红都别忽略**。

### 不要改的地方（有意保留旧名）

| 保留什么 | 为什么 |
|---|---|
| 路由前缀 `/xiyoungtools/*` | 44 条路由都在用，改了要同时动两处，无收益 |
| 数据目录 `~/.dsh/xiyoungtools/` | 里面有不可再生的 `labels.json`，改路径 = 删数据 |
| 环境变量 `XIYOUNG_*` | 用户 `config.json` 里存的是这些键名 |
| **localStorage 键** `xiyoungtools:*` | 用户已存的 URL/模型/clip 参数，改键名 = 清空配置 |

有人会觉得「改名改了一半」，想顺手统一。**别动**，代码里有注释说明。

---

## 二、静默失败（最难发现的一类）

这类错误**不报错、不崩溃**，只是结果悄悄变差。

### 2.1 `prosody.py` 移到 `lib/` 后，模型静默找不到

```python
here = os.path.dirname(os.path.abspath(__file__))
os.path.join(here, "models")          # 移到 lib/ 后变成 lib/models/
```

`lib/models/` 不存在，于是 **CAM++ 找不到、静默退回 Resemblyzer**。

功能还是能用，只是错误率从 6.4% 变成 19.5%。**没有任何报错。**

**判断方法**：`toolbox_doctor` 看 `speaker.backend` 是不是还在 `campplus`。

**正确写法**：

```python
here = os.path.dirname(os.path.abspath(__file__))   # lib/
root = os.path.dirname(here)                        # 插件根
os.path.join(root, "models")
```

### 2.2 `runProcess` 没传 `env`，中文全成乱码

```js
spawn(command, args, { windowsHide: true, cwd })     // 缺 env
```

Windows 上 Python 按 GBK 输出，Node 用 UTF-8 去解 → 中文全是 `�ܿ�����ͬһ����`。

**症状**：数字能读、文字全废。因为数字是 ASCII，不受编码影响。

这个症状很容易被误判成「数据问题」，但其实是编码问题。

**正确写法**：

```js
spawn(command, args, { windowsHide: true, cwd, env: options.env || pythonEnv() })
```

所有 spawn 都应该走 `pythonEnv()`，那里有 `PYTHONIOENCODING=utf-8`。

### 2.3 `maxSheets` 被夹住但不告诉你

schema 写 `maximum: 500`，但实际被 `video.maxSheetsHardCap`（默认 200）夹住。

传 300 会变成 200，**之前完全看不到**。

现在回执里给 `maxSheetsCapped` / `effectiveMaxSheets`，被夹时会说。

**教训**：凡是「用户给了值但实际没用那个值」的地方，回执里必须说。

### 2.4 下载缓存目录不在清理清单里

0.21.0 加了 `cache/video` 下载缓存，但 `CLEAN_ROOTS` 里没有它。

那个目录**会一直涨**，`cache_clean` 完全不知道它的存在。

**教训**：新增一种落盘数据，同时要问「谁来清理它」。

---

## 三、编码与平台

### 3.1 PowerShell 5.1 控制台是 GBK

`InputEncoding=gb2312`，UTF-8 的中文输出会显示成乱码。

**这是显示问题，不是文件问题。** 判断方法：用 Python 读文件确认。

```powershell
# 会显示乱码
Get-Content file.yml

# 不会
python -c "import io; print(io.open('file.yml', encoding='utf-8').read()[:60])"
```

我在这个坑上浪费过时间，去「修」一个其实没坏的文件。

### 3.2 PowerShell 不支持内联 `if`

```powershell
"  {0} {1}" -f $name, (if($x){"是"}else{"否"})     # 报错
```

PowerShell 5.1 里 `if` 是语句不是表达式。要么改用 Python，要么拆成两行。

### 3.3 here-string 里有 `|` 或复杂引号会炸

```powershell
& $py -c @"
old = '''| 表格 | 开始'''          # ← 这里的 | 会破坏解析
"@
```

**对策**：涉及复杂字符串的脚本，写成 `.py` 文件再执行，不要用 `-c` + here-string。

### 3.4 Python 脚本输出 `✓` 会在 GBK 控制台崩

写测试脚本时用 `✓` / `⚠`，在 Windows GBK 控制台下 `UnicodeEncodeError`。

**对策**：测试脚本用 ASCII（`OK` / `FAIL`），或者设 `PYTHONIOENCODING=utf-8`。

---

## 四、Python 与 numpy

### 4.1 `if not array` 会抛异常

```python
if not a:                    # ValueError: truth value of an array is ambiguous
if len(a) == 0:              # 正确
```

numpy 数组不能用布尔上下文判断。

### 4.2 临时目录碰撞让所有结果一样

`decode_to_wav` 用固定临时目录名，两次调用产生**同一个文件**。

结果：所有嵌入向量完全相同（余弦 1.0000），看起来像「模型认为都是同一个人」。

**正确写法**：每个文件用 `tempfile.mkdtemp()` 生成唯一目录。

### 4.3 `extract_formants` 一直没用

LPC 在 1–3 秒的短音频上极不稳定。写好了但没接入，是**有意保留**的，不是遗漏。

---

## 五、测试本身的坑

### 5.1 `check()` 把字符串当通过

```js
if (result === true)  ✓
if (result === false) ✗
else                   ✓ + 附注        // ← 字符串在这里打勾
```

而测试大量用 `return cond ? true : '失败原因'` —— 失败时返回的正是字符串。

**这意味着那些测试从来没有真正失败过。**

修完之后立刻红了 3 项，全是真的。

**教训**：写测试框架时，`true` 才算通过，其他一切都算失败。

### 5.2 正则 `[^)]*` 遇到嵌套括号就停

```js
/spawn\([^)]*env\s*:/       // pythonEnv() 的 ) 会提前终止匹配
```

代码里是 `spawn(cmd, args, { env: pythonEnv() })`，
`[^)]*` 在 `pythonEnv(` 后面的 `)` 就停了，永远匹配不到 `env:`。

**对策**：检查代码结构时，优先用「截一段再 includes」而不是写复杂正则。

### 5.3 截取范围写太小

```js
const body = src.slice(idx, idx + 600)     // runProcess 的注释放了 12 行
```

`spawn(` 落在第 572 字符，`env:` 在 600 之外，断言永远失败。

**教训**：按源码结构检查时，范围要留足。注释多的函数尤其容易撞。

### 5.4 断言写死数字

```js
check('41 条路由全部注册', () => routes.size === 41)
```

加了路由就过期。而且「改成新数字」并不能验证什么。

**改成动态校验**：

```
数量下限 && 前缀统一 && 源码声明数 == 运行时注册数
```

最后一条才有价值——它能发现「某个 register 因异常被跳过」。

### 5.5 测试改的是「断言」而不是「代码」

最危险的一种：测试红了，真问题是代码，但被改成断言去迁就。

上面 5.1 那个 bug 掩盖了 3 个真实失败。如果当时按「测试过期了」处理，
就会把错误固化下来。

**判断方法**：测试红了先问「代码对还是断言对」，
用独立手段（手动跑一次、读源码）确认，不要直接改数字。

**我自己就犯过**：写文档时想核对「有没有 labels 备份」，用
'labels.bak.json' in 源码 去搜，搜不到，差点写「没有备份」。

实际代码是拼出来的：

```js
const bak = LABELS_FILE.replace(/\.json$/, '') + '.bak.json'
```

文件名在源码里根本不以完整字符串出现。**搜不到 ≠ 不存在**。

---

## 六、进程与并发

### 6.1 多个任务同时打 Ollama 会抢爆显存

每个任务独立 spawn python，各自开 `ThreadPoolExecutor`。

**N 个任务 × M 并发 = N×M 个请求**同时打模型。

现在用跨进程锁文件做闸门（`cache`/`locks/slot-N`）。

**为什么用文件锁**：内存信号量只管本进程，跨进程无效。
**为什么不用 `fcntl`**：Windows 不支持。`O_CREAT|O_EXCL` 更可移植。

**兜底**：抢不到槽位时等 180 秒后**照常放行**。卡死比慢一点更糟。

### 6.2 僵尸锁

进程崩了不会删锁文件。超过 10 分钟的槽位文件视为僵尸，自动清理。

---

## 七、视频下载

### 7.1 分段下载失败要能退回

`--download-sections` 依赖 yt-dlp + ffmpeg，有些站点/格式走不了。

**必须**：失败自动整条下载，不能让用户任务直接失败。

### 7.2 `target != video` 时 glob 的目录

补丁里的原始代码：

```python
hits = sorted(glob.glob(os.path.join(outdir, "video.*")))   # 但 target 在 cache_dir
```

yt-dlp 若给文件加了后缀（`video.mkv`），在 `outdir` 里找不到，
会误报「下载完成但找不到 video 文件」。

**正确**：按 `target` 所在目录 + 同 stem 查找。

### 7.3 分段下载的文件大小

实测：看 3 分钟 ≈ 下 12 MB，整条 116 分钟 ≈ 400 MB。

但**缓存键必须包含时间段**，否则「看第一段」和「看第二段」会互相覆盖。

---

## 八、FFmpeg

### 8.1 `-vsync` 在新版本改名了

ffmpeg 9.x 里 `-vsync vfr` 报 `Option not found`，改用 `-fps_mode vfr`。

### 8.2 `fps` 滤镜会漏掉段末尾

`fps=1/interval` 从段起点开始取，最后一帧可能离末尾还有将近一个 interval。

实测：30 秒段 / 6 秒间隔，只抽到 01:24，01:24–01:30 完全没看。

**对策**：抽完再单独补一帧末尾，如果它和最后一帧太近就跳过。

### 8.3 `scene` 检测在静态画面上抽不到帧

`select='gt(scene,0.3)'` 在访谈、板书这类几乎不动的画面上**可能一帧都抽不出来**。

**对策**：`density: "smart"` 里做了保底——不足时补足到固定间隔密度。

---

## 九、声纹

### 9.1 两个后端的坐标系完全不同

Resemblyzer（256 维）和 CAM++（192 维）的余弦分数**不能混用阈值**。

- CAM++：异人 0.1~0.4，同人 0.4~0.8
- Resemblyzer：异人可到 0.5+（各向异性导致虚高）

**跨后端比较必须拒绝**，`speaker_compare.py` 里有这个检查。

### 9.2 音频长度决定可靠性

同一个人把音频切成两半再比：

| 时长 | 余弦 |
|---|---|
| 1 s | 0.58 |
| 2 s | 0.56 |
| 4 s | 0.71 |
| **8 s** | **0.88** |
| 12 s | 0.89 |

**8 秒是拐点**。低于 4 秒的「不像」结论不可信。

### 9.3 重叠永远不会消失

8 秒时：同人最低 0.5946，异人最高 0.7264 —— **区间是重叠的**。

所以不能说「分数 > X 就一定是同一个人」，只能说「更像」。

---

## 十、文档与发布

### 10.1 移动文件后必须重跑测试

`regression_content_class.py` 和 `check_after_restart.py` 移到 `scripts/` 后，
靠 `HERE = dirname(__file__)` 找 `prosody.py` 的 import 全挂。

修法：`ROOT = dirname(HERE)` 和 `LIB = join(ROOT, "lib")` 都加进 `sys.path`。

### 10.2 `package.json` 的 `files` 是白名单

移走文件后如果 `files` 还列着旧路径，`npm pack` 会 MISS。

`lib` 整个目录被包含时，`__pycache__` 也会跟进去（多 214 KB）。

**对策**：`.npmignore` 里显式排除 `__pycache__/` 和 `*.py[cod]`。

### 10.3 npm 发布是异步的

`npm publish` 返回 0 之后，registry 上还要等 1–3 分钟才出现。

期间会遇到：
- 临时占位包 `0.0.0-stage`（staged publishing）
- `dist-tags.latest` 还是旧版本

**别以为发布失败了**，用轮询确认。

### 10.4 发布需要 Bypass 2FA 的 token

普通的 granular token 会报 `EOTP`（要一次性验证码），命令行没法输入。

**必须**在 npm 网站生成 token 时勾上 `Bypass two-factor authentication (2FA)`。

`Organizations` 那栏如果报红，把 Permissions 改成 `No access`（个人包不需要）。

### 10.5 代理断了 git 会连不上

`git push` 报 `Failed to connect to github.com:443`，但 `Test-NetConnection` 显示端口通。

**原因**：系统走代理，但 git 不读 Windows 系统代理设置。

```powershell
git config --global http.proxy "http://127.0.0.1:7892"
```

代理软件关掉后要记得清理，否则直连也会失败。

---

## 十一、DSH 插件特有

### 11.1 Host 改动必须重启 DSH

`.py` 改动不用重启（每次新鲜 spawn），但 `index.js` / `client.js` 改动需要。

**没有热重载**。

### 11.2 加配置项必须改三处

| 位置 | 作用 |
|---|---|
| `SPEC` 表 | 声明类型和默认值 |
| `BUILTIN_DEFAULTS` | 预设里也要有 |
| `pythonEnv()` | 注入给 Python 的环境变量 |

漏一处 → `audit-config.mjs` 会报「有声明但没通路」。

### 11.3 路由前缀和数据目录是兼容层

见「一、改名前必读」的「不要改的地方」。

### 11.4 `labels.json` 是唯一不可再生的数据

`~/.dsh/xiyoungtools/labels/labels.json`，1212 条标注。

所有清理逻辑都跳过它，`writeLabels` 会自动写 `labels.bak.json`。

**测试时绝不能让它对着真实目录跑**——`test-host.mjs` 里把 `DSH_HOME`
指向临时目录，就是为了这个。

---

## 速查：症状 → 可能原因

| 症状 | 先查 |
|---|---|
| 工具能用但左侧栏没入口 | 身份一致性（第一节） |
| 中文乱码、数字正常 | `runProcess` 的 `env` |
| 声纹精度突然变差 | 模型路径（`toolbox_doctor` 看 backend） |
| 磁盘一直涨 | 新增的落盘目录有没有纳入清理 |
| 用户设的值没生效 | 有没有被上限夹住（静默） |
| 测试全绿但功能不对 | `check()` 是不是把字符串当通过了 |
| 移动文件后 import 失败 | `sys.path` 里的 `ROOT` / `LIB` |
| npm 发布报 EOTP | token 有没有勾 Bypass 2FA |
| git 连不上 GitHub | 代理配置 |

---

## 这个文件怎么用

**改代码之前**：看「改名前必读」和「速查表」。
**加新功能之前**：看「静默失败」——问自己这个功能会怎么悄悄变差。
**测试红了**：看「测试本身的坑」5.5 —— 先确认是代码错还是断言错。
**发布之前**：看第十节。

新增踩坑时，**写清「症状」而不只是「原因」**。
下次遇到同样的症状才能搜到。
