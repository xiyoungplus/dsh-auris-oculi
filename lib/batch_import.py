#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Auris Oculi 感知工具箱 — 批量导入语料。

遍历一个文件夹里的音频，逐条跑韵律分析，把特征和标签攒成对照表。
标签从目录名或文件名推出来，不用一条条手点。

认这三种摆法：

    <dir>/催/001.m4a            目录名就是标签
    <dir>/催-001.m4a            文件名前缀
    <dir>/001.m4a + labels.csv  CSV 里两列：文件名,标签

输出：<outdir>/batch.json（逐条特征）+ <outdir>/batch.md（汇总）
"""

import argparse
import csv
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # lib/ 的上一级 = 插件根目录
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
import prosody as P  # noqa: E402

# prosody 里的 _require_deps 会在它自己的 main 里跑；这里单独 import 时也要拦一次，
# 免得批量任务报一堆看不懂的 traceback。
try:
    import numpy  # noqa: F401
except ImportError:
    P._require_deps()

# 视频也算：批量导入只关心音轨，clip 出来的 mp4 和录屏都能直接丢进来
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


def read_csv_labels(path):
    """CSV 两列：文件名,标签。第一行有表头就跳过。"""
    out = {}
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            for i, row in enumerate(csv.reader(f)):
                if len(row) < 2:
                    continue
                name, label = row[0].strip(), row[1].strip()
                if not name or not label:
                    continue
                if i == 0 and (name.lower() in ("file", "filename", "文件名") or label.lower() in ("label", "标签")):
                    continue
                out[name] = label
                out[os.path.basename(name)] = label
    except OSError:
        pass
    return out


def guess_label(rel_path, root, csv_labels, mode):
    """按 mode 推标签。返回 (label, 来源说明)。"""
    base = os.path.basename(rel_path)
    stem = os.path.splitext(base)[0]
    parts = rel_path.replace("\\", "/").split("/")

    if mode in ("auto", "csv") and csv_labels:
        for key in (rel_path, base, stem):
            if key in csv_labels:
                return csv_labels[key], "csv"
        if mode == "csv":
            return None, "csv-miss"

    if mode in ("auto", "directory") and len(parts) > 1:
        # 用离文件最近的那层目录
        return parts[-2], "directory"

    if mode in ("auto", "filename"):
        for sep in ("-", "_", " "):
            if sep in stem:
                return stem.split(sep)[0], "filename"

    return None, "none"


def find_audio(root):
    found = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                full = os.path.join(dirpath, name)
                found.append((os.path.relpath(full, root), full))
    found.sort()
    return found


def decode(src, outdir):
    """统一转成 16k 单声道 wav。已经是 16k 单声道 wav 就直接用。"""
    ext = os.path.splitext(src)[1].lower()
    if ext == ".wav":
        try:
            import wave
            with wave.open(src, "rb") as w:
                if w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2:
                    return src
        except Exception:
            pass
    ff = P.find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg")
    dst = os.path.join(outdir, "decoded.wav")
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
           "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", dst]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError("ffmpeg 解码失败")
    return dst


def analyze_one(src, workdir, model_info=None, lang="zh"):
    os.makedirs(workdir, exist_ok=True)
    wav = decode(src, workdir)
    y, sr = P.read_wav(wav)
    a = P.analyze(y, sr)
    s = P.segment_summary(a, a["times"])
    # 有 SenseVoice 就顺手转写，批量跑的时候一次拿到所有文本
    transcript = None
    if model_info:
        try:
            text, segs = P.transcribe(wav, model_info[0], model_info[1], lang)
            if text:
                transcript = text
                s["transcript"] = text
                s["segments"] = P.attach_segments(segs, a, a["times"])
        except Exception:
            pass

    # 疑似非人声检测：噪声会被算成一堆看着正经的假数字，
    # 必须在这里标出来，否则会跟着批量结果一起进样本库。
    is_non_speech, reasons = P.detect_non_speech(a, s, transcript)
    s["suspectedNonSpeech"] = bool(is_non_speech)
    if is_non_speech:
        s["nonSpeechReasons"] = reasons
    return s


def write_markdown(path, records, by_label):
    L = []
    L.append("# 批量导入结果")
    L.append("")
    L.append("共 %d 条，%d 个标签。" % (len(records), len(by_label)))
    L.append("")
    # 三类排除原因分开统计，别混成一个"疑似非人声"
    def _kind(s):
        if s.get("suspectedNonSpeech"):
            return "nonSpeech"
        m = s.get("musicLike")
        if isinstance(m, dict) and (m.get("score") or 0) >= 2:
            return "music"
        if s.get("singingLike"):
            return "singing"
        return None

    non_speech = [r for r in records if _kind(r["summary"]) == "nonSpeech"]
    music_like = [r for r in records if _kind(r["summary"]) == "music"]
    singing_like = [r for r in records if _kind(r["summary"]) == "singing"]
    if non_speech:
        L.append("> ⚠ 有 **%d** 条疑似非人声（噪声被当成了人声）。"
                 "它们的数字不可信，导入标注池时会被自动跳过。" % len(non_speech))
        for r in non_speech:
            L.append("> - `%s`（标签 %s）" % (r["file"], r["label"]))
        L.append("")
    if music_like:
        L.append("> ⚠ 有 **%d** 条疑似音乐/旋律。不是说话，也会被跳过。" % len(music_like))
        for r in music_like:
            L.append("> - `%s`（标签 %s）" % (r["file"], r["label"]))
        L.append("")
    if singing_like:
        L.append("> ⚠ 有 **%d** 条疑似唱歌。确实是人声，但拿它当「说话语气」标注"
                 "会污染样本池，同样跳过。" % len(singing_like))
        for r in singing_like:
            L.append("> - `%s`（标签 %s）" % (r["file"], r["label"]))
        L.append("")
    L.append("## 按标签汇总（中位数）")
    L.append("")
    L.append("> 只统计可信样本；疑似非人声的已排除，否则中位数会被噪声带偏。")
    L.append("")
    L.append("| 标签 | 条数 | 基频 | 音域 | 走向 | 微颤 | 浊音占比 |")
    L.append("|---|---|---|---|---|---|---|")
    for label in sorted(by_label):
        rows = [r for r in by_label[label] if _kind(r["summary"]) is None]
        excluded = len(by_label[label]) - len(rows)
        if not rows:
            L.append("| %s | 0（%d 条已排除） | — | — | — | — | — |" % (
                label, excluded))
            continue
        def med(key):
            v = [r["summary"].get(key) for r in rows if r["summary"].get(key) is not None]
            return float(np.median(v)) if v else 0.0
        note = "（+%d 排除）" % excluded if excluded else ""
        L.append("| %s | %d%s | %.1f Hz | %.1f | %+.2f | %.2f | %.0f%% |" % (
            label, len(rows), note, med("f0Median"), med("semitoneRange"),
            med("trendSemitone"), med("jitterMedian"), med("voicedRatio") * 100))
    L.append("")
    L.append("## 逐条")
    L.append("")
    L.append("| 文件 | 标签 | 基频 | 音域 | 走向 | 微颤 | 浊音 | 文本 |")
    L.append("|---|---|---|---|---|---|---|---|")
    for r in records:
        s = r["summary"]
        txt = str(s.get("transcript") or "").replace("|", "\\|").replace("\n", " ")[:40]
        # 疑似非人声的整行标出来，别让这些数字被当成测量结果
        flag = ""
        k = _kind(s)
        if k == "nonSpeech":
            flag = "⚠ 疑似非人声 "
            txt = "（数字不可信）" + txt
        elif k == "music":
            flag = "⚠ 疑似音乐 "
            txt = "（不是说话）" + txt
        elif k == "singing":
            flag = "⚠ 疑似唱歌 "
            txt = "（人声但非说话）" + txt
        L.append("| %s | %s%s | %.1f | %.1f | %+.2f | %.2f | %.0f%% | %s |" % (
            r["file"], flag, r["label"], s.get("f0Median") or 0, s.get("semitoneRange") or 0,
            s.get("trendSemitone") or 0, s.get("jitterMedian") or 0,
            (s.get("voicedRatio") or 0) * 100, txt))
    L.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--label-from", default="auto",
                    choices=["auto", "directory", "filename", "csv"])
    ap.add_argument("--csv", default=None)
    ap.add_argument("--no-transcribe", action="store_true", help="跳过语音转文字")
    ap.add_argument("--lang", default="zh", help="转写语言，默认 zh")
    args = ap.parse_args()

    root = args.dir
    if not os.path.isdir(root):
        raise SystemExit("不是目录：" + root)

    csv_labels = {}
    if args.csv:
        csv_labels = read_csv_labels(args.csv)
    else:
        for cand in ("labels.csv", "label.csv", "labels.txt"):
            p = os.path.join(root, cand)
            if os.path.exists(p):
                csv_labels = read_csv_labels(p)
                print("[batch] 读到标签文件 %s（%d 条）" % (cand, len(csv_labels)), flush=True)
                break

    files = find_audio(root)
    print("[batch] 找到 %d 个音频" % len(files), flush=True)
    if not files:
        raise SystemExit(
            "这个文件夹里没有能分析的音频。\n"
            "支持的格式是 wav / mp3 / m4a / flac。"
        )

    os.makedirs(args.outdir, exist_ok=True)
    workdir = os.path.join(args.outdir, "_work")
    os.makedirs(workdir, exist_ok=True)

    model_info = None if args.no_transcribe else P.find_sensevoice_model()
    if model_info:
        print("[batch] 语音转写已启用（SenseVoice）", flush=True)
    elif not args.no_transcribe:
        print("[batch] 没找到 SenseVoice 模型，跳过转写", flush=True)

    records = []
    skipped = []
    for i, (rel, full) in enumerate(files):
        label, how = guess_label(rel, root, csv_labels, args.label_from)
        if not label:
            skipped.append(rel)
            continue
        try:
            s = analyze_one(full, workdir, model_info, args.lang)
            records.append({"file": rel, "label": label, "labelFrom": how, "summary": s})
            extra = ("  文本：" + s["transcript"][:40]) if s.get("transcript") else ""
            warn = "  ⚠ 疑似非人声" if s.get("suspectedNonSpeech") else ""
            print("[batch] %d/%d %s -> %s  f0=%s%s%s" % (
                i + 1, len(files), rel, label,
                ("%.1f" % s["f0Median"]) if s.get("f0Median") else "none", extra, warn), flush=True)
        except Exception as e:
            skipped.append(rel)
            print("[batch] %d/%d %s 失败：%s" % (i + 1, len(files), rel, e), flush=True)

    by_label = {}
    for r in records:
        by_label.setdefault(r["label"], []).append(r)

    payload = {
        "root": root,
        "labelFrom": args.label_from,
        "total": len(files),
        "analyzed": len(records),
        "skipped": skipped,
        "byLabel": {k: len(v) for k, v in by_label.items()},
        "records": records,
    }
    json_path = os.path.join(args.outdir, "batch.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print("[batch] 已写 %s" % json_path, flush=True)

    md_path = os.path.join(args.outdir, "batch.md")
    write_markdown(md_path, records, by_label)
    print("[batch] 已写 %s" % md_path, flush=True)
    print("[batch] done", flush=True)


if __name__ == "__main__":
    main()
