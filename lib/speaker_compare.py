#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两段音频的声纹比对。

回答一个问题：这两段录音，像不像同一个人？

为什么不直接给"像/不像"两个词：
    resemblyzer 的 256 维嵌入有明显**各向异性** —— 所有嵌入挤在同一个锥角里，
    原始余弦相似度天然偏高。实测本机 49 段音频：

        投影到平均方向的长度     0.604 ~ 0.926（均值 0.786）
        原始余弦 中位           0.585
        去中心余弦 中位         -0.081

    换句话说，拿两段毫不相干的声音去算原始余弦，很容易就拿到 0.7 以上，
    而那已经是旧阈值里"很可能是同一个人"的区间了。实测 29.4% 的配对被
    误判成"同一人"，去中心化后降到 5.5%。

    所以这个脚本同时给两个数：
      raw        原始余弦（和旧阈值 0.70/0.55 同一坐标系，便于对照历史结论）
      centered   去中心化余弦（用本批次自身的均值做中心，动态范围更大）

    并给一个**相对**判据：centered 在本批次分布里排第几。绝对阈值在
    "来源混杂"的数据上不可靠，排位比绝对值稳。

用法：
    python speaker_compare.py A.wav B.wav
    python speaker_compare.py A.wav B.wav --compare-with C.wav D.wav
    python speaker_compare.py A.wav B.wav --json-only
"""

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # lib/ 的上一级 = 插件根目录
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import prosody as P


def fmt(x, nd=4):
    return None if x is None else round(float(x), nd)


def compare(a_emb, b_emb):
    """一条配对的两个相似度。"""
    raw = P.cosine_similarity(a_emb, b_emb)
    return {"raw": fmt(raw), "centered": None}


def center(embs):
    """按本批次均值做去中心化。

    返回 (中心化后的矩阵, 中心向量)。批次里只有 2 条时，去中心化会让两者
    几乎正交——那不是"不像"，只是样本太少。所以少于 3 条时标记 unreliable。
    """
    M = np.asarray(embs, dtype=float)
    if len(M) < 3:
        return None, None
    C = M.mean(axis=0)
    return M - C, C


def centered_cos(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na <= 0 or nb <= 0:
        return None
    return float(a @ b / (na * nb))


def rank_in(values, target):
    """target 在 values 里排第几（0=最小，1=最大）。"""
    if not values or target is None:
        return None
    lo = sum(1 for v in values if v < target)
    return round(lo / max(1, len(values) - 1), 3)


def main():
    ap = argparse.ArgumentParser(description="两段音频的声纹比对")
    ap.add_argument("a", help="第一段音频")
    ap.add_argument("b", help="第二段音频")
    ap.add_argument("--extra", action="append", default=[],
                    help="额外加入比较的音频（可重复）。加了就一起做去中心化，判据更稳")
    ap.add_argument("--start", type=float, default=None, help="只取这一段：起点秒")
    ap.add_argument("--duration", type=float, default=None, help="只取这一段：长度秒")
    ap.add_argument("--backend", default=None,
                    choices=["resemblyzer", "campplus"],
                    help="说话人嵌入用哪个模型。不给就按配置"
                         "（XIYOUNG_SPEAKER_BACKEND，默认 auto）")
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    sources = [args.a, args.b] + list(args.extra)
    wavs = []
    tmpdirs = []
    try:
        for i, src in enumerate(sources):
            outdir = os.path.join(os.path.dirname(os.path.abspath(args.a)), "_cmp_%d" % i)
            os.makedirs(outdir, exist_ok=True)
            tmpdirs.append(outdir)
            wav = P.decode_to_wav(src, outdir, args.start, args.duration)
            wavs.append(wav)

        embs = []
        metas = []
        # 后端由配置决定（XIYOUNG_SPEAKER_BACKEND / XIYOUNG_SPEAKER_MODEL），
        # 也可以命令行 --backend 强制。所有音频必须用同一个后端——
        # 不同后端的维度不同（256 vs 192），混着算余弦没有意义。
        backend_want = getattr(args, "backend", None)
        backend_used = None
        for i, (src, wav) in enumerate(zip(sources, wavs)):
            y, sr = P.read_wav(wav)
            emb, backend, err = P.speaker_embedding_ex(y, sr, backend_want)
            if backend_used is None:
                backend_used = backend
            elif backend != backend_used:
                err = ("后端不一致（%s vs %s）——同一批比较必须用同一个模型"
                       % (backend_used, backend))
                emb = None
            dur = len(y) / float(sr) if sr else 0.0
            metas.append({"source": src, "duration": round(dur, 2),
                          "backend": backend, "error": err})
            embs.append(np.asarray(emb, dtype=float) if emb is not None else None)

        if embs[0] is None or embs[1] is None:
            payload = {"ok": False, "error": "说话人嵌入算不出来",
                       "backend": backend_used,
                       "detail": [m["error"] for m in metas]}
            print(json.dumps(payload, ensure_ascii=False))
            return 1

        # 原始余弦
        raw = P.cosine_similarity(embs[0], embs[1])

        # 去中心化：样本 >=3 才有意义
        valid = [e for e in embs if e is not None]
        centered_all = None
        if len(valid) >= 3:
            centered_all, _ = center([e for e in embs if e is not None])
        centered = centered_cos(centered_all[0], centered_all[1]) if centered_all is not None else None

        # 本批次里 centered 的排位
        rankpct = None
        all_pairs = []
        if centered_all is not None:
            n = len(centered_all)
            all_pairs = [centered_cos(centered_all[i], centered_all[j])
                         for i in range(n) for j in range(i + 1, n)]
            all_pairs = [v for v in all_pairs if v is not None]
            rankpct = rank_in(all_pairs, centered)

        # 绝对判据（沿用旧阈值坐标系，raw）—— 明确标注它偏宽松
        verdict_raw = P.speaker_verdict(raw, backend_used) if raw is not None else None

        # 相对判据：centered 在本批次里的位置
        # 样本太少时排位没有意义（n=4 只有 6 个配对，40% 和 50% 分不开），
        # 那种情况直接说"样本太少"，不要拿一个假精确的百分比唬人。
        if rankpct is None:
            verdict_rel = None
            rel_note = "参与比较的音频少于 3 条，去中心化不可靠；只看 raw，且要知道它偏宽松"
        elif len(all_pairs) < 10:
            verdict_rel = None
            rel_note = ("参与比较的音频只有 %d 条（%d 个配对），排位不够稳；"
                        "centered 的绝对值可参考下面的基准" % (len(valid), len(all_pairs)))
        elif rankpct >= 0.9:
            verdict_rel = "在本批次里排最前，最像的那一对"
            rel_note = None
        elif rankpct >= 0.7:
            verdict_rel = "在本批次里偏像"
            rel_note = None
        elif rankpct >= 0.3:
            verdict_rel = "在本批次里居中，不像也不明显"
            rel_note = None
        else:
            verdict_rel = "在本批次里偏不像"
            rel_note = None

        caveats = []
        short = [m for m in metas if m["duration"] < 1.0]
        if short:
            caveats.append("有音频不足 1 秒（%s），说话人嵌入区分力明显下降"
                           % ", ".join("%.2fs" % m["duration"] for m in short))
        # 时长门槛是实测出来的，不是拍的。
        # 同一段 29 秒真人录音，切成两半算同人相似度（CAM++）：
        #     1 秒 0.58   2 秒 0.56   4 秒 0.71   8 秒 0.88   12 秒 0.89
        # 4 秒以下明显偏低，8 秒才稳定。所以 3 秒以下要提示"结论可能过于悲观"。
        brief = [m for m in metas if 1.0 <= m["duration"] < 3.0]
        if brief:
            caveats.append("有音频只有 %s，实测这种长度下同人分数会明显偏低"
                           "（同一人 4 秒约 0.71、8 秒约 0.88），"
                           "所以判成「不像」时先别信，尽量给 4 秒以上"
                           % ", ".join("%.1fs" % m["duration"] for m in brief))
        if centered is None and len(valid) >= 3:
            caveats.append("去中心化失败，只给原始余弦")
        # 每个后端的 raw 坐标系完全不同，不能用同一套阈值理解：
        #   resemblyzer 各向异性严重，不同人也能到 0.5+，raw 普遍虚高
        #   campplus     基准被压低了，不同人通常在 0.1~0.4
        # 实测（CNEV 12 说话人）：resemblyzer 同人 0.74/异人 0.52，
        # campplus 同人 0.53/异人 0.26。所以提示必须分开写，否则会误导。
        if backend_used == "campplus":
            caveats.append("campplus 的 raw 基准比 resemblyzer 低："
                           "实测不同人通常在 0.1~0.4，同人 0.4~0.8。"
                           "别拿 resemblyzer 时代的 0.70 阈值来套这一组数字；"
                           "同来源配对仍然更可信")
        else:
            caveats.append("resemblyzer 嵌入有各向异性：raw 普遍偏高，别拿它和 0.70 硬比；"
                           "同来源（同一批录音/同一设备）的配对更可信，跨来源要谨慎")

        payload = {
            "ok": True,
            "backend": backend_used,
            "pair": [metas[0], metas[1]],
            "raw": raw,
            "centered": fmt(centered),
            "rankPercentile": rankpct if (all_pairs and len(all_pairs) >= 10) else None,
            "verdictRaw": verdict_raw,
            "verdictRelative": verdict_rel,
            "relativeNote": rel_note,
            "baseline": {
                "n": len(valid),
                "centeredMedian": fmt(float(np.median(all_pairs))) if all_pairs else None,
                "centeredP90": fmt(float(np.percentile(all_pairs, 90))) if all_pairs else None,
            },
            # 本后端的实测基准（CNEV 24 说话人 / 4 秒 / 同人=不同录音拼接）。
            # 给出来是为了让调用方知道"这个 raw 该往哪儿比"——
            # 光给一个 0.68 而不给参照系，等于让用户瞎猜。
            "reference": {
                "sameMean": 0.6876 if backend_used == "campplus" else 0.7720,
                "diffMean": 0.4041 if backend_used == "campplus" else 0.6457,
                "sameRange": [0.5022, 0.8822] if backend_used == "campplus" else [0.6344, 0.9733],
                "diffRange": [0.1166, 0.7239] if backend_used == "campplus" else [0.4072, 0.8066],
                "errorRate": 0.064 if backend_used == "campplus" else 0.195,
                "thresholds": P._SPEAKER_THRESHOLDS.get(backend_used),
                "note": "实测自 CNEV 24 说话人（每段 4 秒，同人=不同录音拼接）。"
                        + "同人/异人区间有重叠，所以这只是概率判断，不是确定结论。",
            },
            "caveats": caveats,
            "note": "raw = 原始余弦（旧阈值坐标系）；centered = 去中心化余弦；"
                    "rankPercentile 是 centered 在本批次所有配对里的排位",
        }

        if args.json_only:
            print(json.dumps(payload, ensure_ascii=False))
            return 0

        print("== 声纹比对 ==")
        print("  A: %s（%.1f 秒）" % (metas[0]["source"], metas[0]["duration"]))
        print("  B: %s（%.1f 秒）" % (metas[1]["source"], metas[1]["duration"]))
        print()
        print("  原始相似度 raw     : %s  (%s)" % (raw, verdict_raw))
        if centered is not None:
            print("  去中心化 centered  : %.4f" % centered)
            print("  本批次排位         : %.0f%%  (%s)" % (rankpct * 100, verdict_rel))
            print("  本批次基准         : 中位 %.4f / P90 %.4f（n=%d）"
                  % (payload["baseline"]["centeredMedian"],
                     payload["baseline"]["centeredP90"], payload["baseline"]["n"]))
        if caveats:
            print()
            for c in caveats:
                print("  ! " + c)
        return 0
    finally:
        # 清掉中间 wav
        for d in tmpdirs:
            try:
                import shutil
                shutil.rmtree(d, ignore_errors=True)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
