#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Auris Oculi 感知工具箱 — 说话人聚类。

给一个文件夹，算出每条音频的说话人嵌入，再聚类，回答"这批录音大致有几个人"。

不做身份识别：不说"这是谁"，只说"哪几条像"。结果要人看。
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

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac", ".wma", ".webm",
             ".mp4", ".mkv", ".mov", ".avi", ".flv", ".ts", ".m4v"}



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


def find_audio(root, exclude=None):
    """遍历音频。exclude 是输出目录，必须跳过——
    否则自己解码出来的 dec_*.wav 会被当成输入，重复聚类。"""
    found = []
    root_abs = os.path.abspath(root)
    excl_abs = os.path.abspath(exclude) if exclude else None
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过输出目录（以及它下面的所有东西）
        if excl_abs:
            cur = os.path.abspath(dirpath)
            if cur == excl_abs or cur.startswith(excl_abs + os.sep):
                dirnames[:] = []
                continue
        # 跳过 _work 这类中间目录
        dirnames[:] = [d for d in dirnames if d not in ("_work", "_cmp", "__pycache__")]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                full = os.path.join(dirpath, name)
                found.append((os.path.relpath(full, root), full))
    found.sort()
    return found


def to_wav16k(src, outdir, tag):
    """统一转 16k 单声道。"""
    dst = os.path.join(outdir, "dec_%s.wav" % tag)
    ff = P.find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg")
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", dst]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError("ffmpeg 解码失败")
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--seed", type=float, default=0.82)
    ap.add_argument("--merge", type=float, default=0.75)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    work = os.path.join(args.outdir, "_work")
    os.makedirs(work, exist_ok=True)

    files = find_audio(args.dir, exclude=args.outdir)
    print("[cluster] 找到 %d 个音频" % len(files), flush=True)
    if not files:
        raise SystemExit("这个文件夹里没有音频文件")

    enc = P.load_speaker_encoder()
    if enc is None:
        raise SystemExit("说话人模型不可用：" + (P._SPEAKER_ERROR or "未安装 resemblyzer"))

    records = []
    skipped = []
    for i, (rel, full) in enumerate(files):
        try:
            wav = to_wav16k(full, work, "%03d" % i)
            y, sr = P.read_wav(wav)
            dur = len(y) / sr
            if dur < 0.5:
                skipped.append({"file": rel, "reason": "太短（%.2f 秒）" % dur})
                continue
            emb, err = P.speaker_embedding(y, sr)
            if not emb:
                skipped.append({"file": rel, "reason": err or "嵌入失败"})
                continue
            records.append({"file": rel, "duration": round(dur, 2), "embedding": emb})
            print("[cluster] %d/%d %s  %.2fs" % (i + 1, len(files), rel, dur), flush=True)
        except Exception as e:
            skipped.append({"file": rel, "reason": str(e)[:100]})

    if not records:
        raise SystemExit("没有可用的音频")

    print("[cluster] 聚类 %d 条..." % len(records), flush=True)
    groups = P.cluster_speakers([r["embedding"] for r in records], args.seed, args.merge)

    out_groups = []
    for g in groups:
        out_groups.append({
            "size": g["size"],
            "cohesion": g["cohesion"],
            "files": [records[i]["file"] for i in g["members"]],
        })

    payload = {
        "dir": args.dir,
        "total": len(files),
        "analyzed": len(records),
        "skipped": skipped,
        "seed": args.seed,
        "merge": args.merge,
        "clusterCount": len(out_groups),
        "groups": out_groups,
    }
    jp = os.path.join(args.outdir, "clusters.json")
    json.dump(payload, open(jp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("[cluster] 已写 %s" % jp, flush=True)

    L = ["# 说话人聚类", "",
         "共 %d 条音频，聚成 **%d** 组。" % (len(records), len(out_groups)), "",
         "> 这只是在说「哪几条像」，不是「这是谁」。",
         "> 声音相近的人会被并到一起（实测 liuchanhg 与 zhaoquanyin 之间就有 0.717）。", "",
         "## 分组", ""]
    for i, g in enumerate(out_groups):
        coh = ("组内相似度 %.3f" % g["cohesion"]) if g["cohesion"] else "单条"
        L.append("### 组 %d（%d 条，%s）" % (i + 1, g["size"], coh))
        L.append("")
        for f in g["files"]:
            L.append("- `%s`" % f)
        L.append("")
    if skipped:
        L.append("## 跳过")
        L.append("")
        for s in skipped:
            L.append("- `%s`：%s" % (s["file"], s["reason"]))
        L.append("")
    mp = os.path.join(args.outdir, "clusters.md")
    open(mp, "w", encoding="utf-8").write("\n".join(L))
    print("[cluster] 已写 %s" % mp, flush=True)
    print("[cluster] done", flush=True)


if __name__ == "__main__":
    main()
