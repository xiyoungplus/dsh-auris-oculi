#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Auris Oculi 感知工具箱 — 单条音频的说话人分离（diarization）。

回答"这段录音里有几个人、各说了哪段"，而不是"这批文件里有几个人"。

做法（轻量版，只用 Resemblyzer）：
  1. 按非重叠 2 秒窗切（重叠窗会让相邻窗天然相似，实测会失效）
  2. 每窗算说话人嵌入
  3. 能量太低的窗（静音）跳过
  4. 聚类得到"有几个声音"
  5. 把相邻同簇的窗合并成段

实测记录（2026-11-23）：
  - 合成对话（我 / 别人 交替），非重叠 2 秒窗：同人 0.97，异人 0.44，窗级 100%
  - 换成 1.5 秒窗 + 0.5 秒重叠：跨人相邻窗相似度 0.85-0.92，比同人内部还高，
    整条并成一组——重叠是主因，不是模型差
  - 0.8 秒窗：嵌入不稳，我-我 0.686 / 我-别人 0.612，差 0.07，分不开

所以窗长和"不重叠"这两件事是关键，不是可调参数。
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


def to_wav16k(src, outdir):
    dst = os.path.join(outdir, "input.wav")
    ff = P.find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg")
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", dst]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError("ffmpeg 解码失败")
    return dst


def find_quiet_cuts(y, sr, window, min_gap=0.8):
    """在能量低的地方找候选切点（秒）。

    语音里两个人换话时通常有个短暂的能量低谷（换气/停顿）。
    这里用 0.25 秒帧的 RMS，找局部极小值，间隔至少 min_gap 秒。
    """
    frame = int(0.25 * sr)
    hop = int(0.05 * sr)
    rms = []
    times = []
    for s in range(0, len(y) - frame, hop):
        chunk = y[s:s + frame]
        rms.append(float(np.sqrt(np.mean(chunk ** 2))))
        times.append((s + frame / 2) / sr)
    if not rms:
        return []
    rms = np.array(rms)
    times = np.array(times)
    # 局部极小值
    cuts = []
    for i in range(2, len(rms) - 2):
        if rms[i] <= rms[i-1] and rms[i] <= rms[i+1] and rms[i] < np.percentile(rms, 30):
            t = float(times[i])
            if not cuts or (t - cuts[-1]) >= min_gap:
                cuts.append(t)
    return cuts


def build_boundaries(total_samples, sr, window, cut_points, snap=0.4):
    """按 window 切，但把每个边界吸附到最近的切点（容差 snap 秒）。

    返回 [(start_sample, end_sample), ...]。
    """
    win = int(window * sr)
    snap_n = int(snap * sr)
    cuts_n = [int(t * sr) for t in cut_points]
    bounds = []
    pos = 0
    min_win = int(0.85 * win)  # 吸附后窗不能短于原来的 85%
    while pos < total_samples:
        end = min(pos + win, total_samples)
        if end < total_samples - snap_n and cuts_n:
            near = [c for c in cuts_n if abs(c - end) <= snap_n and (c - pos) >= min_win]
            if near:
                end = min(near, key=lambda c: abs(c - end))
        bounds.append((pos, end))
        pos = end
    return bounds


def cluster_windows(Xn, seed_thr, merge_thr):
    """窗级聚类。Xn 是已归一化的嵌入。"""
    n = len(Xn)
    S = Xn @ Xn.T
    assigned = [-1] * n
    groups = []
    for i in range(n):
        if assigned[i] >= 0:
            continue
        g = [i]
        assigned[i] = len(groups)
        for j in range(i + 1, n):
            if assigned[j] >= 0:
                continue
            if S[i, j] >= seed_thr:
                g.append(j)
                assigned[j] = len(groups)
        groups.append(g)

    def cent(g):
        v = Xn[g].mean(axis=0)
        return v / (np.linalg.norm(v) + 1e-9)

    changed = True
    while changed and len(groups) > 1:
        changed = False
        cs = [cent(g) for g in groups]
        best = None
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                s = float(cs[i] @ cs[j])
                if s >= merge_thr and (best is None or s > best[0]):
                    best = (s, i, j)
        if best:
            _, i, j = best
            groups[i] += groups[j]
            del groups[j]
            changed = True
    return groups, S


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--window", type=float, default=None, help="窗长秒数（默认取配置，实测 1.5 以下不稳）")
    ap.add_argument("--seed", type=float, default=0.82)
    ap.add_argument("--merge", type=float, default=0.72)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    if args.window is None:
        args.window = cfg_num("XIYOUNG_SPEAKER_DIARIZE_WINDOW", 2.0)
    enc = P.load_speaker_encoder()
    if enc is None:
        raise SystemExit("说话人模型不可用：" + (P._SPEAKER_ERROR or "未安装 resemblyzer"))

    print("[diar] 解码音频", flush=True)
    wav = to_wav16k(args.source, args.outdir)
    y, sr = P.read_wav(wav)
    print("[diar] 时长 %.2f 秒" % (len(y) / sr), flush=True)

    win = int(args.window * sr)
    if len(y) < win * 2:
        raise SystemExit("音频太短（%.1f 秒），至少要 %.1f 秒才能分离"
                         % (len(y) / sr, args.window * 2))

    # 关键：窗边界如果正好落在两个人中间，那一窗的嵌入是混合的，
    # 归到哪一组都不对，还会污染质心。
    # 做法：先在能量低的地方找候选切点，再把窗边界吸附过去。
    # （实测：8.95 秒对话里窗 2-4s 跨了边界，导致最后两段被合并）
    cut_points = find_quiet_cuts(y, sr, args.window)
    print("[diar] 找到 %d 个候选切点" % len(cut_points), flush=True)

    print("[diar] 切窗（%.1f 秒，非重叠，边界吸附到能量谷）" % args.window, flush=True)
    boundaries = build_boundaries(len(y), sr, args.window, cut_points)
    wins = []
    starts = []
    energies = []
    for seg_start, seg_end in boundaries:
        chunk = y[seg_start:seg_end]
        if len(chunk) < int(0.6 * sr):
            continue
        rms = float(np.sqrt(np.mean(chunk ** 2)))
        starts.append(seg_start / sr)
        energies.append(rms)
        if rms < 0.005:
            wins.append(None)
            continue
        wins.append(enc.embed_utterance(chunk))
    # 窗长可能因吸附而变，记下每窗实际长度
    win_lengths = []
    for seg_start, seg_end in boundaries:
        if seg_end - seg_start >= int(0.6 * sr):
            win_lengths.append((seg_end - seg_start) / sr)

    valid = [(i, w) for i, w in enumerate(wins) if w is not None]
    print("[diar] 有效窗 %d / %d" % (len(valid), len(wins)), flush=True)
    if len(valid) < 2:
        raise SystemExit("有效音频太少（%d 个窗），分不出说话人" % len(valid))

    X = np.array([w for _, w in valid])
    Xn = X / np.linalg.norm(X, axis=1, keepdims=True)
    groups, S = cluster_windows(Xn, args.seed, args.merge)
    print("[diar] 聚类: %d 组" % len(groups), flush=True)

    # 把窗索引映射回簇号
    win_group = {}
    for gi, g in enumerate(groups):
        for local_i in g:
            win_group[valid[local_i][0]] = gi

    # 合并相邻同簇的窗成段
    segments = []
    cur = None
    for i in range(len(wins)):
        g = win_group.get(i)
        if g is None:
            if cur:
                segments.append(cur)
                cur = None
            continue
        t = starts[i]
        wlen = win_lengths[i] if i < len(win_lengths) else args.window
        if cur and cur["speaker"] == g:
            cur["end"] = round(t + wlen, 2)
        else:
            if cur:
                segments.append(cur)
            cur = {"speaker": g, "start": round(t, 2), "end": round(t + wlen, 2)}
    if cur:
        segments.append(cur)

    # 每组的平均凝聚度
    group_info = []
    for gi, g in enumerate(groups):
        if len(g) >= 2:
            vals = [S[a, b] for a in g for b in g if a < b]
            coh = round(float(np.mean(vals)), 4)
        else:
            coh = None
        group_info.append({
            "speaker": gi,
            "windows": len(g),
            "cohesion": coh,
            "seconds": round(len(g) * args.window, 2),
        })

    # 可信度判断：speakerCount 这个数字本身会骗人。
    #
    # 实测证据（2026-11-26）：
    #   用户用 CASIA 两个确实不同的人拼 29.6 秒对话（A/B 交替 4 轮，真实 8 段）
    #     → speakerCount = 1，整段并成一段
    #   本次复测用 DB008 两个不同的人拼 16.4 秒（A/B 交替 4 轮，真实 8 段）
    #     → 仍是 speakerCount = 1，cohesion 0.7682
    #
    # 直接看 8 个窗的完整相似度矩阵（偶数窗=A、奇数窗=B）：
    #
    #     同一个人内部（奇偶相同）  0.7937
    #     不同人之间（奇偶不同）    0.7492
    #     差值                     0.0445
    #
    # 整个矩阵的值都落在 0.65~0.88 这个窄带里。**不是聚类算法错了，
    # 是嵌入本身没有区分力**——这正是 speaker_compare 文档里写的各向异性，
    # raw 余弦普遍偏高，不同人也能到 0.75。
    #
    # 所以判据不能用 cohesion 的绝对值（0.7682 看着"挺高"，其实没意义），
    # 要用**对比度**：簇内均值 - 跨簇均值。差值小 = 矩阵分不开人。
    caveats = []
    confidences = [g["cohesion"] for g in group_info if g.get("cohesion") is not None]
    min_coh = min(confidences) if confidences else None

    # 对比度：同簇 vs 跨簇。这是判断"到底分没分开"的唯一可靠信号。
    contrast = None
    if len(groups) >= 2:
        within = [S[a, b] for g in groups for a in g for b in g if a < b]
        across = [S[a, b] for i2, g1 in enumerate(groups)
                  for g2 in groups[i2 + 1:] for a in g1 for b in g2]
        if within and across:
            contrast = float(np.mean(within) - np.mean(across))

    # 所有窗两两相似度的整体分布——用来判断"这批嵌入是不是挤在一起"
    all_pairs = [float(S[a, b]) for a in range(len(wins)) for b in range(a + 1, len(wins))]
    # S 是 float32 矩阵，直接取 min/max 会得到 numpy.float32，
    # json.dump 序列化不了（会抛 TypeError）。这里显式转成 Python float。
    pair_span = float(max(all_pairs) - min(all_pairs)) if all_pairs else 0.0
    pair_lo = float(min(all_pairs)) if all_pairs else 0.0
    pair_hi = float(max(all_pairs)) if all_pairs else 0.0

    if len(groups) == 1 and len(wins) >= 4:
        # 只有一个簇：要么真是一个人，要么聚类把所有人并了。
        # 无法从簇内 cohesion 判断（它总是高），只能看整体分布宽不宽。
        if pair_span < 0.25:
            caveats.append(
                "只分出 1 个说话人，但所有窗两两相似度只跨 %.2f（%.2f~%.2f），"
                "全都挤在一个窄带里。这很可能是「分不出来」而不是「真的只有一个人」——"
                "Resemblyzer 嵌入在短句/单声道低码率音频上区分力很差，"
                "实测里同人 0.79、不同人 0.75，差 0.04 就被淹没在噪声里。"
                "speakerCount 这时候不能当作「有几个人」的答案。"
                % (pair_span, pair_lo, pair_hi)
            )
    elif len(groups) >= 2:
        # 多簇的情况更要小心——它比"只分出一个人"更容易骗人。
        #
        # 实测反例：单人录音 chandou-speech.wav 被判成 2 个人，
        # pairSpan 0.4057（看着"分得很开"，其实只是分布本身宽），
        # 但 minCohesion 只有 0.6922 —— 第二簇是硬凑出来的。
        #
        # 所以多簇时两条都要看：
        #   1. 每一簇的 cohesion 够不够高（簇内真是同一个人）
        #   2. 同簇 vs 跨簇的对比度够不够大（簇间真的不同）
        weak = [g for g in group_info
                if g.get("cohesion") is not None and g["cohesion"] < 0.75]
        if weak:
            caveats.append(
                "分出 %d 个说话人，但有 %d 组组内相似度低于 0.75（最低 %s）——"
                "这些簇可能是硬凑出来的，人数很可能被高估。"
                "实测里单人录音会被判成 2 个人，就是这种情况。"
                % (len(groups), len(weak),
                   ("%.3f" % min(g["cohesion"] for g in weak)))
            )
        if contrast is not None and contrast < 0.05:
            caveats.append(
                "同簇比跨簇只高 %.3f——切分位置基本是随机的，"
                "segments 不可信。" % contrast
            )
        if min_coh is not None and min_coh > 0.92:
            caveats.append(
                "组内相似度高达 %.2f——簇内可能还混着不同的人，"
                "实际人数可能更多。" % min_coh
            )

    if len(y) / sr < 10.0:
        caveats.append(
            "音频只有 %.1f 秒，2 秒窗太少，切分点误差可能超过 ±1 秒。"
            % (len(y) / sr)
        )

    payload = {
        "source": args.source,
        "duration": round(len(y) / sr, 2),
        "window": args.window,
        "speakerCount": len(groups),
        # 显式告诉调用方这个数字可信到什么程度：
        "minCohesion": round(min_coh, 4) if min_coh is not None else None,
        # 同簇 vs 跨簇的相似度差。>0.1 才算真分开了
        "contrast": round(contrast, 4) if contrast is not None else None,
        # 所有窗两两相似度的跨度。窄 = 嵌入挤在一起，分不开人
        "pairSpan": round(pair_span, 4),
        "pairLo": round(pair_lo, 4),
        "pairHi": round(pair_hi, 4),
        "caveats": caveats,
        "groups": group_info,
        "segments": segments,
        "windows": [
            {
                "start": round(starts[i], 2),
                "end": round(starts[i] + args.window, 2),
                "speaker": win_group.get(i),
                "rms": round(energies[i], 4),
            }
            for i in range(len(wins))
        ],
    }
    jp = os.path.join(args.outdir, "diarization.json")
    json.dump(payload, open(jp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("[diar] 已写 %s" % jp, flush=True)

    # markdown
    L = ["# 说话人分离", "",
         "来源：`%s`" % args.source,
         "时长：%.1f 秒，窗长 %.1f 秒（非重叠）" % (payload["duration"], args.window),
         "", "共分出 **%d** 个声音。" % len(groups), "",
         "> 这不是「这是谁」——没有身份库，只是按声音相似度分组。",
         "> 声音相近的人可能被并成一个；说话人切换点附近会有误差（窗长 %.1f 秒）。" % args.window,
         "", "## 时间轴", ""]
    for seg in segments:
        L.append("- **%s** %.2fs – %.2fs（%.1fs）" % (
            "说话人 " + str(seg["speaker"] + 1), seg["start"], seg["end"],
            seg["end"] - seg["start"]))
    L.append("")
    L.append("## 每个说话人")
    L.append("")
    for g in group_info:
        coh = ("组内相似度 %.3f" % g["cohesion"]) if g["cohesion"] else "只有一个窗"
        L.append("- **说话人 %d**：%d 个窗（约 %.1f 秒），%s" % (
            g["speaker"] + 1, g["windows"], g["seconds"], coh))
    L.append("")
    mp = os.path.join(args.outdir, "diarization.md")
    open(mp, "w", encoding="utf-8").write("\n".join(L))
    print("[diar] 已写 %s" % mp, flush=True)
    print("[diar] done", flush=True)


if __name__ == "__main__":
    main()
