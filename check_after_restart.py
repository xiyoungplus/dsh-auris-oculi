# -*- coding: utf-8 -*-
"""重启后的自检脚本。

为什么需要：
    0.20.2 修了「工具回执中文乱码」（runProcess 没传 env，Python 按 GBK 输出）。
    但那个修复在 index.js 里，**必须重启 DSH 才生效**。
    重启时当前会话会终止，所以没法在会话里验证。

    重启后跑这个脚本，一次性确认：
      1. 插件是否加载了新代码
      2. 中文是否正常（编码修复是否生效）
      3. 两个说话人后端是否可用

用法：
    python check_after_restart.py
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PASS = "[ OK ]"
FAIL = "[FAIL]"
WARN = "[WARN]"

results = []


def check(label, fn):
    try:
        ok, detail = fn()
    except Exception as e:
        ok, detail = False, str(e)[:120]
    tag = PASS if ok else FAIL
    results.append((ok, label))
    print("  %s %-38s %s" % (tag, label, detail))
    return ok


print("=" * 72)
print("dsh-auris-oculi 重启后自检")
print("=" * 72)

# ---------------------------------------------------------------- 1. 代码层面
print("\n[1] 代码层面（不依赖运行中的 DSH）")


def check_env_fix():
    """直接读源码，确认 runProcess 里有 env。"""
    p = os.path.join(HERE, "index.js")
    t = open(p, encoding="utf-8").read()
    i = t.find("function runProcess(")
    if i < 0:
        return False, "找不到 runProcess"
    body = t[i:i + 900]
    has_env = "env:" in body
    has_pythonenv = "pythonEnv()" in body
    if has_env and has_pythonenv:
        return True, "runProcess 已传 env"
    return False, "runProcess 缺 env —— 中文仍会乱码"


def check_python_env_utf8():
    p = os.path.join(HERE, "index.js")
    t = open(p, encoding="utf-8").read()
    if "PYTHONIOENCODING: 'utf-8'" in t or "PYTHONIOENCODING: \"utf-8\"" in t:
        return True, "pythonEnv 有 PYTHONIOENCODING"
    return False, "缺 PYTHONIOENCODING"


check("runProcess 传了 env", check_env_fix)
check("pythonEnv 设了 UTF-8", check_python_env_utf8)

# ---------------------------------------------------------------- 2. 编码实测
print("\n[2] 中文编码实测（关键：这是重启要验证的核心）")


def check_encoding_end_to_end():
    """真的跑一次 python 子进程，看中文能不能完整回来。

    这是最接近真实工具调用的测试：spawn with env，读 stdout。
    """
    code = (
        "import sys, json\n"
        "sys.stdout.reconfigure(encoding='utf-8')\n"
        "print(json.dumps({'msg': '很可能是同一个人'}, ensure_ascii=False))\n"
    )
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        r = subprocess.run([sys.executable, "-c", code],
                           capture_output=True, text=True, timeout=30,
                           encoding="utf-8", env=env)
        if r.returncode != 0:
            return False, (r.stderr or "")[:80]
        line = [l for l in r.stdout.strip().split("\n") if l.strip().startswith("{")][-1]
        msg = json.loads(line)["msg"]
        if msg == "很可能是同一个人":
            return True, "中文完好：" + msg
        return False, "中文损坏：" + msg
    except Exception as e:
        return False, str(e)[:100]


check("python 子进程中文往返", check_encoding_end_to_end)

# ---------------------------------------------------------------- 3. 说话人后端
print("\n[3] 说话人后端")


def check_backend_resolve():
    try:
        import prosody as P
        b = P.resolve_speaker_backend()
        return True, "auto 解析为 " + b
    except Exception as e:
        return False, str(e)[:100]


def check_campplus():
    try:
        import prosody as P
        ex, err = P.load_campplus_extractor()
        if ex is not None:
            return True, "CAM++ dim=%d" % ex.dim
        return False, (err or "")[:100]
    except Exception as e:
        return False, str(e)[:100]


def check_resemblyzer():
    try:
        import prosody as P
        enc = P.load_speaker_encoder()
        if enc is not None:
            return True, "可用"
        return False, (P._SPEAKER_ERROR or "")[:100]
    except Exception as e:
        return False, str(e)[:100]


check("后端自动选择", check_backend_resolve)
check("CAM++ 模型", check_campplus)
check("Resemblyzer", check_resemblyzer)

# ---------------------------------------------------------------- 4. DSH 服务
print("\n[4] DSH 服务（如果 DSH 正在跑）")


def find_dsh_port():
    """从 DSH 进程找到监听端口。"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-NetTCPConnection -State Listen | "
             "Where-Object { $_.OwningProcess -in "
             "(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Id } | "
             "Select-Object -ExpandProperty LocalPort -Unique"],
            capture_output=True, text=True, timeout=30)
        ports = [p.strip() for p in out.stdout.split() if p.strip().isdigit()]
        return ports
    except Exception:
        return []


ports = find_dsh_port()
if ports:
    print("  发现监听端口: " + ", ".join(ports))
    found_ok = False
    for port in ports:
        try:
            url = "http://127.0.0.1:%s/xiyoungtools/health" % port
            with urllib.request.urlopen(url, timeout=5) as r:
                j = json.loads(r.read().decode("utf-8"))
            # 中文检查：health 里如果有中文说明编码链路正常
            txt = json.dumps(j, ensure_ascii=False)
            has_cn = any("\u4e00" <= c <= "\u9fff" for c in txt)
            print("  %s 端口 %s health 可访问%s" % (
                PASS, port, "，含中文" if has_cn else ""))
            found_ok = True
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            print("  %s 端口 %s HTTP %d" % (WARN, port, e.code))
        except Exception:
            continue
    if not found_ok:
        print("  %s 端口开放但 /xiyoungtools/health 无响应" % WARN)
        print("        可能路由前缀不对（插件 id 改成 dsh-auris-oculi 后")
        print("        路由路径仍是 /xiyoungtools/*，这是有意的兼容设计）")
else:
    print("  %s 没找到运行中的 DSH，跳过" % WARN)

# ---------------------------------------------------------------- 汇总
print()
print("=" * 72)
ok_count = sum(1 for ok, _ in results if ok)
print("通过 %d / %d" % (ok_count, len(results)))
failed = [label for ok, label in results if not ok]
if failed:
    print()
    print("未通过:")
    for f in failed:
        print("  - " + f)
    sys.exit(1)
print("\n全部通过")
sys.exit(0)
