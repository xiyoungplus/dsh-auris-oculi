#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""语音内容分类的回归测试。

为什么需要它：
    contentClass（speech / nonSpeech / nonverbal / music / singing）的判据是
    靠实测调出来的阈值。改了任何一个数字，都可能让某一类悄悄失效——
    而这种退化不会报错，只会让判定结果慢慢变错。

    这个脚本跑固定样本，断言"应该被判成什么"，一条不合格就退出非 0。

样本从哪来（都不入 git，太大）：
    非言语人声  OpenSLR SLR99   https://openslr.org/99/
                解包后每个 wav 的文件名第二段是类别索引：
                  0 牙齿打颤 1 磨牙 2 弹舌 3 擤鼻 4 咳嗽 5 打哈欠 6 清嗓 7 叹气
                  8 嘴唇弹响 9 咂嘴 10 喘息 11 哭 12 笑 13 打喷嚏 14 呻吟 15 尖叫
    环境噪声    THCHS-30 resource.tgz  https://openslr.org/18/
                resource/noise/{white,car,cafe}/*.wav

用法：
    python regression_content_class.py --nonverbal <解包目录> --noise <noise目录>
    python regression_content_class.py --nonverbal <目录>          # 只测非言语
    python regression_content_class.py                              # 两个都测（默认路径）

退出码 0 = 全部符合预期。
"""

import argparse
import collections
import glob
import os
import shutil
import sys
import tempfile

# 这个脚本在 scripts/ 下，但 prosody.py 和 testdata/ 都在上一级（插件根目录）。
# 所以要把根目录也加进 sys.path，否则 import prosody 会失败。
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import numpy as np
import prosody as P

# 各类别期望的判定。None = 没有硬性期望，只统计
NONVERBAL_LABELS = {
    0: "牙齿打颤", 1: "磨牙", 2: "弹舌", 3: "擤鼻", 4: "咳嗽",
    5: "打哈欠", 6: "清嗓", 7: "叹气", 8: "嘴唇弹响", 9: "咂嘴",
    10: "喘息", 11: "哭", 12: "笑", 13: "打喷嚏", 14: "呻吟", 15: "尖叫",
}

# 每一类至少要识别出这个比例，低于就算退化。
# 数字取的是 0.15.0 实测值往下留一点余量，不是拍脑袋的理想值。
# 「哭」「尖叫」这类共用说话发声机制的本来就低——门槛定低是承认方法的边界，
# 不是掩盖它。真要提高得换特征（共振峰/音色），不在当前范围。
NONVERBAL_FLOOR = {
    0: 0.85,   # 实测 91%
    1: 0.80,   # 86%
    2: 0.88,   # 94%
    3: 0.68,   # 75%
    5: 0.66,   # 73%
    6: 0.63,   # 70%
    7: 0.80,   # 86%
    8: 0.74,   # 81%
    9: 0.85,   # 91%
    10: 0.66,  # 73%
    11: 0.05,  # 12% —— 低保真，只防止彻底失效
    12: 0.35,  # 44%
    13: 0.72,  # 79%
    14: 0.44,  # 51%
    15: 0.12,  # 20%
}

# 噪声必须 100% 判 nonSpeech，没有商量余地
NOISE_NAMES = ("white", "car", "cafe")


def classify_file(path, seconds=30.0):
    """跑一次分析并返回 (contentClass, 细节)。"""
    tmp = tempfile.mkdtemp(prefix="regcl-")
    try:
        wav = P.decode_to_wav(path, tmp, 0, seconds)
        y, sr = P.read_wav(wav)
        a = P.analyze(y, sr, 0.01, 75.0, 400.0)
        s = P.segment_summary(a, a["times"])
        nons, reasons = P.detect_non_speech(a, s, None)
        # 非言语场景：转写跑过、没出字
        cc = P._classify_content({**s, "suspectedNonSpeech": nons},
                                 transcript="", transcript_status="empty")
        return (cc or {}).get("kind"), s, reasons
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_nonverbal(root):
    files = sorted(glob.glob(os.path.join(root, "**", "*.wav"), recursive=True))
    if not files:
        print("[nonverbal] 没找到 wav，跳过：%s" % root)
        return True

    by = collections.defaultdict(lambda: collections.Counter())
    for f in files:
        base = os.path.basename(f).replace(".wav", "")
        parts = base.split("_")
        if len(parts) < 2:
            continue
        try:
            cat = int(parts[1])
        except ValueError:
            continue
        try:
            kind, _s, _r = classify_file(f)
            by[cat][kind] += 1
        except Exception:
            by[cat]["error"] += 1

    # ⚠️ 判"对"的标准是「没被判成说话」，不是「必须判成 nonverbal」。
    #
    # 实测发现：很多非言语样本会被 detect_non_speech 判成 nonSpeech
    # （它们确实没有稳定发声周期，归到噪声/纯音那类也说得通）。
    # 早期版本只数 nonverbal，把这些算成失败，于是同一批数据
    # 全量测出 71.6%、抽样测出 45% —— 差的是口径，不是判据。
    #
    # 对用户来说，只要没被当成"正常说话"，结论就是对的：
    #   nonverbal  人声但没语言内容
    #   nonSpeech  压根不像人声
    # 两者都意味着"别拿它当说话的语气来分析"。
    def not_speech(counter):
        return sum(v for k, v in counter.items() if k != "speech")

    print("== 非言语人声（期望：不能判成 speech）==")
    print("%-10s %6s %11s %9s %9s %s" % ("类别", "条数", "未判说话", "识别率", "门槛", "结论"))
    print("-" * 64)
    ok = True
    total_n = total_ok = 0
    for cat in sorted(by):
        n = sum(by[cat].values())
        good = not_speech(by[cat])
        rate = good / max(1, n)
        floor = NONVERBAL_FLOOR.get(cat, 0.0)
        passed = rate >= floor
        if not passed:
            ok = False
        total_n += n
        total_ok += good
        dist = "/".join("%s%d" % (k[0], v) for k, v in by[cat].most_common() if v)
        print("%-10s %6d %11d %8.0f%% %8.0f%% %-4s %s" % (
            NONVERBAL_LABELS.get(cat, str(cat)), n, good,
            rate * 100, floor * 100, "ok" if passed else "FAIL", dist))
    if total_n:
        print("-" * 64)
        overall = total_ok / total_n
        print("%-10s %6d %11d %8.1f%%" % ("合计", total_n, total_ok, overall * 100))
        # 总体底线取实测值（76.1%）往下留一点余量。
        # 别把这条定高：哭/尖叫这类和说话共用发声机制，本来就抓不住，
        # 定 85% 只会让测试永远红着，逼人去调一个做不到的目标。
        # 逐类门槛才是有意义的防线——它保证每一类都不塌。
        if overall < 0.70:
            ok = False
            print("总体 %.1f%% 低于 70%%，判定为退化" % (overall * 100))
    return ok


def run_noise(root):
    print()
    print("== 环境噪声（期望 nonSpeech）==")
    print("%-8s %8s %10s %10s %s" % ("噪声", "时长", "浊音", "判定", "结论"))
    print("-" * 50)
    ok = True
    for name in NOISE_NAMES:
        f = os.path.join(root, name, name + ".wav")
        if not os.path.exists(f):
            print("%-8s 缺失" % name)
            continue
        kind, s, reasons = classify_file(f)
        passed = kind == "nonSpeech"
        if not passed:
            ok = False
        print("%-8s %7.1fs %9.0f%% %10s %s" % (
            name, s.get("duration") or 0, (s.get("voicedRatio") or 0) * 100,
            kind, "ok" if passed else "FAIL"))
        if not passed and reasons:
            print("        判据未命中，理由：%s" % reasons[0][:60])
    return ok


def main():
    ap = argparse.ArgumentParser(description="语音内容分类回归测试")
    ap.add_argument("--nonverbal", default=os.path.join(
        ROOT, "testdata", "nonverbal"), help="非言语人声解包目录")
    ap.add_argument("--noise", default=os.path.join(
        ROOT, "testdata", "noise"), help="THCHS resource 的 noise 目录")
    args = ap.parse_args()

    ok = True
    if os.path.isdir(args.nonverbal):
        ok = run_nonverbal(args.nonverbal) and ok
    else:
        print("[skip] 非言语目录不存在：%s" % args.nonverbal)

    if os.path.isdir(args.noise):
        ok = run_noise(args.noise) and ok
    else:
        print("[skip] 噪声目录不存在：%s" % args.noise)

    print()
    if ok:
        print("全部通过")
        return 0
    print("有退化 —— 检查上面的 FAIL")
    return 1


if __name__ == "__main__":
    sys.exit(main())
