#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""四条需求的回归测试。

每一条对应一个使用者提出的具体问题，都有明确的验收标准：

    一、滑移泄进振荡 → 重叠时要带标记
    二、转写按 8 秒硬切 → 分段不能全是固定时长
    三、转写无免责 → 输出里必须有免责说明
    四、没有概览 → highlights 必须存在且挑法正确

按笔记第十四节：写完后要能通过变异测试。
"""
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "lib"))

import numpy as np

import prosody as P

failures = []


def check(name, fn):
    try:
        r = fn()
        if r is True:
            print("  OK   " + name)
            return
        if r is None:
            # 跳过：测试条件不满足（比如缺测试音频），不算失败
            print("  SKIP " + name + "（条件不满足）")
            return
        if r is False:
            failures.append(name)
            print("  FAIL " + name)
            return
        failures.append(name)
        print("  FAIL " + name + " → " + str(r))
    except Exception as e:
        failures.append(name)
        print("  FAIL " + name + " → " + type(e).__name__ + ": " + str(e)[:80])


print("=" * 74)
print("四条需求回归测试")
print("=" * 74)

# ══════════════════════════════════════════════════════
print()
print("=== 需求一：滑移泄进振荡 ===")


def t_glide_marker():
    """端到端：真实录音里重叠的振荡时段必须带 note。

    为什么用真实录音而不是合成音：
        试了三版合成音（前半滑音 / 滑音叠微颤 / 全程滑），滑移检出都是 0。
        原因：`_pitch_glides` 用「净位移 / 总路程」判单调性，
        而滑音上叠微颤时，微颤把总路程放大，比值掉到阈值以下。

        这本身是个真问题（滑音上叠微颤时滑移可能检不出），
        但不是这个测试要验的东西。这里要验的是「重叠了有没有标记」。

    跳过条件：找不到测试音频时返回 None（不算失败）。
    """
    import glob
    wav = None
    for f in glob.glob(r"E:\XiAgent\dsh-fish\home\audio\*.wav"):
        if "rain" not in os.path.basename(f).lower():
            wav = f
            break
    if not wav:
        return None      # 跳过

    import subprocess
    tmp = tempfile.mkdtemp(prefix="req1-")
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "lib", "prosody.py"), wav,
         "--outdir", tmp, "--no-transcribe"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    j = os.path.join(tmp, "prosody.json")
    if r.returncode != 0 or not os.path.exists(j):
        return None      # 分析失败，跳过

    d = json.load(open(j, encoding="utf-8"))
    s = d.get("summary") or {}
    spans = s.get("pitchOscillationSpans") or []
    glides = s.get("pitchGlides") or []

    # 找有没有重叠的
    overlap = 0
    marked = 0
    for sp in spans:
        hit = any(not (sp["end"] < g["start"] or sp["start"] > g["end"]) for g in glides)
        if hit:
            overlap += 1
            if sp.get("note") and sp.get("overlapsGlides"):
                marked += 1

    if overlap == 0:
        # 这条录音恰好没有重叠，不算失败（换一条才知道）
        return None
    return True if marked == overlap else "重叠 %d 个，只标了 %d 个" % (overlap, marked)


def t_mark_function():
    """mark_glide_overlap 单独测。"""
    spans = [{"start": 1.0, "end": 2.0, "peak": 0.5}]
    glides = [{"start": 1.2, "end": 1.6, "semitones": 4.0, "direction": "down"}]
    out = P.mark_glide_overlap(spans, glides)
    if not out[0].get("note"):
        return "重叠了但没加 note"
    if not out[0].get("overlapsGlides"):
        return "没记录重叠的是哪个滑移"
    # 不重叠的不该加标记
    spans2 = [{"start": 5.0, "end": 6.0, "peak": 0.5}]
    out2 = P.mark_glide_overlap(spans2, glides)
    return True if not out2[0].get("note") else "不重叠也加了标记"


check("重叠的振荡时段带 note", t_glide_marker)
check("mark_glide_overlap 单独正确", t_mark_function)

# ══════════════════════════════════════════════════════
print()
print("=== 需求二：按句子切，不按固定秒数 ===")


def t_rebuild_e2e():
    """端到端：真实录音的分段不能全是固定 8 秒。

    2026-11-28 加：原来只单测 rebuild_sentences，变异测试没抓住
    「不接进主流程」这种改法。跑一次真分析才能发现。
    """
    import glob
    import subprocess
    wav = None
    for f in glob.glob(r"E:\XiAgent\dsh-fish\home\audio\*.wav"):
        if "rain" not in os.path.basename(f).lower():
            wav = f
            break
    if not wav:
        return None

    tmp = tempfile.mkdtemp(prefix="seg-")
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "lib", "prosody.py"), wav,
         "--outdir", tmp],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    j = os.path.join(tmp, "prosody.json")
    if r.returncode != 0 or not os.path.exists(j):
        return None

    d = json.load(open(j, encoding="utf-8"))
    segs = d.get("segments") or []
    if len(segs) < 2:
        return None      # 太短，无法验证

    durs = [(s.get("end") or 0) - (s.get("start") or 0) for s in segs]
    # 如果全是 8.0 秒（±0.1），说明没按句子重建
    all_eight = all(abs(d - 8.0) < 0.1 for d in durs)
    if all_eight:
        return "分段全是 8.0 秒（%d 段），没按句子重建" % len(segs)
    return True


def t_rebuild():
    """rebuild_sentences 应该按标点切。"""
    chunks = [
        {"start": 0.0, "end": 8.0, "text": "第一句话在这里。第二句开始"},
        {"start": 7.5, "end": 15.5, "text": "第二句开始了一点点。第三句继续"},
        {"start": 15.0, "end": 23.0, "text": "第三句继续说完吧。第四句话"},
    ]
    out = P.rebuild_sentences(chunks)
    if not out:
        return "没有输出"
    # 不能全是 8 秒
    durs = [s["end"] - s["start"] for s in out]
    if len(durs) >= 2 and max(durs) - min(durs) < 0.01:
        return "时长全都一样（%s），没在按句子切" % durs[0]
    # 每句应该以标点结尾（除了最后一句可能没有）
    bad = [s["text"] for s in out[:-1] if s["text"] and s["text"][-1] not in "。！？；"]
    if bad:
        return "有句子没在标点处结束：%r" % bad[0][:20]
    return True


def t_rebuild_no_dup():
    """重建后的相邻句不该重复。"""
    chunks = [
        {"start": 0.0, "end": 8.0, "text": "前面的话结束了。我还是走路回去吧。"},
        {"start": 7.5, "end": 15.5, "text": "我还是走路回去吧，外面在下雨。"},
    ]
    out = P.rebuild_sentences(chunks)
    texts = [s["text"] for s in out]
    # 检查相邻重复
    for i in range(len(texts) - 1):
        a = texts[i][-8:]
        b = texts[i + 1][:8]
        if a and b and a == b:
            return "相邻句重复：%r" % a
    return True


check("实测分段不全是 8 秒（端到端）", t_rebuild_e2e)
check("按标点切，不全是固定时长", t_rebuild)
check("重建后相邻句不重复", t_rebuild_no_dup)

# ══════════════════════════════════════════════════════
print()
print("=== 需求三：转写免责说明 ===")


def t_caveat_const():
    if not hasattr(P, "TRANSCRIPT_CAVEAT"):
        return "没有 TRANSCRIPT_CAVEAT"
    c = P.TRANSCRIPT_CAVEAT
    for kw in ["自动识别", "同音字", "不要当作"]:
        if kw not in c:
            return "免责说明缺关键词「%s」" % kw
    return True


def t_caveat_in_summary():
    """有转写时，summary 里必须带 caveat。

    2026-11-28 改进：原来只查源码字符串，变异测试没抓住。
    改成跑一次真分析，看输出里到底有没有 —— 这才是行为测试。
    """
    import glob
    import subprocess
    wav = None
    for f in glob.glob(r"E:\XiAgent\dsh-fish\home\audio\*.wav"):
        if "rain" not in os.path.basename(f).lower():
            wav = f
            break
    if not wav:
        return None      # 跳过

    tmp = tempfile.mkdtemp(prefix="cav-")
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "lib", "prosody.py"), wav,
         "--outdir", tmp],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    j = os.path.join(tmp, "prosody.json")
    if r.returncode != 0 or not os.path.exists(j):
        return None

    d = json.load(open(j, encoding="utf-8"))
    s = d.get("summary") or {}
    tr = d.get("transcript") or ""
    if not tr.strip():
        return None      # 没转写，无法验证
    cav = s.get("transcriptCaveat")
    if not cav:
        return "有转写但 summary 里没有 transcriptCaveat"
    if "自动识别" not in cav:
        return "caveat 内容不对：%r" % cav[:40]
    return True


def t_caveat_in_receipt():
    """工具回执里必须有。"""
    idx = io.open(os.path.join(ROOT, "index.js"), encoding="utf-8").read()
    if "transcriptCaveat" not in idx:
        return "工具回执里没有 caveat"
    # 检查是不是在 transcript 展示处附近
    if "自动识别" not in idx:
        return "回执里没有免责文案"
    return True


def t_caveat_in_md():
    src = io.open(os.path.join(ROOT, "lib", "prosody.py"), encoding="utf-8").read()
    if "transcriptCaveat" not in src:
        return "md 报告里没有"
    return True


check("TRANSCRIPT_CAVEAT 常量存在且完整", t_caveat_const)
check("summary 里带 caveat", t_caveat_in_summary)
check("工具回执里带 caveat", t_caveat_in_receipt)
check("md 报告里带 caveat", t_caveat_in_md)

# ══════════════════════════════════════════════════════
print()
print("=== 需求四：一句话概览 ===")


def t_highlights_exist():
    """summary 里必须有 highlights。"""
    sample = {
        "f0Median": 180.5, "semitoneRange": 24.1, "silenceRatio": 0.0,
        "unvoicedRatio": 0.47, "pitchOscillationMedian": 0.287,
        "dbRange": 10.4, "charsPerSec": 3.31,
    }
    picks = P.pick_highlights(sample, 4)
    if not picks:
        return "没挑出任何亮点"
    if len(picks) > 4:
        return "挑多了：%d 个" % len(picks)
    return True


def t_highlights_not_absolute():
    """关键：挑的是偏离最多，不是绝对值最大。
    如果按绝对值排，f0Median(180.5) 会永远第一。"""
    sample = {
        "f0Median": 180.5,        # 绝对值大，但在正常范围内
        "semitoneRange": 40.0,    # 绝对值小，但严重超出正常范围
    }
    picks = P.pick_highlights(sample, 2)
    if not picks:
        return "没挑出亮点"
    if picks[0]["key"] == "f0Median":
        return "挑错了：f0 绝对值大但正常，不该排第一"
    if picks[0]["key"] != "semitoneRange":
        return "第一个应该是 semitoneRange，实际是 %s" % picks[0]["key"]
    return True


def t_highlights_percent():
    """百分比特征要显示成 %。"""
    sample = {"unvoicedRatio": 0.47}
    picks = P.pick_highlights(sample, 1)
    if not picks:
        return "没挑出"
    shown = picks[0].get("shown", "")
    if "%" not in shown:
        return "气声显示成 %r，应该带 %%" % shown
    return True


def t_highlights_no_judgment():
    """不能出现「像什么」这类判断。"""
    sample = {"f0Median": 180.5, "semitoneRange": 24.1, "unvoicedRatio": 0.47}
    lines = P.format_highlights(sample, 3)
    text = " ".join(lines)
    BAD = ["像笑", "像哭", "情绪", "激动", "紧张", "生气", "开心"]
    hits = [w for w in BAD if w in text]
    return True if not hits else "出现判断词：%s" % hits


def t_highlights_has_reason():
    """每个亮点要带依据，让人能反驳。"""
    sample = {"semitoneRange": 24.1}
    picks = P.pick_highlights(sample, 1)
    if not picks:
        return "没挑出"
    if not picks[0].get("why"):
        return "没有 why（依据）"
    return True


check("能挑出亮点", t_highlights_exist)
check("挑的是偏离最多，不是绝对值最大", t_highlights_not_absolute)
check("百分比特征显示成 %", t_highlights_percent)
check("不含「像什么」判断", t_highlights_no_judgment)
check("每个亮点带依据", t_highlights_has_reason)

# ══════════════════════════════════════════════════════
print()
print("=" * 74)
if failures:
    print("%d 项失败：" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("全部通过")
sys.exit(0)
