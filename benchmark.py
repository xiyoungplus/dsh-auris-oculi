#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Auris Oculi 感知工具箱 — 特征判别力评测。

回答一个问题：**这批数字到底能不能分开人/情绪？**

给一个带标签的文件夹（子目录名 = 标签），跑三个任务：

  1. 分标签（N 选 1）：给定一条，猜是哪个标签
  2. 判同标签（2 选 1）：给两条，判是不是同一标签
  3. 距离间隔：同标签 vs 异标签的平均距离

每个任务都给"随机基线"，方便判断到底有没有用。

**必须用平衡准确率**：同标签对和异标签对数量往往不平衡（比如 1:3），
"全判异标签"就能有 75%，那个数字不能看。

用法：
  python benchmark.py <dir> --label-from directory
  python benchmark.py <dir> --feature mfcc
"""

import argparse
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prosody as P  # noqa: E402

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac", ".wma",
             ".mp4", ".mkv", ".mov", ".avi"}



# ---------------------------------------------------------------------------
# 配置读取
#
# 所有默认值都不写死在代码里——Host 把生效配置注入成环境变量，
# 这里只负责读。没设就用内置兜底（和原来一样）。
#
# 这样换台机器不用改代码：改 config.json 或设环境变量即可。
# ---------------------------------------------------------------------------

def _env_num(name, default):
    """读数字环境变量，读不到或解析失败就用默认值。"""
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        v = float(raw)
        return int(v) if float(v).is_integer() and isinstance(default, int) else v
    except (TypeError, ValueError):
        return default


def _env_str(name, default):
    raw = os.environ.get(name)
    return default if raw is None or str(raw).strip() == "" else str(raw).strip()


def cfg_num(name, default):
    return _env_num(name, default)


def cfg_str(name, default):
    return _env_str(name, default)


def find_labeled(root, exclude=None):
    """遍历 <dir>/<标签>/*.wav，返回 [(标签, 路径)]。

    exclude 是输出目录，必须跳过——否则自己解码出来的 b_*.wav
    会被当成一个新标签（实测导致分标签准确率变成 0%）。
    """
    out = []
    root_abs = os.path.abspath(root)
    excl_abs = os.path.abspath(exclude) if exclude else None
    for dirpath, dirnames, filenames in os.walk(root):
        if excl_abs:
            cur = os.path.abspath(dirpath)
            if cur == excl_abs or cur.startswith(excl_abs + os.sep):
                dirnames[:] = []
                continue
        dirnames[:] = [d for d in dirnames if d not in ("_work", "_cmp", "__pycache__")]
        if os.path.abspath(dirpath) == root_abs:
            continue
        label = os.path.basename(dirpath)
        for name in filenames:
            if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                out.append((label, os.path.join(dirpath, name)))
    return sorted(out)


def to_wav16k(src, outdir, tag):
    dst = os.path.join(outdir, "b_%s.wav" % tag)
    ff = P.find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg")
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", dst]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError("ffmpeg 解码失败")
    return dst


def balanced_best(same, diff):
    """扫阈值找最佳平衡准确率。"""
    allv = np.concatenate([same, diff])
    best = (0.0, 0.0)
    for thr in np.percentile(allv, np.arange(2, 99, 1)):
        bal = (np.mean(same < thr) + np.mean(diff >= thr)) / 2
        if bal > best[0]:
            best = (bal, float(thr))
    return best


def evaluate(X, Y, names, metric):
    """返回三个任务的结果。metric 是 'cosine' 或 'euclid'。"""
    X = np.asarray(X, dtype=float)
    if metric == "cosine":
        Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
        D = 1 - Xn @ Xn.T
    else:
        mu = X.mean(axis=0)
        sd = X.std(axis=0)
        sd[sd < 1e-9] = 1.0
        Xs = (X - mu) / sd
        D = np.sqrt(((Xs[:, None, :] - Xs[None, :, :]) ** 2).sum(axis=2))

    labels = sorted(set(Y))
    n_lab = len(labels)

    # 任务1：分标签（留一最近邻）
    correct = 0
    for i in range(len(Y)):
        d = D[i].copy()
        d[i] = np.inf
        if Y[int(np.argmin(d))] == Y[i]:
            correct += 1
    acc1 = correct / len(Y)

    # 任务2：判同标签（平衡准确率）
    same, diff = [], []
    for i in range(len(Y)):
        for j in range(i + 1, len(Y)):
            (same if Y[i] == Y[j] else diff).append(D[i, j])
    same = np.array(same)
    diff = np.array(diff)
    bal, thr = balanced_best(same, diff) if len(same) and len(diff) else (0.0, 0.0)

    return {
        "n": len(Y),
        "labels": len(labels),
        "labelAcc": round(acc1 * 100, 1),
        "labelBaseline": round(100.0 / n_lab, 1),
        "sameBalanced": round(bal * 100, 1),
        "sameBaseline": 50.0,
        "sameMedian": round(float(np.median(same)), 4) if len(same) else None,
        "diffMedian": round(float(np.median(diff)), 4) if len(diff) else None,
        "gap": round(float(np.median(diff) - np.median(same)), 4) if len(same) and len(diff) else None,
        "bestThreshold": thr,
        "samePairs": len(same),
        "diffPairs": len(diff),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--feature", default="all",
                    choices=["all", "rhythm", "mfcc", "embedding"])
    ap.add_argument("--limit-per-label", type=int, default=40)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    work = os.path.join(args.outdir, "_work")
    os.makedirs(work, exist_ok=True)

    items = find_labeled(args.dir, exclude=args.outdir)
    print("[bench] 找到 %d 条带标签音频" % len(items), flush=True)
    if len(items) < 4:
        raise SystemExit("至少需要 4 条才能评测")

    # 每个标签限采样
    from collections import defaultdict
    by_label = defaultdict(list)
    for lab, f in items:
        by_label[lab].append(f)
    picked = []
    for lab in sorted(by_label):
        for f in by_label[lab][:args.limit_per_label]:
            picked.append((lab, f))
    print("[bench] 采样 %d 条，%d 个标签" % (len(picked), len(by_label)), flush=True)

    enc = None
    if args.feature in ("all", "embedding"):
        enc = P.load_speaker_encoder()
        if enc is None:
            print("[bench] 嵌入模型不可用，跳过该档", flush=True)

    rows = []
    for i, (lab, f) in enumerate(picked):
        try:
            wav = to_wav16k(f, work, "%04d" % i)
            y, sr = P.read_wav(wav)
            a = P.analyze(y, sr)
            s = P.segment_summary(a, a["times"])
            row = {
                "label": lab,
                "file": os.path.relpath(f, args.dir),
                "rhythm": [
                    s.get("f0Median") or 0,
                    s.get("semitoneRange") or 0,
                    s.get("trendSemitone") or 0,
                    s.get("jitterMedian") or 0,
                    s.get("voicedRatio") or 0,
                    s.get("dbMedian") or 0,
                ],
                "mfcc": [float(v) for v in P.mfcc_features(y, sr)],
                "embedding": None,
            }
            if enc is not None:
                row["embedding"] = [float(v) for v in enc.embed_utterance(y)]
            rows.append(row)
        except Exception as e:
            print("[bench] 跳过 %s：%s" % (f, str(e)[:80]), flush=True)
        if (i + 1) % 20 == 0:
            print("[bench] %d/%d" % (i + 1, len(picked)), flush=True)

    if len(rows) < 4:
        raise SystemExit("有效样本不足")

    Y = [r["label"] for r in rows]
    results = {}

    tiers = []
    if args.feature in ("all", "rhythm"):
        tiers.append(("rhythm", "韵律 6 维", "euclid"))
    if args.feature in ("all", "mfcc"):
        tiers.append(("mfcc", "MFCC 13 维", "euclid"))
    if args.feature in ("all", "embedding") and rows[0]["embedding"]:
        tiers.append(("embedding", "说话人嵌入 256 维", "cosine"))

    for key, label, metric in tiers:
        X = [r[key] for r in rows]
        res = evaluate(X, Y, label, metric)
        res["metric"] = metric
        results[key] = res
        print()
        print("=== %s ===" % label)
        print("  分标签（%d 选 1）: %.1f%%   （随机 %.1f%%）" % (
            res["labels"], res["labelAcc"], res["labelBaseline"]))
        print("  判同标签（2 选 1）: %.1f%%   （随机 50.0%%）" % res["sameBalanced"])
        print("  同标签距离 %.3f / 异标签 %.3f  差 %.3f" % (
            res["sameMedian"] or 0, res["diffMedian"] or 0, res["gap"] or 0))

    payload = {
        "dir": args.dir,
        "samples": len(rows),
        "labels": sorted(set(Y)),
        "results": results,
    }
    jp = os.path.join(args.outdir, "benchmark.json")
    json.dump(payload, open(jp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print()
    print("[bench] 已写 %s" % jp, flush=True)

    # markdown
    L = ["# 特征判别力评测", "",
         "样本 %d 条，%d 个标签。" % (len(rows), len(set(Y))), "",
         "> **判同标签必须看平衡准确率**：同标签对和异标签对数量常不平衡，",
         "> 只看总准确率会被「全判异标签」这种平凡策略骗到。", "",
         "| 特征 | 分标签 | 随机基线 | 判同标签（平衡） | 随机基线 | 距离差 |",
         "|---|---|---|---|---|---|"]
    for key, label, _m in tiers:
        r = results[key]
        L.append("| %s | %.1f%% | %.1f%% | %.1f%% | 50.0%% | %.3f |" % (
            label, r["labelAcc"], r["labelBaseline"], r["sameBalanced"], r["gap"] or 0))
    L.append("")
    L.append("## 判读")
    L.append("")
    L.append("- 分标签准确率**接近**随机基线 → 这个特征分不开")
    L.append("- 判同标签平衡准确率**接近 50%** → 没有判别力")
    L.append("- 距离差为**负**或接近 0 → 同标签和异标签分不开")
    L.append("")
    mp = os.path.join(args.outdir, "benchmark.md")
    open(mp, "w", encoding="utf-8").write("\n".join(L))
    print("[bench] 已写 %s" % mp, flush=True)
    print("[bench] done", flush=True)


if __name__ == "__main__":
    main()
