#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""音高振荡 / 滑移的回归测试。

为什么需要这个文件：
    2026-11-27 重做微颤测量后，做了变异测试——故意改坏三处关键逻辑
    （滑音门槛、过零率门槛、阶跃闸门），**回归全部还是绿的**。
    说明新功能一条测试都没有。

    按 dsh-plugin-notes.md 第十一节：
        「断言执行不到 = 没有测试
          断言永远真 = 没有测试」

    这个文件用六条**已知答案**的合成音频钉住行为。
    任何一条改动导致判定变化，这里就会红。

用法：
    python scripts/test_oscillation.py
"""
import os
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "lib"))
sys.path.insert(0, ROOT)

SR = 16000
failures = []


def check(name, fn):
    """返回 True 算通过；返回字符串是失败原因。"""
    try:
        r = fn()
        if r is True:
            print("  OK   " + name)
            return
        if r is False:
            failures.append(name)
            print("  FAIL " + name)
            return
        failures.append(name)
        print("  FAIL " + name + " → " + str(r))
    except Exception as e:
        failures.append(name)
        print("  FAIL " + name + " → " + type(e).__name__ + ": " + str(e)[:100])


# ---------------------------------------------------------------- 合成音频
def _synth(f_series, sr=SR):
    ph = 2 * np.pi * np.cumsum(f_series) / sr
    y = 0.6 * np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)
    return y.astype(np.float32)


def tone(f, dur, sr=SR):
    return _synth(np.full(int(dur * sr), float(f)), sr)


def silence(dur, sr=SR):
    return np.zeros(int(dur * sr), dtype=np.float32)


def glide_ctx(f0, f_a, f_b, slide, total=2.4, sr=SR):
    n = int(total * sr)
    ns = int(slide * sr)
    head = (n - ns) // 2
    f = np.full(n, float(f0))
    f[head:head + ns] = f_a * (f_b / f_a) ** np.linspace(0, 1, ns)
    f[head + ns:] = f_b
    return _synth(f, sr)


def vibrato(f0, dur, depth_st=2.0, rate_hz=5.0, sr=SR):
    t = np.arange(int(dur * sr)) / sr
    f = f0 * (2 ** ((depth_st / 12) * np.sin(2 * np.pi * rate_hz * t)))
    return _synth(f, sr)


def instant_step(f_a=143, f_b=86, dur=1.5, sr=SR):
    """真正的瞬时阶跃：同一相位序列中途跳频，不带微颤。

    为什么不能用 np.concatenate 拼接两段：
        librosa 的 f0 追踪会在拼接处平滑过渡，窗口内极差反而不到 6 半音，
        闸门 2 不触发，测不出它是否有效。
        实测这种「假阶跃」闸门 2 失效时结果几乎不变。
    """
    n = int(dur * sr)
    f = np.empty(2 * n)
    f[:n] = f_a
    f[n:] = f_b
    ph = 2 * np.pi * np.cumsum(f) / sr
    y = 0.6 * np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)
    return y.astype(np.float32)


def glide_then_vibrate(dur=3.0, sr=SR):
    """先滑下去，滑到底再抖——两条轨道应该同时检出。"""
    n = int(dur * sr)
    t = np.arange(n) / sr
    f = np.empty(n)
    half = n // 2
    f[:half] = 143 * (100 / 143) ** np.linspace(0, 1, half)
    tt = t[half:] - t[half]
    f[half:] = 100 * (2 ** ((2.0 / 12) * np.sin(2 * np.pi * 5.0 * tt)))
    return _synth(f, sr)


CASES = {
    "pure":      tone(143, 2.0),
    "step":      np.concatenate([tone(143, 1.0), tone(86, 1.0)]),
    "break":     np.concatenate([tone(143, 1.0), silence(0.04), tone(86, 1.0)]),
    "vibrato":   vibrato(143, 2.4, 2.0, 5.0),
    "glide":     glide_ctx(143, 143, 90, 0.25),
    "glide_vib": glide_then_vibrate(3.0),
    "instant_step": instant_step(),
}


def analyze(name):
    import prosody as P
    tmp = tempfile.mkdtemp(prefix="osctest-")
    y = CASES[name]
    path = os.path.join(tmp, name + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype(np.int16).tobytes())
    a = P.analyze(y.astype(np.float64), SR)
    s = P.segment_summary(a, a["times"])
    return a, s


CACHE = {}


def get(name):
    if name not in CACHE:
        CACHE[name] = analyze(name)
    return CACHE[name]


# ══════════════════════════════════════════════════════
print("=" * 72)
print("音高振荡 / 滑移 回归测试")
print("=" * 72)

print()
print("=== 闸门：不该报振荡的 ===")


def t_pure():
    _, s = get("pure")
    med = s.get("pitchOscillationMedian")
    if med is not None and med > 0.05:
        return "纯音报了 %.3f，应该无值" % med
    if (s.get("pitchOscillationSpans") or []):
        return "纯音报了振荡时段"
    return True


def t_step():
    _, s = get("step")
    spans = s.get("pitchOscillationSpans") or []
    if spans:
        return "阶跃报了 %d 个振荡时段" % len(spans)
    med = s.get("pitchOscillationMedian")
    # 阶跃时覆盖率应该很低（槽门 2 拦掉大部分）
    cov = s.get("pitchOscillationCoverage") or 0
    if cov > 0.3:
        return "阶跃的有效帧占比 %.0f%%，闸门 2 没拦住" % (cov * 100)
    return True


def t_break():
    _, s = get("break")
    spans = s.get("pitchOscillationSpans") or []
    if spans:
        return "断口报了 %d 个振荡时段" % len(spans)
    return True


check("纯音：不报振荡", t_pure)
check("阶跃：闸门 2 拦住（覆盖率低）", t_step)
check("断口：不报振荡时段", t_break)

print()
print("=== 检出：该报的要报到 ===")


def t_vibrato():
    _, s = get("vibrato")
    med = s.get("pitchOscillationMedian")
    if med is None:
        return "微颤没测出值"
    if med < 0.3:
        return "微颤中位 %.3f 偏低（合成 ±2 半音应 >0.3）" % med
    spans = s.get("pitchOscillationSpans") or []
    if not spans:
        return "微颤没有时段"
    # 过零率：5 Hz 微颤应该 8 次/秒左右
    rate = s.get("pitchOscillationRateMedian")
    if rate is None or rate < 4:
        return "过零率 %.1f Hz 不对（5 Hz 微颤应 ≈8）" % (rate or 0)
    return True


def t_glide():
    _, s = get("glide")
    glides = s.get("pitchGlides") or []
    if not glides:
        return "滑音没检出"
    g = glides[0]
    if g["semitones"] < 3:
        return "滑音幅度 %.1f 半音太小" % g["semitones"]
    if g["direction"] != "down":
        return "方向判错：%s" % g["direction"]
    # 区间不该过度拉伸（真实滑音 0.25 秒，允许到 0.6）
    if g["seconds"] > 0.6:
        return "滑音区间 %.2fs 拉伸过度（真实 0.25s）" % g["seconds"]
    # 纯滑音不该报振荡时段
    if s.get("pitchOscillationSpans"):
        return "纯滑音报了振荡时段"
    return True


def t_both():
    """最关键的一条：先滑后抖，两条轨道必须都出来。"""
    _, s = get("glide_vib")
    glides = s.get("pitchGlides") or []
    spans = s.get("pitchOscillationSpans") or []
    if not glides:
        return "滑音没检出（二选一 bug 回来了）"
    if not spans:
        return "振荡没检出（二选一 bug 回来了）"
    # 两者应该有时间上的分离：滑在前、振在后
    if glides[0]["start"] > spans[0]["start"]:
        return "顺序不对：滑移 %.1fs 晚于振荡 %.1fs" % (
            glides[0]["start"], spans[0]["start"])
    return True


check("微颤：测出值 + 时段 + 过零率", t_vibrato)
check("滑音：检出 + 方向 + 区间不过度拉伸", t_glide)
check("先滑后抖：两条轨道都检出（不二选一）", t_both)

print()
print("=== 字段契约 ===")


def t_fields():
    a, s = get("vibrato")
    # curves 必须有两个新字段
    if "pitchOscillation" not in a:
        return "curves 缺 pitchOscillation"
    if "pitchOscillationRate" not in a:
        return "curves 缺 pitchOscillationRate（判据必须留）"
    # 旧字段必须没了
    if "jitter" in a:
        return "curves 还有旧 jitter 字段"
    # jitterPeaks 必须删了
    if "jitterPeaks" in s:
        return "summary 还有 jitterPeaks（已删的东西回来了）"
    # state 必须还是逐帧
    st = a.get("state")
    if st is None or len(st) != len(a["times"]):
        return "state 不再是逐帧（闸门 1 会失效）"
    return True


def t_nan_not_zero():
    """测不到时必须留 NaN，不能编 0。"""
    a, s = get("pure")
    osc = a.get("pitchOscillation")
    if osc is None:
        return "缺 pitchOscillation"
    valid = [x for x in osc if not np.isnan(x)]
    if valid:
        return "纯音有 %d 帧编出了振荡值" % len(valid)
    return True


check("字段契约：新字段在、旧字段删、state 逐帧", t_fields)
check("测不到留 NaN，不编 0", t_nan_not_zero)

print()
print("=== 变异防护：这三个门槛改坏了会红 ===")


def t_zc_gate():
    """过零率门槛：滑音不该被当成振荡。"""
    _, s = get("glide")
    med = s.get("pitchOscillationMedian")
    # 纯滑音的振荡值应该很低（<0.2），如果门槛失效会变高
    if med is not None and med > 0.2:
        return "纯滑音振荡 %.3f 偏高（过零率门槛可能失效）" % med
    return True


def t_step_gate():
    """阶跃门槛：跨八度时不该报振荡。"""
    a, s = get("step")
    spans = s.get("pitchOscillationSpans") or []
    if spans:
        return "阶跃报了振荡（阶跃门槛失效）"
    return True


def t_mono_gate():
    """滑音单调性门槛：把门槛调到 0.99 会让滑音检不出。"""
    _, s = get("glide")
    if not (s.get("pitchGlides") or []):
        return "滑音检不出（单调性门槛失效）"
    return True


def t_instant_step_gate():
    """瞬时阶跃必须被闸门 2 单独拦住。

    实测：闸门 2 有效 → 振荡中位 0.011、覆盖率 6%
          闸门 2 失效 → 中位 1.186、最大 1.734（差 100 倍）
    """
    a, s = get("instant_step")
    med = s.get("pitchOscillationMedian")
    cov = s.get("pitchOscillationCoverage") or 0
    spans = s.get("pitchOscillationSpans") or []
    if med is not None and med > 0.3:
        return "瞬时阶跃振荡中位 %.3f 太高（闸门 2 失效？）" % med
    if cov > 0.3:
        return "瞬时阶跃覆盖率 %.0f%% 太高（闸门 2 失效？）" % (cov * 100)
    if spans:
        return "瞬时阶跃报了 %d 个振荡时段（闸门 2 失效？）" % len(spans)
    return True


check("过零率门槛有效", t_zc_gate)
check("阶跃闸门单独有效（瞬时阶跃）", t_instant_step_gate)
check("阶跃门槛有效", t_step_gate)
check("滑音单调性门槛有效", t_mono_gate)

# ══════════════════════════════════════════════════════
print()
print("=" * 72)
if failures:
    print("%d 项失败：" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("全部通过")
sys.exit(0)
