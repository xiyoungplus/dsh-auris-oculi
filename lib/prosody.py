#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Auris Oculi 感知工具箱 — 韵律分析（第二层）。

把一段音频拆成四组可量化的曲线，全部在本机算：

  1. 响度      RMS / dB（和第一层的 ffmpeg 结果对齐）
  2. 基频      pyin 追踪的 F0，附相对说话人自己的半音曲线
  3. 微颤      去趋势后的局部半音标准差（"抖"落在哪个字上）
  4. 清浊      浊音 / 清音（气声） / 静音 三分类

第一层只能分"响/不响"；气声和停顿在响度上都是"不响"，
靠基频的有无才能分开——这是这一层补上的第一块。
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import wave


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


def _require_deps():
    """缺依赖时给一句人话，而不是抛 ModuleNotFoundError。"""
    missing = []
    for mod, pip in (("numpy", "numpy"), ("librosa", "librosa"), ("soundfile", "soundfile")):
        try:
            __import__(mod)
        except ImportError:
            missing.append(pip)
    if missing:
        raise SystemExit(
            "缺少 Python 依赖：" + " ".join(missing) + "\n"
            "装一下：\n"
            "  python -m pip install " + " ".join(missing) + "\n"
            "如果用 DSH 自带的 Python：\n"
            "  %USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe -m pip install " + " ".join(missing)
        )

# 模块级 import 之前先检查一遍：numpy 缺失时直接给安装提示，
# 而不是抛一个 ModuleNotFoundError 让调用方去猜。
_require_deps()

import numpy as np
try:
    import scipy.signal as _sp_signal
except Exception:  # scipy 缺失时振荡测量降级为不可用
    _sp_signal = None  # noqa: E402



# ---------------------------------------------------------------------------
# 语音转文字（本机 SenseVoice）
#
# 韵律分析只给数字，看不出"这句话说了什么"。把转写接进来以后，
# 同一段音频能同时拿到：文本 + 每句的起止时间 + 那段时间的韵律数字，
# 其他会话调用时就能直接知道"哪一句是催的、抖在哪个字上"。
# ---------------------------------------------------------------------------

SENSEVOICE_DIRS = [
    os.path.join(os.path.expanduser("~"), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx"),
]


def find_sensevoice_model():
    """找本机已下载的 SenseVoice 模型。没有就返回 None（转写是可选的）。"""
    env = os.environ.get("XIYOUNG_SENSEVOICE_DIR")
    dirs = ([env] if env else []) + SENSEVOICE_DIRS
    for d in dirs:
        if not d:
            continue
        model = os.path.join(d, "model.int8.onnx")
        tokens = os.path.join(d, "tokens.txt")
        if os.path.exists(model) and os.path.exists(tokens):
            return model, tokens
    return None


PUNCT_ONLY = "。！？!?；;，,、…—-. \t\n\r"

# 音高突变的判据阈值（半音）。以前这个 6.0 写死在 detect_changes 里，
# 配置项 changes.pitchJumpSemitone 是个没人读的死键，现在接上。
PITCH_JUMP_SEMITONE = cfg_num("XIYOUNG_CHANGES_PITCH_JUMP_SEMITONE", 6.0)
# 换腔判定：偏移量落在 [MIN, MAX] 半音之间才算"换了个发声位置"。
# 以前是 4.0 <= |diff| <= 12.0 写死在 registerShifts 里，
# 配置项 changes.registerMaxSemitone 是个没人读的死键，现在接上。
REGISTER_MIN_SEMITONE = cfg_num("XIYOUNG_CHANGES_REGISTER_MIN_SEMITONE", 4.0)
REGISTER_MAX_SEMITONE = cfg_num("XIYOUNG_CHANGES_REGISTER_MAX_SEMITONE", 12.0)


def has_meaningful_text(t):
    """判断一段转写是不是"真的有人说话"。

    只看标点、空白、单个语气词都算没内容。
    实测纯音乐会被 SenseVoice 转成一个句号或"呜"，那不是语音。
    """
    if not t:
        return False
    core = "".join(ch for ch in str(t) if ch not in PUNCT_ONLY)
    if len(core) <= 1 and core in "呜哦啊嗯呃呀额":
        return False
    return len(core) >= 2


def transcribe(wav_path, model, tokens, language="zh"):
    """用 SenseVoice 转写，返回 (全文, 分段列表, 状态)。

    状态取值：
      ok          模型有输出，且内容有意义
      empty       模型跑了但没出任何字（纯音乐/噪声常见）
      punct       只出了标点或单个语气词（同上）
      no_model    模型不可用 / 导入失败，环境问题
      decode_fail 音频解码失败

    必须区分 empty 和 no_model：前者说明这段真没人说话，
    后者说明环境坏了。调用方靠这个状态判断，不该靠 transcript 是不是 None。
    """
    try:
        import sherpa_onnx
        import wave
        import numpy as np
    except ImportError:
        return None, [], "no_model"

    try:
        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model,
            tokens=tokens,
            num_threads=max(1, min(4, (os.cpu_count() or 4) // 2)),
            use_itn=True,
            debug=False,
            language=language,
        )
    except Exception:
        return None, [], "no_model"

    try:
        with wave.open(wav_path, "rb") as w:
            sr = w.getframerate()
            ch = w.getnchannels()
            raw = w.readframes(w.getnframes())
        y = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if ch > 1:
            y = y.reshape(-1, ch).mean(axis=1)
    except Exception:
        return None, [], "decode_fail"

    # 块长实测（单人解说 BV16G1FzPEZf，0-84 秒）：
    #   28 秒块  1.17 字/秒   ← 太粗，模型会"偷懒"只吐几个字
    #   20 秒块  0.82 字/秒   ← 最差
    #   10 秒块  3.74 字/秒
    #    8 秒块  3.75 字/秒   ← 最佳
    #    5-9 秒   3.5-3.6 字/秒
    # 块越小转写越完整，但太小会切断句子。8 秒是平衡点。
    # 重叠从 2 秒降到 0.5 秒——8 秒块重叠 2 秒等于重复 25%，没必要。
    CHUNK_SEC = cfg_num("XIYOUNG_AUDIO_CHUNK_SEC", 8.0)
    OVERLAP_SEC = cfg_num("XIYOUNG_AUDIO_OVERLAP_SEC", 0.5)
    chunk_n = int(CHUNK_SEC * sr)
    hop_n = int((CHUNK_SEC - OVERLAP_SEC) * sr)

    texts = []
    segments = []
    if len(y) <= chunk_n:
        starts = [0]
    else:
        starts = list(range(0, max(1, len(y) - chunk_n + 1), max(1, hop_n)))
        if starts and starts[-1] + chunk_n < len(y):
            tail = len(y) - chunk_n
            # 实测：末尾补块常常和上一块几乎完全重叠（只多出不到 1 秒），
            # 拼进来就是整段重复（"来台乌蒙地插钱刚好送到"重复了一遍）。
            # 只有当尾块能带来 >= 5 秒新内容时才补。
            if tail - starts[-1] >= int(5.0 * sr):
                starts.append(tail)
            else:
                # 补一小段覆盖到结尾：把最后一块的起点往后挪，凑够结尾
                starts[-1] = max(starts[-1], len(y) - chunk_n)

    for ci, st in enumerate(starts):
        chunk = y[st:st + chunk_n]
        if len(chunk) < sr * 0.3:
            continue
        try:
            stream = rec.create_stream()
            stream.accept_waveform(sr, chunk)
            rec.decode_stream(stream)
            result = stream.result
        except Exception:
            continue
        piece = (getattr(result, "text", None) or "").strip()
        if not piece:
            continue
        offset = st / sr
        # 重叠区去重：非首块时，找本块开头和上一块结尾的最长公共重叠
        # 实测动画视频里最后一块整段重复了上一块（"来台乌蒙地插钱刚好送到"），
        # 因为重叠 2 秒在语速快时能覆盖十几个字，原来的 8 字上限不够。
        if texts:
            prev = texts[-1]
            # 1) 本块开头和上块结尾重叠：找最长公共前缀
            max_cut = min(len(piece), len(prev), 20)
            for cut in range(max_cut, 0, -1):
                if prev.endswith(piece[:cut]):
                    piece = piece[cut:]
                    break
        # 2) 本块内部自我重复：8 秒块常出现同一句连说两次，
        #    因为切块点落在音节中间，模型把前后半句各转了一遍。
        #    这段必须放在 if texts 外面——第一块也会自我重复。
        #    注意不能用精确匹配（"…别的" vs "…别的。"只差句号），
        #    改用去标点后比较。
        import re as _re
        _punct = _re.compile(r"[。！？，、；：\s]")
        if len(piece) >= 8:
            pc = _punct.sub("", piece)
            cut_pos = None
            for sublen in range(len(pc) // 2, 3, -1):
                head = pc[:sublen]
                second = pc.find(head, sublen)
                if second > 0:
                    cnt = 0
                    for oi, och in enumerate(piece):
                        if not _punct.match(och):
                            if cnt == second:
                                cut_pos = oi
                                break
                            cnt += 1
                    if cut_pos:
                        piece = piece[:cut_pos]
                    break
        if not piece.strip():
            continue
        texts.append(piece)
        segments.append({"start": round(offset, 2),
                          "end": round(offset + len(chunk) / sr, 2),
                          "text": piece})
        if ci == 0:
            # 单块情况下沿用原来的 token 级时间戳细分
            pass

    # 全局去重：切块拼接后，末尾常有整段重复（尾块和上一块高度重叠）。
    # 实测："来台乌蒙地插钱刚好送到六七中学欢迎回"在全文里出现了两次。
    # 做法：检查最后一段，如果它的开头在全文靠前的位置已经出现过，砍掉。
    if len(segments) >= 2 and len(segments[-1]["text"]) >= 8:
        tail_text = segments[-1]["text"]
        head_of_tail = tail_text[:12]
        body = "".join(s["text"] for s in segments[:-1])
        pos = body.rfind(head_of_tail)
        if pos >= 0:
            # 尾段的开头在正文里出现过，说明是重复，删掉整段
            segments.pop()
            texts = [s["text"] for s in segments]

    # 纯标点段全部丢掉——比空着更危险的是给一个句号配上韵律数字，
    # 看上去像量过的。实测纯音乐段落返回 {"text": "。", "f0Median": 172.3, ...}。
    #
    # 顺序很重要：必须先用"过滤前"的状态判断，再过滤。
    # 之前写成先过滤再判断，text 已经成空串，("punct" if text else "empty")
    # 永远走 empty——README 列了 5 个状态，实际只能出现 4 个。
    raw_text = "".join(s.get("text") or "" for s in segments)
    if has_meaningful_text(raw_text):
        status = "ok"
    elif raw_text.strip():
        status = "punct"
    else:
        status = "empty"

    clean_segments = [s for s in segments if has_meaningful_text(s.get("text"))]
    dropped = len(segments) - len(clean_segments)
    if dropped:
        print("[prosody] 丢掉 %d 个纯标点/语气词段" % dropped, flush=True)
    segments = clean_segments
    texts = [s["text"] for s in segments]

    text = "".join(texts)
    if len(starts) > 1:
        return text, segments, status

    # 单块：沿用 token 级时间戳做更细的分段。
    # 关键：分块循环里已经把"整块"作为一个 segment 存进 segments 了（第 ~195 行），
    # 这里如果直接 append，整句会和细分的子句重复，拼起来就是全文说了两遍。
    # 实测 6 秒 sample：4 段 = 1 个整句 + 3 个细分句。
    # 所以先把整块那条清掉，只用 token 级细分重建。
    block_segments = list(segments)   # 保留一份，细分失败时兜底
    segments = []
    if starts:
        st0 = starts[0]
        chunk = y[st0:st0 + chunk_n]
        try:
            stream = rec.create_stream()
            stream.accept_waveform(sr, chunk)
            rec.decode_stream(stream)
            result = stream.result
        except Exception:
            return text, block_segments, status

    # 注意：这里不能立刻回填 block_segments——下面的 token 细分会往 segments 里 append，
    # 提前回填就等于把整块又放回去，重复照旧。回填留到细分做完之后。

    # sherpa-onnx 给的是 token 级时间戳，聚成句：遇到标点或停顿超过 0.4 秒就断句。
    stamps = getattr(result, "timestamps", None) or []
    toks = getattr(result, "tokens", None) or []
    if stamps and toks and len(stamps) == len(toks):
        buf = []
        start_t = None
        last_t = None
        for tok, ts in zip(toks, stamps):
            piece = str(tok)
            # 跳过 SenseVoice 的标签 token（<|zh|> 之类）
            if piece.startswith("<|"):
                continue
            if start_t is None:
                start_t = float(ts)
            if buf and last_t is not None and (float(ts) - last_t) > 0.4:
                segments.append({"start": round(start_t, 2), "end": round(last_t, 2), "text": "".join(buf)})
                buf = []
                start_t = float(ts)
            buf.append(piece)
            last_t = float(ts)
            if piece in "。！？!?；;，," and len(buf) >= 4:
                segments.append({"start": round(start_t, 2), "end": round(float(ts), 2), "text": "".join(buf)})
                buf = []
                start_t = None
        if buf and start_t is not None and last_t is not None:
            segments.append({"start": round(start_t, 2), "end": round(last_t, 2), "text": "".join(buf)})

    # 去掉纯标点的碎段（SenseVoice 常把句末标点单独吐出来）
    cleaned = []
    for seg in segments:
        t = str(seg.get("text", "")).strip()
        if not t:
            continue
        if all(ch in "。！？!?；;，,、…—-. " for ch in t):
            # 纯标点：并进上一段，不单独成条
            if cleaned:
                cleaned[-1]["text"] = str(cleaned[-1]["text"]).rstrip() + t
                cleaned[-1]["end"] = seg.get("end", cleaned[-1]["end"])
            continue
        cleaned.append(seg)
    final_text = text.strip()
    # 细分一条都没产出（比如整段只有一个字，凑不满断句条件）时，
    # 退回整块那条，不能返回空列表。
    if not cleaned:
        cleaned = block_segments
    # status 用上面基于 raw_text 的判断，不要在这里重算——
    # 重算会因为 cleaned 已过滤而退化。
    return final_text, cleaned, status


def attach_segments(segments, a, times):
    """给每个转写分段补上那段时间的韵律数字，让文本和"抖"对得上。"""
    if not segments:
        return []
    f0 = a["f0"]
    st = a["semitone"]
    jt = a["pitchOscillation"]
    db = a["db"]
    out = []
    for seg in segments:
        lo, hi = seg["start"], seg["end"]
        m = (times >= lo) & (times <= hi)
        item = dict(seg)
        if m.any():
            seg_f0 = f0[m]
            seg_f0 = seg_f0[~np.isnan(seg_f0)]
            item["f0Median"] = round(float(np.median(seg_f0)), 1) if len(seg_f0) else None
            seg_st = st[m]
            seg_st = seg_st[~np.isnan(seg_st)]
            item["semitoneMedian"] = round(float(np.median(seg_st)), 2) if len(seg_st) else None
            seg_jt = jt[m]
            seg_jt = seg_jt[~np.isnan(seg_jt)]
            item["pitchOscillationMedian"] = round(float(np.median(seg_jt)), 3) if len(seg_jt) else None
            item["pitchOscillationMax"] = round(float(np.max(seg_jt)), 3) if len(seg_jt) else None
            item["dbMedian"] = round(float(np.median(db[m])), 1) if m.any() else None
        out.append(item)
    return out


def find_ffmpeg():
    env = os.environ.get("XIYOUNG_FFMPEG")
    if env and os.path.exists(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    for p in (r"C:\ProgramData\chocolatey\bin\ffmpeg.exe", r"C:\ffmpeg\bin\ffmpeg.exe"):
        if os.path.exists(p):
            return p
    return None


def find_ytdlp():
    env = os.environ.get("XIYOUNG_YTDLP")
    if env and os.path.exists(env):
        return env
    found = shutil.which("yt-dlp")
    if found:
        return found
    base = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Python")
    try:
        for version in os.listdir(base):
            cand = os.path.join(base, version, "Scripts", "yt-dlp.exe")
            if os.path.exists(cand):
                return cand
    except OSError:
        pass
    return None


def looks_remote(source):
    s = str(source or "").strip().lower()
    return s.startswith("http://") or s.startswith("https://")


def fetch_remote(source, outdir, start=None, duration=None):
    """链接先交给 yt-dlp 抓成本地文件。ffmpeg 打不开网页。

    只要音频，不下载视频轨——韵律分析用不上画面，而且快得多。
    带了 start/duration 时用 yt-dlp 的 --download-sections 只抓那一段。
    """
    ytdlp = find_ytdlp()
    if not ytdlp:
        raise SystemExit("这是链接，需要 yt-dlp 才能抓下来；本机没找到 yt-dlp，可以改用本地文件路径")
    pattern = os.path.join(outdir, "source.%(ext)s")
    cmd = [ytdlp, "-f", "ba/b", "--no-playlist", "--no-warnings",
           "-o", pattern, "--print", "after_move:filepath"]
    if start is not None and start > 0:
        end = start + duration if (duration is not None and duration > 0) else None
        section = "*%s-%s" % (start, end) if end is not None else "*%s-inf" % start
        cmd += ["--download-sections", section, "--force-keyframes-at-cuts"]
    cmd.append(source)
    print("[prosody] 抓取链接音频", flush=True)
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        detail = (res.stderr or "").strip().splitlines()[-4:]
        raise SystemExit("yt-dlp 抓取失败：" + " ".join(detail))
    produced = [os.path.join(outdir, f) for f in os.listdir(outdir)
                if f.startswith("source.") and not f.endswith(".part")]
    if not produced:
        raise SystemExit("yt-dlp 跑完了但没找到下载的文件")
    return produced[0]


def decode_to_wav(source, outdir, start=None, duration=None):
    """用 ffmpeg 统一解码成 16kHz 单声道 wav，后面所有分析都用它。"""
    ff = find_ffmpeg()
    if not ff:
        raise SystemExit("找不到 ffmpeg，请装 ffmpeg 或设置 XIYOUNG_FFMPEG")

    # 链接先落地：ffmpeg 只会读文件，读不了网页。
    # 已经抓好的话（--start/--duration 由 yt-dlp 精确切过），这里不再切第二遍。
    seek_start, seek_duration = start, duration
    if looks_remote(source):
        source = fetch_remote(source, outdir, start, duration)
        seek_start, seek_duration = None, None

    target = os.path.join(outdir, "decoded.wav")
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-y"]
    if seek_start is not None and seek_start > 0:
        cmd += ["-ss", str(seek_start)]
    cmd += ["-i", source]
    if seek_duration is not None and seek_duration > 0:
        cmd += ["-t", str(seek_duration)]
    cmd += ["-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", target]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0 or not os.path.exists(target):
        detail = (res.stderr or "").strip().splitlines()[-3:]
        raise SystemExit("ffmpeg 解码失败：" + " ".join(detail))
    return target


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    y = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        y = y.reshape(-1, ch).mean(axis=1)
    return y, sr


def median_smooth(f0, k=5, limit=3.0):
    """对基频做中值平滑：把偏离邻域中位数超过 limit 个半音的孤立点拉回去。"""
    out = f0.copy()
    n = len(f0)
    for i in range(n):
        if np.isnan(f0[i]):
            continue
        lo, hi = max(0, i - k), min(n, i + k + 1)
        seg = f0[lo:hi]
        seg = seg[~np.isnan(seg)]
        if len(seg) < 3:
            continue
        med = float(np.median(seg))
        if med <= 0:
            continue
        if abs(12.0 * np.log2(f0[i] / med)) > limit:
            out[i] = med
    return out


def track_pitch(y, sr, hop, n_fft, fmin, fmax):
    """双路基频追踪：pyin 为主，YIN 兜底。

    单用 pyin 有个实测的坑：某些说话人（CASIA 里的 wangzhe）整段返回 0 个
    有声帧，音频本身却完全正常（峰值 0.49、RMS 0.054）。换任何音域参数都救
    不回来，但 YIN 在同一文件上给出 137.8Hz，与频谱峰 141/148Hz 吻合。
    所以两路都跑，pyin 没帧的地方用 YIN 补。
    """
    import librosa

    f0, _voiced_flag, voiced_prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr,
        frame_length=n_fft, hop_length=hop, fill_na=np.nan,
    )
    f0 = np.asarray(f0, dtype=float)

    # 覆盖率太低就补 YIN。阈值取 0.25：正常语音浊音占比远高于它。
    voiced_ratio = float(np.mean(~np.isnan(f0))) if len(f0) else 0.0
    if voiced_ratio < 0.25:
        try:
            fy = librosa.yin(y, fmin=fmin, fmax=fmax, sr=sr,
                             frame_length=n_fft, hop_length=hop)
            fy = np.asarray(fy, dtype=float)
            fy = np.where((fy >= fmin) & (fy <= fmax), fy, np.nan)
            n = min(len(f0), len(fy))
            merged = f0[:n].copy()
            fill = np.isnan(merged) & ~np.isnan(fy[:n])
            merged[fill] = fy[:n][fill]
            f0 = merged
        except Exception:
            pass
    return f0, voiced_prob


def fix_ceiling(f0, fmax, ratio=0.94, window=12):
    """修掉"贴着上限"的失控段。

    pyin 在噪声/气声段会一路猜成接近 fmax 的值（实测 498.9Hz 卡住 15 帧）。
    这种段不是基频，按邻域里偏低的那部分重建：取邻域内已确认值的 25 分位，
    再折到 fmax 的一半以下，避免把真高音也压掉。
    """
    out = f0.copy()
    n = len(f0)
    ceiling = fmax * ratio
    bad = (~np.isnan(f0)) & (f0 >= ceiling)
    if not bad.any():
        return out
    for i in range(n):
        if not bad[i]:
            continue
        lo, hi = max(0, i - window), min(n, i + window + 1)
        neigh = f0[lo:hi]
        neigh = neigh[(~np.isnan(neigh)) & (neigh < ceiling)]
        if len(neigh) >= 3:
            out[i] = float(np.percentile(neigh, 25))
        else:
            out[i] = np.nan
    return out


def fix_global_octave(f0, hi_hz=260.0, ratio=0.35):
    """整段被抬高一个八度时，把整段降回来。

    成人说话基频极少长期高于 260Hz。若中位已超过它，且"降一个八度"后的
    区间里也有可观数量的帧（说明不是偶然的高音），就判定为整体八度错误。
    """
    voiced = f0[~np.isnan(f0)]
    if len(voiced) < 20:
        return f0
    med = float(np.median(voiced))
    if med <= hi_hz:
        return f0
    lowered = voiced / 2.0
    # 降八度后落在合理人声区间（75-260Hz）的比例
    in_range = np.mean((lowered >= 75.0) & (lowered <= 260.0))
    if in_range >= ratio:
        return f0 / 2.0
    return f0


def fix_octaves(f0, window=9, tol=4.0):
    """八度校正：pyin 偶尔把一帧判成 2x 或 0.5x。

    逐帧看邻域（不含自己）的中位基频，若当前值偏离超过 tol 个半音，
    就在 {f0, 2*f0, 0.5*f0} 里挑最接近邻域中位的那个。
    """
    out = f0.copy()
    n = len(f0)
    for i in range(n):
        if np.isnan(f0[i]) or f0[i] <= 0:
            continue
        lo, hi = max(0, i - window), min(n, i + window + 1)
        neigh = np.concatenate([f0[lo:i], f0[i + 1:hi]])
        neigh = neigh[~np.isnan(neigh)]
        if len(neigh) < 4:
            continue
        ref = float(np.median(neigh))
        if ref <= 0:
            continue
        cands = [f0[i], f0[i] * 2.0, f0[i] * 0.5]
        best = f0[i]
        best_d = abs(12.0 * np.log2(f0[i] / ref))
        for c in cands[1:]:
            d = abs(12.0 * np.log2(c / ref))
            if d < best_d:
                best, best_d = c, d
        if best_d <= tol:
            out[i] = best
    return out


def spectral_features(y, sr, hop, n_fft=2048):
    """逐帧频谱特征——比韵律特征更能区分情绪的那几维。

    为什么加这个：
        现在的 18 个汇总特征全是「音高/能量/浊音」这一类。用 CNEV 的 1,485 条
        情绪发声实测（1-NN 留一法，5 类情绪）：

            插件现有 5 维韵律        57.2%（随机 20.6%）
            openSMILE 62 维声学      81.3%（随机 22.8%）

        差的 24 个百分点主要来自**频谱形状**——同样是"大声说话"，
        愤怒是"尖锐紧绷"（高频多），悲伤是"闷"（高频少）。只看音量和音高
        分不开这两者，看频谱形状可以。

    选这四维的理由（都不用 LPC 求根，鲁棒）：
        centroid  频谱质心       —— 声音的"亮度"，愤怒/恐惧偏高
        rolloff   85% 滚降点     —— 高频能量边界
        flatness  频谱平坦度     —— 噪声性 vs 谐波性，气声/嘶吼会升高
        hnr       谐噪比         —— 嗓音沙哑度，用自相关估计

    ⚠️ 没有用共振峰 F1/F2。代码里 extract_formants 那份注释写得很清楚：
    1-3 秒短句上 LPC 求根不稳定（同一人 F1 从 349 跳到 1736），已实测失败。
    频谱统计比共振峰鲁棒得多，不需要解多项式。

    返回 dict，每个值是逐帧数组（和 f0 等长）。
    """
    import librosa

    n_frames = len(y) // hop + 1
    centroid = np.full(n_frames, np.nan)
    rolloff = np.full(n_frames, np.nan)
    flatness = np.full(n_frames, np.nan)
    hnr = np.full(n_frames, np.nan)
    if n_frames == 0:
        return {"centroid": centroid, "rolloff": rolloff,
                "flatness": flatness, "hnr": hnr}

    # 预加重，和共振峰那边保持一致（提升高频，补偿声门波倾斜）
    pre = np.append(y[0], y[1:] - 0.97 * y[:-1]) if len(y) > 1 else y

    S = np.abs(librosa.stft(pre, n_fft=n_fft, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    n = min(n_frames, S.shape[1])

    if n > 0:
        centroid[:n] = librosa.feature.spectral_centroid(
            S=S, sr=sr, freq=freqs)[0][:n]
        rolloff[:n] = librosa.feature.spectral_rolloff(
            S=S, sr=sr, freq=freqs, roll_percent=0.85)[0][:n]
        flatness[:n] = librosa.feature.spectral_flatness(S=S)[0][:n]

    # HNR：用归一化自相关在基频周期处的峰值估计。
    # 浊音帧自相关在周期处有明显峰（HNR 高），气声/噪声帧没有（HNR 低）。
    for i in range(n):
        start = i * hop
        frame = y[start:start + n_fft]
        if len(frame) < n_fft:
            break
        frame = frame - frame.mean()
        e = float(np.dot(frame, frame))
        if e < 1e-10:
            continue
        # FFT 算自相关，比直接卷积快
        nfft2 = 1 << int(np.ceil(np.log2(2 * n_fft - 1)))
        spec = np.fft.rfft(frame, n=nfft2)
        ac = np.fft.irfft(spec * np.conj(spec), n=nfft2)[:n_fft]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        # 在 60-500Hz 对应的滞后范围里找峰
        lo = max(1, int(sr / 500.0))
        hi = min(n_fft - 1, int(sr / 60.0))
        if hi <= lo:
            continue
        peak = float(np.max(ac[lo:hi]))
        peak = min(peak, 0.999999)
        # 换算成 dB：r = HNR/(1+HNR)
        hnr[i] = float(10.0 * np.log10(max(peak, 1e-6) / max(1.0 - peak, 1e-6)))

    return {"centroid": centroid, "rolloff": rolloff,
            "flatness": flatness, "hnr": hnr}


def loudness_envelope(db, hop_s=0.01, win_sec=0.5):
    """音强包络的起伏特征——"这句话是一口气平推，还是忽高忽低"。

    为什么加：
        音域回答"音高变化多大"，频谱回答"音色亮不亮"，但两者都不回答
        "音量怎么起伏"。实测里这恰恰是区分语气最直观的一维：
        催促是急促起伏，敷衍是平推，激动是大起大落。

    做法：
        把 dB 曲线按 win_sec 切成小段，算每段的均值和标准差，
        再看这些段均值之间的波动。全部在已有数据上算，不需要重解码。

    返回（都只统计有声段，静音不参与）：
        dbRange      有声段音量的 P90-P10（动态范围，dB）
        dbStd        有声段 dB 的标准差
        dbSwing      段均值之间的标准差（慢变化，反映"整体起伏"）
        dbJitter     段内标准差的均值（快变化，反映"抖动"）
    """
    db = np.asarray(db, dtype=float)
    if len(db) == 0:
        return {}
    # 只留有声段：低于 -60dB 的当静音（和 state 的判据独立，这里保守）
    sounding = db[db > -60.0]
    if len(sounding) < 5:
        return {}
    out = {
        "dbRange": float(np.percentile(sounding, 90) - np.percentile(sounding, 10)),
        "dbStd": float(np.std(sounding)),
    }
    # 按窗口切段算慢/快变化
    win = max(3, int(round(win_sec / max(hop_s, 1e-6))))
    means = []
    stds = []
    for i in range(0, len(db) - win, win):
        seg = db[i:i + win]
        seg = seg[seg > -60.0]
        if len(seg) < max(3, win // 3):
            continue
        means.append(float(np.mean(seg)))
        stds.append(float(np.std(seg)))
    if len(means) >= 3:
        out["dbSwing"] = float(np.std(means))
        out["dbJitter"] = float(np.mean(stds))
    return out


def speaking_rate(segments, duration):
    """语速——每秒多少字。

    需要转写结果（逐句带起止时间）。没有转写就返回空。
    只统计"有实际文字"的句子，纯标点不算。

    为什么加：
        语速是"急不急"最直接的指标。同样一句话，催的时候快，敷衍的时候慢。
        而且它不依赖任何声学模型，纯粹是数出来的，可信度高。

    返回：
        charsPerSec   每秒字符数（中文字符 + 英文单词粗略折算）
        speechDensity 有字时间 / 总时长（"说话占了多少时间"）
        segmentCount  句子数
        avgSegmentSec 平均每句时长
    """
    if not segments or not duration or duration <= 0:
        return {}
    total_chars = 0
    speaking_sec = 0.0
    used = 0
    for sg in segments:
        try:
            a = float(sg.get("start", 0))
            b = float(sg.get("end", 0))
        except Exception:
            continue
        txt = str(sg.get("text") or "")
        # 中文字按字算，英文按 1.5 字/词粗算（避免"hello"算成 5 字）
        cn = sum(1 for ch in txt if "\u4e00" <= ch <= "\u9fff")
        en_words = len([w for w in txt.split() if any(c.isalpha() for c in w)])
        chars = cn + int(en_words * 1.5)
        if chars < 1:
            continue
        total_chars += chars
        speaking_sec += max(0.0, b - a)
        used += 1
    if used < 1 or speaking_sec <= 0:
        return {}
    return {
        "charsPerSec": float(total_chars / speaking_sec),
        "speechDensity": float(min(1.0, speaking_sec / duration)),
        "segmentCount": used,
        "avgSegmentSec": float(speaking_sec / used),
    }


def analyze(y, sr, hop_s=0.01, fmin=75.0, fmax=400.0):
    """返回逐帧的曲线表。帧率由 hop_s 决定（默认 100 帧/秒）。"""
    import librosa

    hop = max(1, int(round(sr * hop_s)))
    n_fft = 2048

    f0, voiced_prob = track_pitch(y, sr, hop, n_fft, fmin, fmax)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)

    rms = librosa.feature.rms(y=y, frame_length=n_fft, hop_length=hop)[0]
    rms = np.pad(rms, (0, max(0, len(times) - len(rms))), mode="edge")[: len(times)]
    peak = float(np.max(rms)) if len(rms) else 0.0

    # 整段是数字静音（全 0）时，peak 也是 0。
    # 旧写法 np.maximum(rms,1e-8)/max(peak,1e-8) 在两者都是 1e-8 时比值等于 1，
    # log10(1)=0，于是纯静音被算成"满音量"，再配上 pyin 的无效输出就成了 100% 浊音。
    # 这里显式处理：整段无能量就直接给 -80dB。
    if peak <= 1e-8:
        db = np.full(len(times), -80.0)
    else:
        db = 20.0 * np.log10(np.maximum(rms, 1e-12) / peak)
        db = np.clip(db, -80.0, 0.0)

    # 自适应静音阈值：取能量分布的 P10 往上 12dB，避免整体音量小的录音全被判成静音。
    # 但如果整段都是 -80dB（数字静音），阈值就该是 -80，让所有帧都算静音。
    if peak <= 1e-8:
        silent_threshold_db = -79.0
    else:
        silent_threshold_db = float(min(-35.0, max(-60.0, np.percentile(db, 10) + 12.0)))
    state = np.full(len(times), "silence", dtype=object)
    for i in range(len(times)):
        if db[i] <= silent_threshold_db:
            state[i] = "silence"
        elif not np.isnan(f0[i]):
            state[i] = "voiced"
        else:
            state[i] = "unvoiced"

    # pyin 会给出八度错误（跳到 2x 或 0.5x）。先按邻域一致性把整倍跳变拉回来，
    # 再做中值平滑去掉剩下的孤立跳变。置信度只用来剔除极低分的猜测，
    # 不能用高阈值——合成音/有底噪的录音置信度普遍偏低。
    f0 = fix_ceiling(f0, fmax)
    f0 = fix_global_octave(f0)
    f0 = fix_octaves(f0, window=9, tol=4.0)
    # 兜底：落在 fmin 以下的不是基频（fix_octaves 有时会把低音再折半），丢掉。
    f0 = np.where(f0 < fmin, np.nan, f0)
    # 置信度只剔除 pyin 给出的极低分猜测；YIN 补进来的帧本来就没有概率，
    # 用 voiced_prob 全量过滤会把它们又抹掉。
    conf_floor = 0.01
    if voiced_prob is not None:
        prob = np.asarray(voiced_prob, dtype=float)
        if len(prob) == len(f0):
            too_low = (prob < conf_floor) & ~np.isnan(f0)
            # 只清掉"低分且与邻域不一致"的帧，别误伤 YIN 补的整段
            if too_low.any():
                smoothed = median_smooth(f0, 5, limit=2.5)
                f0 = np.where(too_low & (np.abs(12.0 * np.log2(np.where(f0 > 0, f0, 1.0) / np.where(smoothed > 0, smoothed, 1.0))) > 6.0), np.nan, f0)
    f0 = median_smooth(f0, 5, limit=2.5)

    voiced = f0[~np.isnan(f0)]
    ref_hz = float(np.median(voiced)) if len(voiced) else 0.0
    semitone = np.full(len(f0), np.nan)
    if ref_hz > 0:
        m = ~np.isnan(f0)
        semitone[m] = 12.0 * np.log2(f0[m] / ref_hz)

    # 局部参考：按 2 秒窗口各自取中位，用来发现"换腔/换人"。
    # 全片中位在整段同一腔调时没问题，但一段里换了发声位置（或换了人）时，
    # 后半段会被算成"高出十几半音"，而工具不会说这可能是另一个腔。
    local_ref = np.full(len(f0), np.nan)
    if len(times) > 0 and ref_hz > 0:
        win_s = 2.0
        for i in range(len(times)):
            lo_t, hi_t = times[i] - win_s / 2, times[i] + win_s / 2
            m2 = (times >= lo_t) & (times <= hi_t) & ~np.isnan(f0)
            if np.sum(m2) >= 8:
                local_ref[i] = float(np.median(f0[m2]))
    # 局部参考相对全片中位的偏移（半音）：超过 ±4 说明这一段和整段不是一个腔
    drift = np.full(len(f0), np.nan)
    if ref_hz > 0:
        m3 = ~np.isnan(local_ref)
        drift[m3] = 12.0 * np.log2(local_ref[m3] / ref_hz)

    # ------------------------------------------------------------------
    # 音高振荡（旧名 jitter / 微颤）。2026-11-27 重做。
    #
    # 旧实现：0.11 秒窗口里的半音 std。
    #   问题：这个窗口和「语调」是同一个尺度。真人微颤 4-12 Hz，
    #   语调滑动 1-3 Hz，在 0.11 秒（分辨率约 9 Hz）里根本分不开。
    #   实测：真实录音里旧 jitter 前 10% 的帧，80% 落在「窗口内单调滑动」。
    #   它测的不是抖，是「语调在动」。
    #
    # 新实现：3-12 Hz 带通后取 RMS，窗口 0.5 秒。
    #   实测分离比：带通 176× vs 旧做法 27×（六条已知答案的合成音频）。
    #   窗口必须 >= 0.5 秒：频率分辨率 ≈ 1/窗口，短了分不开 2 Hz 和 5 Hz。
    #
    # 四层闸门，任一不过就留 NaN：
    #   1. 本帧 voiced —— 噪声的 f0 是随机的，带通后 RMS 高达 1.31，
    #      比真微颤 0.73 还高。不给这道闸，安静的录音会被判成最抖。
    #   2. 窗口内无 >6 半音阶跃 —— 管跨八度断口（实测残差会到 1.0）。
    #   3. 窗口覆盖率 >= 80% —— 管大片断裂。
    #   4. 过零率 >= 4 Hz —— 管滑音。
    #      滑音是单调下降（过零 0 次），微颤是来回（5 Hz → 8 次/秒）。
    #      实测滑音中位 0.0 Hz，微颤中位 8.0 Hz，完全分开。
    #      但滑音**两端拐弯处**过零会到 10-14 Hz，所以判据用分位数不用峰值。
    # ------------------------------------------------------------------
    OSC_LO, OSC_HI = 3.0, 12.0      # Hz，微颤频带
    OSC_HALF = 25                    # ±25 帧 = 0.5 秒窗
    OSC_MIN_ZC = 4.0                 # 过零率下限（Hz）

    pitch_osc = np.full(len(f0), np.nan)
    pitch_osc_rate = np.full(len(f0), np.nan)
    voiced_mask = ~np.isnan(f0)

    # 闸门 0：整段音域极窄且 f0 贴着搜索下限 → 机械声/纯音。
    #
    # 为什么需要这道闸：f0 追踪在噪声上会被钉在下限附近来回抖
    # （实测 car.wav：2819 个浊音帧只有 14 个不同值，min=75.0 max=84.2），
    # 这个「钉死 + 小抖动」在 3-12 Hz 带通后成了持续振荡，
    # 报出 0.0999 的假微颤。
    #
    # 判据和 _detect_nonverbal 里的 narrow 同源：
    # 音域 < 3 半音 且 贴下限，说明没有真实的音高变化，
    # 此时算振荡没有意义。
    _voiced_vals = f0[voiced_mask]
    _osc_disabled = False
    if len(_voiced_vals) >= 20:
        _range_st = 12.0 * np.log2(
            float(np.max(_voiced_vals)) / max(1e-6, float(np.min(_voiced_vals))))
        try:
            _fmin = cfg_num("XIYOUNG_AUDIO_F0_MIN", 75.0)
        except Exception:
            _fmin = 75.0
        _med = float(np.median(_voiced_vals))
        if _range_st < 3.0 and _med <= _fmin * 1.15:
            _osc_disabled = True

    # 预先算半音序列（相对全片中位）
    st_seq = np.full(len(f0), np.nan)
    if ref_hz > 0:
        mst = ~np.isnan(f0)
        st_seq[mst] = 12.0 * np.log2(f0[mst] / ref_hz)

    def _bandpass_rms_zc(vals, ts):
        """返回 (rms, zero_cross_rate_hz, dur)。数据不够返回 (nan, 0, 0)。"""
        v = ~np.isnan(vals)
        if v.sum() < 10:
            return np.nan, 0.0, 0.0
        y = vals[v]
        x = ts[v]
        y = y - float(np.mean(y))
        dt = (x[-1] - x[0]) / max(1, len(y) - 1)
        if dt <= 0:
            return np.nan, 0.0, 0.0
        fs = 1.0 / dt
        # 频率分辨率不够就放弃，宁可没值也不要给个假值
        if fs < OSC_HI * 2.5:
            return np.nan, 0.0, 0.0
        try:
            sos = _sp_signal.butter(
                2, [OSC_LO / (fs / 2), min(OSC_HI, fs / 2 * 0.95) / (fs / 2)],
                btype="band", output="sos")
            f = _sp_signal.sosfiltfilt(sos, y)
        except Exception:
            return np.nan, 0.0, 0.0
        rms = float(np.sqrt(np.mean(f ** 2)))
        zc = int(np.sum(np.diff(np.sign(f)) != 0))
        dur = float(x[-1] - x[0])
        return rms, (zc / dur if dur > 0 else 0.0), dur

    for i in range(len(f0)):
        if _osc_disabled:
            break                                             # 闸门 0
        if not voiced_mask[i]:
            continue                                          # 闸门 1
        lo, hi = max(0, i - OSC_HALF), min(len(f0), i + OSC_HALF + 1)
        seg = st_seq[lo:hi]
        seg_t = times[lo:hi]
        v = ~np.isnan(seg)
        span = hi - lo
        if span <= 0 or v.sum() < 0.8 * span:
            continue                                          # 闸门 3
        y = seg[v]
        if len(y) < 3:
            continue
        if float(np.max(y) - np.min(y)) > 6.0:
            continue                                          # 闸门 2（阶跃）
        rms, zc_rate, dur = _bandpass_rms_zc(seg, seg_t)
        if np.isnan(rms) or dur <= 0:
            continue
        pitch_osc_rate[i] = zc_rate
        if zc_rate < OSC_MIN_ZC:
            continue                                          # 闸门 4（滑音）
        pitch_osc[i] = rms

    # 频谱特征：情绪分类比韵律特征更有用（见 spectral_features 的注释）
    try:
        spec = spectral_features(y, sr, hop, n_fft)
    except Exception:
        # 算不出来不该让整个分析失败——这四维是增强，不是必需
        empty = np.full(len(times), np.nan)
        spec = {"centroid": empty, "rolloff": empty,
                "flatness": empty, "hnr": empty}

    return {
        "times": times,
        "f0": f0,
        "semitone": semitone,
        "pitchOscillation": pitch_osc,
        "pitchOscillationRate": pitch_osc_rate,
        "db": db,
        "state": state,
        "ref_hz": ref_hz,
        "local_ref": local_ref,
        "drift": drift,
        "hop_s": hop / sr,
        "spectral": spec,
    }




def extract_formants(y, sr, hop_s=0.01, max_formant=5000.0):
    """估计第一、第二共振峰（F1/F2）。**实验性，默认不接入分析流程。**

    想法：共振峰是声道的共振频率，由声道的长短粗细决定，声带和声道不随情绪变，
    所以它应该比基频更像"嗓音指纹"。

    **但实测没过验证**（2026-11-23，CASIA 1200 条 + 真人 3 条）：

    - 同一个人内部，F1 中位从 349 跳到 1736（LPC 把谐波误当共振峰）
    - 同一人不同情绪间 F1 差 251 Hz，不同人同一情绪间差 259 Hz，比值只有 1.03
    - 换成"平均谱包络"法后，F1/F2 常常落在同一个峰的两个局部极大上（391/500、289/305）
    - 真人三条录音（同一人，三种语气）F1 从 511 到 671，变化 31%

    根因不是算法细节：**1-3 秒的短句上，共振峰估计本身就不稳定**。
    要真正做说话人识别，需要长语音 + 专门的 x-vector / i-vector 模型，
    不是在一段短音频上算两个峰能解决的。

    保留这个函数是为了以后能用长音频重测；分析流程默认不调用它。

    方法：LPC（线性预测编码）。对每个浊音帧：
      1. 预加重 + 加窗
      2. 用 Levinson-Durbin 求 LPC 系数
      3. 求 LPC 多项式的根，取虚部换算成频率
      4. 在 90-5000Hz 范围内按顺序取前两个稳定峰作为 F1/F2

    只对浊音帧算（清音/静音没有共振峰结构）。
    返回 (f1, f2, times)，和逐帧曲线等长，非浊音帧为 NaN。
    """
    import librosa

    hop = max(1, int(round(sr * hop_s)))
    n_win = 1024
    order = int(2 + sr / 1000)  # 常见取法：2 + fs/1000

    # 先拿到基频，只在浊音帧上算
    f0, _prob = track_pitch(y, sr, hop, 2048, 75.0, 400.0)
    n_frames = len(f0)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)

    f1 = np.full(n_frames, np.nan)
    f2 = np.full(n_frames, np.nan)
    if n_frames == 0:
        return f1, f2, times

    # 预加重：提升高频，补偿声门波的频谱倾斜
    pre = np.append(y[0], y[1:] - 0.97 * y[:-1])

    for i in range(n_frames):
        if np.isnan(f0[i]):
            continue
        start = i * hop
        frame = pre[start:start + n_win]
        if len(frame) < n_win:
            break
        # 汉明窗 + 轻微去直流
        frame = frame - frame.mean()
        frame = frame * np.hamming(n_win)
        if np.max(np.abs(frame)) < 1e-6:
            continue
        try:
            # LPC 系数
            a = librosa.lpc(frame, order=order)
            # 求根
            roots = np.roots(a)
            # 只保留上半平面（虚部 > 0）
            roots = roots[np.imag(roots) > 0]
            if len(roots) == 0:
                continue
            # 极点频率和带宽：带宽 = -ln|r| * fs / pi
            # 真实共振峰的带宽通常在 50-400Hz；虚假极点带宽很大或很小。
            freqs = np.abs(np.arctan2(np.imag(roots), np.real(roots))) * (sr / (2.0 * np.pi))
            mags = np.abs(roots)
            bandwidths = -np.log(np.clip(mags, 1e-9, 1.0)) * (sr / np.pi)
            keep = (freqs > 90.0) & (freqs < max_formant) & (bandwidths > 30.0) & (bandwidths < 600.0)
            freqs = freqs[keep]
            if len(freqs) < 2:
                continue
            freqs = np.sort(freqs)
            # F1 取最低的真实极点；F2 取比 F1 高至少 250Hz 的下一个
            f1_cand = float(freqs[0])
            higher = freqs[freqs > f1_cand + 250.0]
            if len(higher) == 0:
                continue
            f1[i] = f1_cand
            f2[i] = float(higher[0])
        except Exception:
            continue

    # 平滑：去掉孤立的跳变（LPC 偶尔会选到错误的峰）
    for arr in (f1, f2):
        for i in range(1, len(arr) - 1):
            if np.isnan(arr[i]):
                continue
            neigh = [x for x in (arr[i-1], arr[i+1]) if not np.isnan(x)]
            if len(neigh) == 2:
                med = float(np.median(neigh))
                if med > 0 and abs(12.0 * np.log2(arr[i] / med)) > 6.0:
                    arr[i] = med

    return f1, f2, times



# ---------------------------------------------------------------------------
# 说话人嵌入（Resemblyzer）
#
# 前面试过"用基频/共振峰算指纹"，实测都失败了：
#   - 基频：人之间/人内 比值 0.84（同一个人不同情绪比不同人差别还大）
#   - 共振峰 F1/F2：比值 1.03，短音频上测不准
#
# 换成训练好的说话人嵌入模型后，同一个人的不同语气确实聚在一起：
#   CASIA 4 人 × 30 条实测，同一人余弦相似度 0.70，不同人 0.58，差值 +0.12。
#   时长越长差距越大（1 秒 +0.115，3 秒以上 +0.163）。
#
# 嵌入是 256 维向量，不是几个可读数字——"嗓音指纹"本来就不是两个数能概括的。
# 这里只提供"给一段音频算嵌入"和"比较两段像不像"，不做聚类/身份库。
# ---------------------------------------------------------------------------

_SPEAKER_ENCODER = None
_SPEAKER_ERROR = None


def load_speaker_encoder():
    """懒加载 Resemblyzer。装不上就返回 None（说话人功能可选）。"""
    global _SPEAKER_ENCODER, _SPEAKER_ERROR
    if _SPEAKER_ENCODER is not None or _SPEAKER_ERROR is not None:
        return _SPEAKER_ENCODER
    try:
        from resemblyzer import VoiceEncoder
        _SPEAKER_ENCODER = VoiceEncoder('cpu')
    except Exception as e:
        _SPEAKER_ERROR = str(e)
        _SPEAKER_ENCODER = None
    return _SPEAKER_ENCODER


# ---------------------------------------------------------------------------
# 说话人嵌入：多后端
#
# 为什么要多后端：
#   Resemblyzer 是 2020 年的模型，它的嵌入有明显缺陷——所有向量挤在同一个
#   锥角里（各向异性），不同人之间的 raw 余弦能到 0.5 以上，等于把"不同人"
#   的基准线抬得很高。同人 0.74 / 异人 0.52，比值只有 1.44。
#
#   CAM++（3D-Speaker，中文语料训练）在同一批数据上：同人 0.53 / 异人 0.26，
#   比值 2.02。异人的基准被压低了近一半，判断"不像"时可靠得多。
#
#   但 CAM++ 需要单独下模型文件（27 MB），不是谁都装了。所以做成可选：
#   默认还是 Resemblyzer（装了就能用），CAM++ 作为更强的选项。
#
# 两个后端输出维度不同（256 vs 192），**不能混用**——不同后端的嵌入算余弦
# 没有意义。所以记录里会带上 backend 名字，比较时会拒绝跨后端比较。
# ---------------------------------------------------------------------------

_SPEAKER_BACKENDS = {}   # 后端名 -> (加载器返回值, 错误)
_XIYOUNG_BACKEND_CACHE = {}


def speaker_backend_choices():
    """可用的后端名，给配置界面和错误提示用。"""
    return ("resemblyzer", "campplus")


def resolve_speaker_backend():
    """决定这次用哪个后端。

    优先级：环境变量（来自配置）> 装了什么就用什么

    XIYOUNG_SPEAKER_BACKEND 可选值：
        auto        默认。优先 campplus（更准），没有再退回 resemblyzer
        resemblyzer 强制用 Resemblyzer
        campplus    强制用 CAM++（需要模型文件，缺失就报错而不是悄悄退回）
    """
    want = (cfg_str("XIYOUNG_SPEAKER_BACKEND", "auto") or "auto").strip().lower()
    if want not in ("auto",) + speaker_backend_choices():
        want = "auto"
    if want != "auto":
        return want
    # auto：CAM++ 模型在就用它，否则 Resemblyzer
    if _campplus_model_path():
        return "campplus"
    return "resemblyzer"


def _campplus_model_path():
    """找 CAM++ 的 onnx 模型。

    查找顺序：
      1. XIYOUNG_SPEAKER_MODEL 明确指定
      2. 数据目录下的 speaker-models/*.onnx
      3. 插件的 models/ 目录

    找不到返回 None —— 调用方据此退回 Resemblyzer，不当成错误。
    """
    explicit = cfg_str("XIYOUNG_SPEAKER_MODEL", "") or ""
    if explicit and os.path.exists(explicit):
        return explicit
    # 这个文件在 lib/ 下，所以插件根目录是它的上一级。
    # 之前这里是 here = dirname(__file__) 然后找 here/models——
    # 脚本移到 lib/ 后，那样会指向 lib/models/（不存在的目录），
    # 导致 CAM++ 模型静默找不到、退回 Resemblyzer。
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    candidates = [
        # 插件自己的 models/ 目录（推荐：模型跟着插件走）
        os.path.join(root, "models"),
        # 也兼容脚本还在根目录的情况（比如直接从源码跑）
        os.path.join(here, "models"),
        # 开发时常见的位置：工作区上一级或上两级下的 datasets/speaker-models
        os.path.join(root, "..", "datasets", "speaker-models"),
        os.path.join(root, "..", "..", "datasets", "speaker-models"),
        # 用户数据目录
        os.path.join(os.path.expanduser("~"), ".dsh", "xiyoungtools", "speaker-models"),
    ]
    for d in candidates:
        d = os.path.abspath(d)
        if not os.path.isdir(d):
            continue
        # 优先中文模型
        for pattern in ("*campplus*zh*cn*.onnx", "*3dspeaker*.onnx", "*.onnx"):
            hits = sorted(glob.glob(os.path.join(d, pattern)))
            if hits:
                return hits[0]
    return None


def load_campplus_extractor():
    """加载 sherpa-onnx 的说话人嵌入提取器。失败返回 (None, 原因)。"""
    global _XIYOUNG_BACKEND_CACHE
    if "campplus" in _XIYOUNG_BACKEND_CACHE:
        return _XIYOUNG_BACKEND_CACHE["campplus"]
    model = _campplus_model_path()
    if not model:
        res = (None, "找不到 CAM++ 模型文件（.onnx）。"
                     "设置 XIYOUNG_SPEAKER_MODEL 指向模型，"
                     "或把它放到插件目录的 models/ 下。")
        _XIYOUNG_BACKEND_CACHE["campplus"] = res
        return res
    try:
        import sherpa_onnx
        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=model, num_threads=2)
        extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
        res = (extractor, None)
    except Exception as e:
        res = (None, "CAM++ 加载失败：%s" % str(e)[:160])
    _XIYOUNG_BACKEND_CACHE["campplus"] = res
    return res


def speaker_embedding_ex(y, sr, backend=None):
    """算说话人嵌入，返回 (embedding, backendName, error)。

    和旧的 speaker_embedding 区别：明确返回用的哪个后端。
    不同后端的嵌入维度不同，不能互相比较，所以要记住来源。
    """
    import librosa

    if backend is None:
        backend = resolve_speaker_backend()

    # 至少 0.5 秒，否则模型给不出有意义的向量
    if sr != 16000:
        y = librosa.resample(np.asarray(y, dtype=np.float32),
                             orig_sr=sr, target_sr=16000)
        sr = 16000
    if len(y) < 8000:
        return None, backend, '音频太短（不足 0.5 秒），说话人嵌入不可靠'

    if backend == "campplus":
        extractor, err = load_campplus_extractor()
        if extractor is None:
            return None, backend, err
        # CAM++ 需要 16k 单声道 float32。模型内部归一化，
        # 所以这里不要自己再除以 max，否则会削掉音量信息。
        if y.ndim > 1:
            y = np.mean(y, axis=1)
        stream = extractor.create_stream()
        stream.accept_waveform(16000, np.asarray(y, dtype=np.float32))
        stream.input_finished()
        try:
            if not extractor.is_ready(stream):
                return None, backend, 'CAM++ 没有收到有效音频'
            vec = extractor.compute(stream)
        except Exception as e:
            return None, backend, 'CAM++ 计算失败：%s' % str(e)[:160]
        return [round(float(x), 6) for x in vec], backend, None

    # 默认 Resemblyzer
    enc = load_speaker_encoder()
    if enc is None:
        return None, "resemblyzer", (
            '说话人模型不可用：' + (_SPEAKER_ERROR or '未安装 resemblyzer') +
            '（装法：pip install resemblyzer webrtcvad-wheels）')
    try:
        vec = enc.embed_utterance(np.asarray(y, dtype='float32'))
        return [round(float(x), 6) for x in vec], "resemblyzer", None
    except Exception as e:
        return None, "resemblyzer", '说话人嵌入计算失败：' + str(e)[:200]


def speaker_embedding(y, sr):
    """算一段音频的说话人嵌入。返回 (embedding 或 None, 错误说明)。

    保持这个老签名不变（cluster/diarize 都在用），内部走多后端。
    """
    vec, _backend, err = speaker_embedding_ex(y, sr)
    return vec, err


def cosine_similarity(a, b):
    """两个嵌入的余弦相似度。

    ⚠ 不要用 `if not a` 判断空：a 可能是 numpy 数组，对它取真值会抛
    ValueError("truth value of an array ... is ambiguous")。用 len() 判长度。
    """
    if a is None or b is None:
        return None
    try:
        if len(a) == 0 or len(b) == 0 or len(a) != len(b):
            return None
    except TypeError:
        return None
    import math
    dot = sum(float(x) * float(y) for x, y in zip(a, b))
    na = math.sqrt(sum(float(x) * float(x) for x in a))
    nb = math.sqrt(sum(float(y) * float(y) for y in b))
    if na == 0 or nb == 0:
        return None
    return round(dot / (na * nb), 4)


# 每个后端的判据阈值。**必须分开，不能共用一套。**
#
# 实测来源（2026-11-26，CNEV 24 说话人，每段 4 秒，同人=不同录音拼接）：
#
#   后端         同人区间          异人区间          最优阈值  错误率
#   campplus     0.5022~0.8822    0.1166~0.7239    0.573    6.4%
#   resemblyzer  0.6344~0.9733    0.4072~0.8066    0.717   19.5%
#
# resemblyzer 的异人最高能到 0.81 —— 如果拿 campplus 的 0.573 去判，
# 一半以上的"不同人"会被说成"同一人"。这不是调参能救的，是两个坐标系。
#
# 旧的 0.70/0.65/0.55 是 CASIA 上 resemblyzer 的结果，只对 resemblyzer 有意义。
_SPEAKER_THRESHOLDS = {
    # 强判据（很可能是同一人）/ 弱判据（可能是）/ 下限（以下判断为不同人）
    "campplus":    {"strong": 0.70, "weak": 0.60, "floor": 0.50},
    "resemblyzer": {"strong": 0.78, "weak": 0.70, "floor": 0.62},
}


def speaker_verdict(similarity, backend=None):
    """把相似度翻成一句人话。

    ⚠️ 阈值按后端分开。两个模型的余弦坐标系完全不同：
        campplus     异人 0.12~0.72，同人 0.50~0.88
        resemblyzer  异人 0.41~0.81，同人 0.63~0.97
    拿 resemblyzer 时代的 0.70 去看 campplus 的分数，会把大量同人判成"不像"；
    反过来拿 0.57 去看 resemblyzer，会把一半异人判成"同一人"。
    """
    if similarity is None:
        return None
    if backend is None:
        backend = resolve_speaker_backend()
    th = _SPEAKER_THRESHOLDS.get(backend) or _SPEAKER_THRESHOLDS["resemblyzer"]
    if similarity >= th["strong"]:
        return '很可能是同一个人'
    if similarity >= th["weak"]:
        return '可能是同一个人'
    if similarity >= th["floor"]:
        return '说不准（%s 的中间地带，同人通常 %.2f 以上）' % (backend, th["strong"])
    return '很可能不是同一个人'



# ---------------------------------------------------------------------------
# 说话人聚类
#
# 实测记录（CASIA 4 人 × 3-15 条 + 真人 3 条）：
#   - 同一人内部相似度因人而异很大：ZhaoZuoxiang 0.872，wangzhe 0.677
#   - liuchanhg 与 zhaoquanyin 之间就有 0.717，比前者自己的下限 0.720 只低一点
#   → 单一阈值分不干净，CASIA 这 4 个人的声音本身太像
#
# 质心聚合法在真实场景（我 3 条 + 陌生人）上表现最好：
#   自己的三条能正确聚成一组，同一个人不会被打散
#
# 这里不做"这是谁"，只回答"这批录音大致有几个人、哪几条像"。
# 结果要人看，不自动下结论。
# ---------------------------------------------------------------------------

def cluster_speakers(embeddings, seed_thr=None, merge_thr=None):
    """把一批嵌入聚类。

    两步：
      1. 种子分组：用较高阈值（默认 0.82）做单链接，把明显相同的先连起来
      2. 质心合并：每组算质心，质心相似度 >= merge_thr（默认 0.75）就合并

    为什么不用单链接一步到底：传递性太强，只要有一对跨人的相似度过阈值，
    整片就并成一组（实测阈值 0.72 时 32 条全并成 1 组）。

    返回 [{"members": [索引], "size": n, "cohesion": 组内平均相似度}]，按大小降序。
    """
    # 阈值默认从配置读，调用方显式给了就用给的
    if seed_thr is None:
        seed_thr = cfg_num("XIYOUNG_SPEAKER_CLUSTER_SEED", 0.82)
    if merge_thr is None:
        merge_thr = cfg_num("XIYOUNG_SPEAKER_CLUSTER_MERGE", 0.75)
    n = len(embeddings)
    if n == 0:
        return []
    X = np.asarray(embeddings, dtype=float)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    Xn = X / np.where(norms > 0, norms, 1.0)
    S = Xn @ Xn.T

    # 第一步：种子分组
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

    # 第二步：质心合并
    def centroid(g):
        v = Xn[g].mean(axis=0)
        return v / (np.linalg.norm(v) + 1e-9)

    changed = True
    while changed and len(groups) > 1:
        changed = False
        cents = [centroid(g) for g in groups]
        best = None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                sim = float(cents[a] @ cents[b])
                if sim >= merge_thr and (best is None or sim > best[0]):
                    best = (sim, a, b)
        if best:
            _, a, b = best
            groups[a] = groups[a] + groups[b]
            del groups[b]
            changed = True

    # 算每组的组内平均相似度（凝聚度）
    out = []
    for g in groups:
        if len(g) >= 2:
            vals = [S[i, j] for i in g for j in g if i < j]
            cohesion = round(float(np.mean(vals)), 4)
        else:
            cohesion = None
        out.append({'members': sorted(g), 'size': len(g), 'cohesion': cohesion})

    out.sort(key=lambda x: -x['size'])
    return out



# ---------------------------------------------------------------------------
# MFCC 声纹特征
#
# 韵律特征（音高/音域/微颤…）实测分人只有 55.8% 平衡准确率，等于瞎猜。
# MFCC 是声纹领域用了二十年的入门特征——它描述的是声道频谱包络的
# 短时形状，比"多高、多响"更接近"嗓子本身的样子"。
#
# 同一批 192 条 CASIA 实测（留一法最近邻，4 选 1）：
#   韵律 6 维  51.6%
#   MFCC 26 维 82.8%
#   嵌入 256 维 93.2%
# ---------------------------------------------------------------------------

def mfcc_features(y, sr, n_mfcc=13, with_std=False):
    """MFCC 均值（13 维），可选拼上标准差（26 维）。

    实测（144 条 CASIA，标准化欧氏 + 留一最近邻）：
      仅均值 13 维  分人 86.1%  同人平衡 66.1%
      均值+SD 26 维 分人 81.2%  同人平衡 66.9%
    **标准差那部分不稳定，加进去反而拉低分人准确率**，所以默认不要。

    距离度量也很关键：
      余弦           分人 77.1%
      原始欧氏       分人 79.2%
      标准化欧氏     分人 81.2%（26维）/ 86.1%（13维）
    → 必须逐维标准化，MFCC 各维量纲差很多。
    """
    import librosa
    m = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=n_mfcc, n_fft=1024, hop_length=160)
    mean = m.mean(axis=1)
    if not with_std:
        return mean.astype(float)
    return np.concatenate([mean, m.std(axis=1)]).astype(float)


def mfcc_distance(a, b, scale=None):
    """两段 MFCC 的标准化欧氏距离。

    scale 是逐维标准差（批量算出来的）。单次比较时拿不到全局统计，
    传 None 会退化成原始欧氏——那个判别力差一截（79% vs 86%）。
    所以批量场景请先用 batch_mfcc_scale 算好 scale 再传进来。
    """
    if a is None or b is None or len(a) != len(b):
        return None
    x = np.asarray(a, dtype=float)
    y_ = np.asarray(b, dtype=float)
    if scale is not None:
        s = np.asarray(scale, dtype=float)
        s = np.where(s < 1e-9, 1.0, s)
        x = x / s
        y_ = y_ / s
    return round(float(np.sqrt(((x - y_) ** 2).sum())), 4)


def batch_mfcc_scale(features):
    """一批 MFCC 特征的逐维标准差，供 mfcc_distance 标准化用。"""
    X = np.asarray(features, dtype=float)
    if X.ndim != 2 or len(X) < 2:
        return None
    s = X.std(axis=0)
    return [float(v) for v in np.where(s < 1e-9, 1.0, s)]


def mfcc_verdict(distance, scale=None):
    """把 MFCC 距离翻成一句人话。**只在同一录音条件下有意义。**

    实测发现一个严重限制（2026-11-24）：

      同一人同一设备:  24.15 – 45.22
      不同人不同设备:  42.67 – 74.76   ← 和上面重叠
      CASIA 内部:      同人 90.13 / 异人 77.38   ← 同人反而更远！

    原因：MFCC 直接描述频谱包络，对麦克风、降噪、编码敏感。
    跨设备时"录音条件差异"会盖过"说话人差异"。

    所以：
      - 同一批录音（同设备同环境）内比较，MFCC 有参考价值（分人 86%）
      - 跨来源比较，**不可用**——阈值怎么调都会错

    批量场景请用 speaker_embedding（Resemblyzer），它做过信道补偿。
    """
    if distance is None:
        return None
    if scale is not None:
        # 标准化口径（同一批录音内部）
        if distance <= 3.4:
            return "很可能同一个人（MFCC，仅同批录音可信）"
        if distance <= 4.5:
            return "可能是同一个人（MFCC，仅同批录音可信）"
        if distance <= 5.6:
            return "说不准（MFCC，仅同批录音可信）"
        return "很可能不是同一个人（MFCC，仅同批录音可信）"
    # 原始欧氏口径（跨设备时不可靠，只给参考）
    if distance <= 40:
        return "距离很近（MFCC，仅同批录音可信）"
    if distance <= 80:
        return "距离中等（MFCC，跨录音设备时不可信）"
    return "距离较远（MFCC，跨录音设备时不可信）"



# ---------------------------------------------------------------------------
# 相对基线：把绝对数字换成"跟谁比、偏了多少"
#
# 为什么需要这个：
#   置换测试（2026-11-25，qwen3.5:4b）实测：
#     - 真实数据 / 打乱数据 / 无数据，三组结论 100% 相同 → 绝对数字没被用
#     - 但排序任务（153→233Hz）100% 正确 → 模型能处理"相对量"
#     - 六分类 17%（随机 16.7%）→ 绝对数字+类别名完全失效
#   结论：模型不知道怎么给 6 个绝对数加权，但会排序。
#   所以把加权算好，只给它 z 分数、分位数、综合强度。
# ---------------------------------------------------------------------------

# 各特征的"强度"方向：正数表示值越大越激烈
_STRENGTH_DIR = {
    "f0Median": +1,        # 音高升高
    "semitoneRange": +1,   # 音域变宽
    "pitchOscillationMedian": +1,   # 音高振荡变大
    "pitchOscillationP90": +1,
    "dbMedian": +1,        # 响度变大（dB 是负值，越大越响）
    "voicedRatio": -1,     # 浊音比升高通常意味着更平稳（反向）
    "trendSemitone": 0,    # 走向无固定方向，只作描述
}


def percentile_of(value, ref_values):
    """value 在 ref_values 里的百分位（0-100）。"""
    arr = np.asarray([v for v in ref_values if v is not None and np.isfinite(v)], dtype=float)
    if len(arr) < 5 or value is None or not np.isfinite(value):
        return None
    return round(float(np.mean(arr <= value) * 100), 1)


def zscore_of(value, ref_values):
    """value 相对 ref_values 的 z 分数。"""
    arr = np.asarray([v for v in ref_values if v is not None and np.isfinite(v)], dtype=float)
    if len(arr) < 5 or value is None or not np.isfinite(value):
        return None
    mu = float(arr.mean())
    sd = float(arr.std())
    if sd < 1e-9:
        return None
    return round((value - mu) / sd, 2)


def build_relative(summary, baseline):
    """把 summary 的绝对数字转成相对量。

    baseline 是 {"values": {key: [数值列表]}, "kind": ..., "n": ...}
    返回 {"components": {...}, "intensity": {...}}，算不出来的字段为 None。
    """
    vals = baseline.get("values") or {}
    comps = {}
    for key, direction in _STRENGTH_DIR.items():
        v = summary.get(key)
        if v is None:
            continue
        ref = vals.get(key) or []
        z = zscore_of(v, ref)
        pct = percentile_of(v, ref)
        if z is None and pct is None:
            continue
        comps[key] = {
            "value": round(float(v), 3),
            "z": z,
            "percentile": pct,
            "direction": direction,
        }

    # 不做综合强度分——实测各特征 z 分数符号混乱（angry 的 f0 +1.23 而浊音 -1.21），
    # 加权平均会互相抵消，六个情绪都落到 0.54-0.63，没有区分度。
    # 改成"最突出的偏离"：只报偏离最大的那几项，让人自己判断。
    ranked = sorted(
        [(k, v) for k, v in comps.items() if v["z"] is not None and v["direction"] != 0],
        key=lambda kv: -abs(kv[1]["z"]),
    )
    notable = []
    for k, v in ranked[:3]:
        z = v["z"]
        if abs(z) < 0.8:      # 偏离不足 0.8 个标准差的不值得说
            continue
        notable.append({
            "feature": k,
            "z": z,
            "percentile": v["percentile"],
            "note": _feature_note(k, z),
        })
    intensity = {
        "notable": notable,
        "note": ("最突出的是 " + notable[0]["feature"] if notable else "各特征都接近基线，没有明显偏离"),
    }

    return {
        "baseline": {
            "kind": baseline.get("kind"),
            "n": baseline.get("n"),
            "source": baseline.get("source"),
        },
        "components": comps,
        "intensity": intensity,
    }


_FEATURE_CN = {
    "f0Median": "音高",
    "semitoneRange": "音域",
    "trendSemitone": "走向",
    "pitchOscillationMedian": "音高振荡",
    "pitchOscillationP90": "音高振荡峰值",
    "voicedRatio": "浊音比",
    "dbMedian": "响度",
}


def _feature_note(key, z):
    """把单项 z 分数翻成人话。

    只描述"数值本身"相对基线的高低，不掺"强度方向"——
    否则会出现「浊音比略高于基线（-1.2 个标准差）」这种自相矛盾的话。
    强度方向留给调用方判断，这里只保证数说的话和数一致。
    """
    cn = _FEATURE_CN.get(key, key)
    level = "明显" if abs(z) >= 1.5 else "略"
    if z > 0:
        return "%s%s高于基线（%+.1f 个标准差）" % (cn, level, z)
    return "%s%s低于基线（%+.1f 个标准差）" % (cn, level, z)




def load_baseline_from_labels(label_file):
    """从标注池里取基线。

    标注池每条带 features，直接拿来当参考分布。
    这比"全库中位数"好——如果标注池是按 dataset 分的，
    可以只取同一 dataset 的。
    """
    import json
    try:
        with open(label_file, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    items = data if isinstance(data, list) else data.get("labels") or data.get("items") or []
    keys = ["f0Median", "semitoneRange", "trendSemitone", "pitchOscillationMedian",
            "pitchOscillationP90", "voicedRatio", "dbMedian"]
    vals = {k: [] for k in keys}
    n = 0
    for it in items:
        feats = it.get("features") or {}
        if not feats:
            continue
        n += 1
        for k in keys:
            v = feats.get(k)
            if v is not None and np.isfinite(v):
                vals[k].append(float(v))
    if n < 5:
        return None
    return {
        "values": vals,
        "kind": "labeled",
        "n": n,
        "source": label_file,
    }


def baseline_from_batch(records):
    """从批量分析结果算基线。records 是 [{features: {...}}, ...]。"""
    keys = ["f0Median", "semitoneRange", "trendSemitone", "pitchOscillationMedian",
            "pitchOscillationP90", "voicedRatio", "dbMedian"]
    vals = {k: [] for k in keys}
    n = 0
    for r in records:
        feats = r.get("features") or r.get("summary") or {}
        if not feats:
            continue
        n += 1
        for k in keys:
            v = feats.get(k)
            if v is not None and np.isfinite(v):
                vals[k].append(float(v))
    if n < 5:
        return None
    return {"values": vals, "kind": "batch", "n": n}


def _detect_nonverbal(summary, transcript=None, transcript_status=None):
    """判断"是人声，但不是说话"——哭、笑、打哈欠、咳嗽、磨牙、弹舌之类。

    为什么需要单独一类：
      detect_non_speech 只回答"是不是人声"，声带/口腔有振动就判是人声。
      但打哈欠、咳嗽、牙齿打颤、磨牙也由身体发声，却没有任何语言内容。

    实测 OpenSLR SLR99（Deeply 非言语人声集，本机测得中位数）：

        类别        浊音   f0    音域(半音)   切换/s
        牙齿打颤    78%   75     1.1        3.83
        磨牙        80%   75     1.9        3.17
        弹舌        92%   99    20.6        4.98
        打哈欠      68%  132    23.1        2.44
        清嗓        62%   90    18.9        3.63
        正常说话    40-70% 80-250  8-15      1.5-3.6

    ⚠️ 关键发现：**音域是双端的**。
    正常说话集中在 8~15 半音；非言语要么极窄（<3，磨牙/打颤这类机械重复），
    要么极宽（>18，曲线在乱跳）。两头都不像说话。

    判据（命中任一条）：
      A. 音域 > 18 半音  （曲线乱跳）
      B. 音域 < 3  半音 且 f0 贴下限  （机械重复，无音高变化）

    ⚠️ 必须排除"确实有文字"：实测真实语料里两条中文朗读（BV1AQ4x6mEUi，
    音域 26.7 / f0 78）数字形状和打哈欠几乎一样，区别只在于确实有文字。

    ⚠️⚠️ 更要排除"根本没跑过转写"（这个坑踩过两次）：
    transcript 为空有两种完全不同的含义——
        transcriptStatus = "empty"  跑过转写，确实没出字 → 可以作为"没有语言内容"的证据
        transcriptStatus = None     压根没跑（--no-transcribe 或没装模型）→ 什么都不证明
    把后者当成证据，会把 test-listen / rain-forest 这些正常录音误判成非言语。
    所以只在 status 明确为 empty/ok-but-blank 时才采信"没有文字"。

    返回 (is_nonverbal, note) 或 (False, None)。
    """
    rng = summary.get("semitoneRange")
    f0 = summary.get("f0Median")
    if rng is None or f0 is None:
        return False, None
    try:
        fmin = cfg_num("XIYOUNG_AUDIO_F0_MIN", 75.0)
    except Exception:
        fmin = 75.0

    near_floor = f0 <= fmin * 1.15
    wide = rng > 18.0
    narrow = rng < 3.0 and near_floor

    if not (wide or narrow):
        return False, None

    # 有实质文字 → 一定不是非言语
    text = str(transcript or "")
    meaningful = "".join(ch for ch in text if ch not in PUNCT_ONLY)
    if len(meaningful) >= 2:
        return False, None

    # 转写必须"确实跑过且没出字"才算证据
    # 可采信的状态：
    #   empty  跑完了没出字
    #   punct  只识别到标点/语气词（SenseVoice 在纯发声上常给这个）
    #   ok     跑完了，但剔除标点后不足 2 字
    # 不可采信（没跑成功，什么都不证明）：
    #   no_model / decode_fail / skipped / None
    status = str(transcript_status or "")
    trusted_blank = status in ("empty", "punct") or (status == "ok" and len(meaningful) < 2)
    if not trusted_blank:
        return False, None

    if narrow:
        why = ("音域只有 %.1f 半音（说话通常 8-15），音高几乎不动，"
               "更像磨牙/牙齿打颤这类机械重复" % rng)
    else:
        why = ("音域 %.1f 半音（说话通常 8-15），基频曲线在乱跳" % rng)
    extra = "" if not near_floor else "，且基频 %.0fHz 贴着搜索下限 %.0fHz" % (f0, fmin)

    return True, (
        why + extra + "；转写跑过但没出字。"
        "这是身体发声，不是说话——哭/笑/打哈欠/咳嗽/磨牙这类，不能当说的话来用"
    )


def _classify_content(summary, a=None, transcript=None, transcript_status=None):
    """把各种检测结果合成一个明确的结论，解决"字段打架"。

    优先级（高到低）：
      1. nonSpeech  整段不是人声（噪声/纯音）——数字完全不可信
      2. nonverbal  是人声但不是说话（哭/笑/打哈欠/咳嗽）
      3. music      整段是音乐/旋律——不是说话
      4. singing    是人声但是唱——不能当"说话语气"用
      5. mixed      有人声，但也检测到音乐成分（如配乐盖住人声）
      6. speech     正常说话

    mixed 这一档是为 buried.wav 那种情况准备的：
    musicLike 有分（说明有音乐），但 suspectedNonSpeech 是 false（确实有人声）。
    两个字段都对，只是要说清"有人声"优先于"有音乐"。

    nonverbal 排在 music 之前：它比音乐判据更硬（音域 + 基频下限 + 无文字三重信号），
    而且打哈欠这类声音确实不是音乐，不该被归到 music 里。
    """
    if summary.get("suspectedNonSpeech"):
        return {"kind": "nonSpeech", "trustworthy": False,
                "note": "整段不像人声，下面的数字不可信"}
    nv, nv_note = _detect_nonverbal(summary, transcript, transcript_status)
    if nv:
        return {"kind": "nonverbal", "trustworthy": False, "note": nv_note}
    if summary.get("singingLike"):
        return {"kind": "singing", "trustworthy": True,
                "note": "不能当说话语气用，会污染样本池"}
    music = summary.get("musicLike")
    if isinstance(music, dict) and (music.get("score") or 0) >= 2:
        return {"kind": "music", "trustworthy": True,
                "note": "更像音乐/旋律，不是说话"}
    return {"kind": "speech", "trustworthy": True, "note": "正常说话"}


def _music_diagnose_from(a, summary, voiced, state, f0_span):
    """音乐性评分（内部实现，接受预计算量）。

    三个结构特征，各 1 分：
      a) 音高呈阶梯（集中在少数半音级）
      b) 换气极少（静音 < 3% 但有音高变化）
      c) 音域窄 + 浊音中等（旋律常见区间）

    实测钢琴旋律 24 秒：a) 音高集中在 6 个半音级 +1；
    b) 静音 10%（不满足）；c) 音域 4.0 半音 + voiced 0.72 +1。共 2 分。
    """
    import numpy as _np
    reasons = []
    score = 0
    duration = summary.get("duration") or 0.0
    voiced_ratio = summary.get("voicedRatio") or 0.0

    # 前提：必须有稳定基频。白噪声的 f0 是随机数，量化到半音后也会"集中在少数音级"
    # （实测白噪声 top4 占 62%，和旋律的 73% 接近），但它没有稳定基频。
    # 用相邻帧跳变 P90 区分：旋律 < 0.5 半音，白噪声 2.36 半音。
    if len(voiced) >= 20:
        st_all = 12.0 * _np.log2(voiced / float(_np.median(voiced)))
        step_diffs = _np.abs(_np.diff(st_all))
        jump_p90 = float(_np.percentile(step_diffs, 90)) if len(step_diffs) else 0.0
        if jump_p90 > 1.2:
            # 基频本身在乱跳，不具备"音乐性"判定条件（这段交给噪声判据）
            silence_ratio = float(_np.mean(state == "silence")) if len(state) else 0.0
            return {"score": 0, "reasons": ["基频跳变 P90 %.2f 半音，太剧烈，不按音乐判断" % jump_p90],
                    "silenceRatio": round(silence_ratio, 3), "f0Span": round(f0_span, 1)}

    # a) 音高阶梯性：音乐的音高"停在"少数几个半音级上，说话是连续滑动。
    #    必须满足两个前提，否则真声会被误伤：
    #      1) 音频够长（>= 10 秒）。实测 3 秒短句只有 300 帧，量化到半音后
    #         天然集中（你的「催」top4 占 89%），会误判。
    #      2) 微颤足够小。真人声永远有微颤，乐器/合成音的基频是精确的。
    if len(voiced) >= 20 and duration >= 10.0:
        st_voiced = 12.0 * _np.log2(voiced / float(_np.median(voiced)))
        rounded = _np.round(st_voiced).astype(int)
        vals, counts = _np.unique(rounded, return_counts=True)
        top4 = float(_np.sum(_np.sort(counts)[::-1][:4])) / len(rounded)
        jit = summary.get("pitchOscillationMedian")
        # 只有"音高集中"且"微颤极小"才计分
        if top4 >= 0.55 and jit is not None and jit < 0.05:
            score += 1
            reasons.append("音高有 %.0f%% 集中在 4 个音级上，且微颤极小（阶梯式，旋律特征）"
                           % (top4 * 100))

    # b) 接近零的微颤：真人声永远有微颤，合成音/乐器的基频是"精确"的
    # 2026-11-27 重标：旧阈值 0.02 是给 0.11 秒 std 算的。
    # 新算法（0.5 秒 3-12 Hz 带通 RMS）实测真人微颤 0.35-0.73，
    # 合成音/乐器应该接近 0。阈值抬到 0.08。
    # 微颤极小 → 像合成音/乐器。
    # 两条证据任一条即可：
    #   a) 量到了振荡值，且极小
    #   b) 机械声（音域极窄 + 贴下限），振荡无法量，但可判定为可忽略
    jitter_med = summary.get("pitchOscillationMedian")
    negligible = summary.get("pitchOscillationNegligible") is True
    if negligible:
        score += 1
        reasons.append("整段音域极窄且基频贴下限，振荡可忽略（乐器/机械声特征）")
    elif jitter_med is not None and jitter_med < 0.08:
        score += 1
        reasons.append("音高振荡中位 %.3f 半音（真人声通常 >0.2，这个太精确）" % jitter_med)

    # c) 音高跳变呈"级进"：音乐的音符间常是 1-2 个半音的整数倍跳变。
    #    同样要求微颤极小，否则真人声的语调起伏也会"落在整半音附近"。
    _jit_c = summary.get("pitchOscillationMedian")
    _neg = summary.get("pitchOscillationNegligible") is True
    if len(voiced) >= 20 and (_neg or (_jit_c is not None and _jit_c < 0.08)):
        diffs = _np.abs(_np.diff(12.0 * _np.log2(voiced / float(_np.median(voiced)))))
        big = diffs[diffs >= 1.0]
        if len(big) >= 5:
            # 落在整数半音附近（±0.4）的比例
            near_int = float(_np.mean(_np.abs(big - _np.round(big)) < 0.4))
            if near_int >= 0.6:
                score += 1
                reasons.append("音高跳变有 %.0f%% 落在整半音附近（乐器音阶特征）"
                               % (near_int * 100))

    silence_ratio = float(_np.mean(state == "silence")) if len(state) else 0.0
    return {"score": score, "reasons": reasons,
            "silenceRatio": round(silence_ratio, 3), "f0Span": round(f0_span, 1)}


def detect_singing(a, summary):
    """判断是不是"唱歌"而不是"说话"。

    实测对比（说话 vs 唱歌 vs 音乐）：
      说话  状态切换 1.48-5.34 次/秒，浊音 0.36-0.79
      唱歌  状态切换 0.37 次/秒，  浊音 0.97
      音乐  状态切换 0.00-0.82 次/秒，浊音 0.80-1.00

    唱歌的判据：浊音极高（唱长音不断气 AND 状态切换低），
    但微颤还有（还在用声带，不是乐器）。

    这不做成"非人声"——唱歌确实是人声，只是不该拿它当"说话的语气"标注。
    """
    import numpy as _np
    state = a["state"]
    duration = summary.get("duration") or 0.0
    voiced_ratio = summary.get("voicedRatio") or 0.0
    jitter_med = summary.get("pitchOscillationMedian")

    if duration < 5.0 or len(state) < 100:
        return None

    switches = sum(1 for i in range(1, len(state)) if state[i] != state[i - 1])
    switch_per_sec = switches / duration if duration > 0.05 else 0.0

    # 三个条件：浊音极高 + 状态切换低 + 还有微颤（区别于乐器）
    if (voiced_ratio >= 0.90
            and switch_per_sec < 0.8
            and jitter_med is not None and jitter_med >= 0.15):
        return {
            "voicedRatio": round(voiced_ratio, 3),
            "switchPerSec": round(switch_per_sec, 2),
            "pitchOscillationMedian": round(jitter_med, 3),
            "warning": ("这段可能是在唱歌而不是说话（浊音 %.0f%%、几乎不断句、仍有微颤）。"
                        "拿它当说话的语气样本会污染数据。" % (voiced_ratio * 100)),
        }
    return None


def _music_diagnose(a, summary):
    """音乐性评分（对外包装）。"""
    import numpy as _np
    f0 = a["f0"]
    voiced = f0[~_np.isnan(f0)]
    span = 0.0
    if len(voiced) > 1:
        span = float(12.0 * _np.log2(float(_np.max(voiced)) / max(float(_np.min(voiced)), 1e-6)))
    return _music_diagnose_from(a, summary, voiced, a["state"], span)


def detect_non_speech(a, summary, transcript=None):
    """判断这段音频是不是"根本没有人声"。

    实测的坑：30 秒纯雨声，pyin 报出 151.9Hz、浊音 99%、微颤 1.78，
    看着像一段"沙哑的低语"，其实一个音素都没有。这类假数据比缺数据更麻烦——
    一旦进了样本库，以后拿它当依据还以为那是量出来的。

    人声和噪声的基频曲线有个本质差别：
      - 人声有稳定的发声周期，相邻帧的基频只会缓慢滑动（半音级）；
      - 噪声的"基频"是追踪器在随机猜，相邻帧会大幅乱跳。
    所以看相邻帧跳变的分布，而不是看绝对值。

    返回 (is_non_speech, reasons) —— reasons 是给人看的中文说明列表。
    """
    reasons = []
    f0 = a["f0"]
    state = a["state"]

    voiced = f0[~np.isnan(f0)]
    n_frames = len(f0)
    if n_frames == 0 or len(voiced) < 10:
        return False, []

    # 1) 相邻帧基频跳变
    diffs = []
    for i in range(1, n_frames):
        if not np.isnan(f0[i]) and not np.isnan(f0[i - 1]) and f0[i - 1] > 0:
            diffs.append(abs(12.0 * np.log2(f0[i] / f0[i - 1])))
    if diffs:
        diffs = np.asarray(diffs, dtype=float)
        jump_p90 = float(np.percentile(diffs, 90))
        jump_big = float(np.mean(diffs > 2.0))
    else:
        jump_p90 = 0.0
        jump_big = 0.0

    # 2) 半音曲线的整体离散度
    st = a["semitone"]
    st_valid = st[~np.isnan(st)]
    semitone_sd = float(np.std(st_valid)) if len(st_valid) else 0.0

    # 3) 浊音占比异常高
    voiced_ratio = summary.get("voicedRatio") or 0.0

    # 4) 转写是不是空的/只有标点
    text = (transcript or "").strip()
    meaningful = "".join(ch for ch in text if ch not in "。！？!?；;，,、…—-. \t\n\r")
    has_text = len(meaningful) >= 2

    # 3.5) 状态切换频率：真人说话一定会断（换气、辅音、停顿），
    #      纯音和稳态噪声从头到尾一个状态。实测：真人 1.5-3.6 次/秒，纯音 0。
    switches = 0
    for i in range(1, len(state)):
        if state[i] != state[i - 1]:
            switches += 1
    duration = summary.get("duration") or 0.0
    switch_per_sec = switches / duration if duration > 0.05 else 0.0

    # 4.5) 纯音的另一个特征：基频几乎不动（跨度 < 1 半音）
    f0_span = 0.0
    if len(voiced) > 1:
        f0_span = float(12.0 * np.log2(float(np.max(voiced)) / max(float(np.min(voiced)), 1e-6)))

    # 判据：噪声的特征是"跳变剧烈 + 半音离散大 + 几乎全浊音 + 没有转写"
    noisy = (
        (jump_p90 > 1.5 and jump_big > 0.08)
        or (semitone_sd > 4.5)
    )
    high_voiced = voiced_ratio > 0.90

    # 稳态信号（纯音、持续噪声）：整段不切换状态 + 基频几乎不动 + 没有转写
    steady = (
        duration >= 0.5
        and switch_per_sec < 0.3
        and voiced_ratio > 0.85
        and not has_text
    )

    # 5) 音乐性检测（新增）。
    #    实测 24 秒钢琴旋律：voiced 0.72、silence 0.10、f0 147Hz、音域 4.0 半音，
    #    转写出一个"呜"。上面 steady 的四条它只踩中"没有真文本"一条，直接放行。
    #    音乐和说话的区别不在 einzel 阈值，在三个结构特征：
    #      a) 音高呈阶梯（离散的半音级），人说话是连续滑动
    #      b) 换气极少（音乐是一口气弹到底）
    #      c) 音域窄但规整（旋律常在 3-7 半音内，说话 8-15 半音）
    _music = _music_diagnose_from(a, summary, voiced, state, f0_span)
    music_score = _music["score"]
    music_reasons = _music["reasons"]

    # 三个特征里中两个以上，且有"疑似音乐"的转写（标点或单个语气词），判为非人声
    looks_like_music = (
        music_score >= 2
        and duration >= 5.0
        and not has_text
    )

    if steady:
        if f0_span < 1.0:
            reasons.append(
                "基频跨度只有 %.2f 半音，整段音高几乎不动（人声通常在 5 个半音以上）" % f0_span
            )
        reasons.append(
            "整段状态切换 %.2f 次/秒（人声通常 1.5-3.6），说明没有换气、没有辅音、没有停顿" % switch_per_sec
        )
        if not has_text:
            reasons.append("语音转写为空或只有标点")
        return True, reasons

    if noisy and high_voiced and not has_text:
        if jump_p90 > 1.5:
            reasons.append(
                "相邻帧基频跳变 P90 达 %.2f 半音（人声通常 < 0.5），基频曲线在随机漂移" % jump_p90
            )
        if semitone_sd > 4.5:
            reasons.append("半音曲线标准差 %.2f（人声通常 < 3），说明没有稳定的发声基频" % semitone_sd)
        if high_voiced:
            reasons.append("浊音占比 %.0f%%（人声常见 40-70%%），整段都被当成有周期" % (voiced_ratio * 100))
        if not has_text:
            reasons.append("语音转写为空或只有标点")
        return True, reasons

    # 音乐性：三个结构特征中两个以上，且有"疑似音乐"的转写
    if looks_like_music:
        for r in music_reasons:
            reasons.append(r)
        reasons.append("综合判断更像音乐/旋律，不像说话（缺换气、音高呈阶梯）")
        return True, reasons

    return False, reasons


# ---------------------------------------------------------------------------
# 背景音 / 人声 的时间定位
#
# 交接书把"分清背景音"标成活干：能判断"这段不是人声"，但不能把背景音单独抽出来。
# 真正的分离要源分离模型（demucs 之类），不在这个插件的依赖范围内。
#
# 但"哪几秒是人声、哪几秒是背景"不需要分离，用已有的逐帧 state 就能答：
# detect_non_speech 是整段判定，把同一套判据套到每个"连续段"上，就得到时间轴。
#
# 这一段只回答问题，不生成音频——所以措辞必须诚实：能定位，不能分离。
# ---------------------------------------------------------------------------

def _text_overlap(segments, s_sec, e_sec, min_voice=0.05):
    """判断某个时间窗内有没有"真的在说话"的转写。

    返回 True 的条件是两件事同时成立：
      1. 有一条转写句子和时间窗有实质重叠（不是擦边）
      2. 该句子剔掉标点后还有字

    只做条件 1 不够：SenseVoice 的时间戳会把句尾拉长，一句话能盖住几秒静音。
    所以调用方还会用 min_voice 再要求这一窗里有声帧——这里只负责文字那一半。
    """
    if not segments:
        return False
    for sg in segments:
        try:
            st = float(sg.get("start", 0))
            en = float(sg.get("end", 0))
        except Exception:
            continue
        overlap = min(en, e_sec) - max(st, s_sec)
        if overlap <= 0:
            continue
        txt = str(sg.get("text") or "")
        if len("".join(ch for ch in txt if ch not in "。！？!?；;，,、…—-. \t\n\r")) >= 1:
            return True
    return False


def segment_speech_background(a, summary, segments=None, hop=None, min_seg=1.0, bridge=0.5):
    """把整段切成 {start, end, kind} 的区间。

    kind:
      speech      有声，且具备人声的结构特征（有换气/辅音/停顿）
      background  静音为主，或稳态信号（雨声、纯音、持续噪声）
      mixed       有声但证据不足，介于两者之间

    ⚠️ 切段依据是"有没有声音"（voiced/unvoiced vs silence），**不是**逐帧 state。
    voiced 和 unvoiced 在真实人声里每 0.26 秒就交替一次（实测 348 秒的样本有 809 个
    连续段，56% 短于 0.3 秒）——那是换气、辅音、停顿造成的，正是"人声"的证据。
    拿 state 直接切段会切出几百个无意义的碎片。正确做法：先按有声/无声切大段，
    再在每个大段内部用状态切换频率等特征判断这一段是什么性质。
    """
    state = a.get("state")
    f0 = a.get("f0")
    if state is None or len(state) == 0:
        return []

    hop = float(hop or a.get("hop") or 0.01)
    n = len(state)

    # 第一步：只分"有声 / 无声"两类，再切段
    def sounding(i):
        return state[i] != "silence"

    coarse = []  # (start_i, end_i, is_sounding)
    s = 0
    for i in range(1, n + 1):
        if i == n or sounding(i) != sounding(s):
            coarse.append([s, i, sounding(s)])
            s = i

    # 第二步：用 bridge 把靠得很近的"有声"之间的短暂无声接起来
    # （换气 0.2-0.5 秒不该把一句话切成两段）
    bridge_frames = int(bridge / hop)
    merged = []
    for seg in coarse:
        if merged:
            prev = merged[-1]
            gap = seg[0] - prev[1]
            # 前一段有声、当前段无声、且这段无声很短、后面还有有声 → 合并
            if (prev[2] and not seg[2] and gap < bridge_frames):
                merged.append([seg[0], seg[1], seg[2], True])  # 标记"短停顿"
                continue
            if (not prev[2] and seg[2] and len(merged) >= 2
                    and merged[-2][2] and (seg[0] - merged[-2][1]) < bridge_frames):
                # 把中间那段短停顿并进前后
                merged[-1][1] = seg[1]
                merged[-1][2] = True
                continue
        merged.append(seg)

    # 第三步：丢掉过短的段（含被标记为短停顿却没被并掉的）
    min_frames = max(1, int(min_seg / hop))
    cleaned = []
    for seg in merged:
        if (seg[1] - seg[0]) < min_frames:
            if cleaned:
                cleaned[-1][1] = seg[1]
            continue
        cleaned.append(seg)

    def local_stats(s_i, e_i):
        seg_state = state[s_i:e_i]
        voiced = float(np.mean(seg_state == "voiced")) if e_i > s_i else 0.0
        unvoiced = float(np.mean(seg_state == "unvoiced")) if e_i > s_i else 0.0
        silence = float(np.mean(seg_state == "silence")) if e_i > s_i else 0.0
        switches = 0
        for k in range(s_i + 1, e_i):
            if state[k] != state[k - 1]:
                switches += 1
        secs = max((e_i - s_i) * hop, 1e-6)
        jumps = []
        if f0 is not None:
            for k in range(max(s_i, 1), e_i):
                a0, a1 = f0[k - 1], f0[k]
                if not np.isnan(a0) and not np.isnan(a1) and a0 > 0:
                    jumps.append(abs(12.0 * np.log2(a1 / a0)))
        jump_p90 = float(np.percentile(jumps, 90)) if jumps else 0.0
        return {
            "voiced": voiced, "unvoiced": unvoiced, "silence": silence,
            "switch_per_sec": switches / secs,
            "jump_p90": jump_p90,
            "secs": secs,
        }

    def has_text_in(s_sec, e_sec, min_voice=0.05):
        """转写里有句子落在这个时间窗内，且这一窗里真有一点声音。

        ⚠️ min_voice 是必需的：SenseVoice 的时间戳会把最后一句的尾巴拖得很长
        （实测 `27.54–34.08` 一句话盖住了 4 秒纯静音）。光看"有没有字"会把片尾
        静音判成人声。要求这一窗里有超过 5% 的非静音帧，才能算"这里有人在说话"。
        """
        if not segments:
            return False
        return _text_overlap(segments, s_sec, e_sec, min_voice)

    out = []
    for seg in cleaned:
        s_i, e_i = seg[0], seg[1]
        st0 = local_stats(s_i, e_i)
        t0 = s_i * hop
        t1 = e_i * hop
        spoken = has_text_in(t0, t1)
        voice_share = st0["voiced"] + st0["unvoiced"]
        # 有字但这一段其实几乎全是静音 → 那是转写时间戳拖长造成的，不算说话
        if spoken and voice_share < 0.05:
            spoken = False

        # 判断顺序有讲究：
        # 1. 静音占大头 → background，**先于**转写判断。
        #    实测片尾段 silence=0.71~0.80、voiced=0.00，却因为 SenseVoice 的
        #    时间戳把最后一句拖到 34 秒而被判成 speech。阈值用 0.6：
        #    真人说话时静音占比通常远低于这个数（实测语料 silenceRatio 0.02–0.15）。
        # 2. 有转写文字且真有声音 → speech（文字是最硬的证据）
        # 3. 稳态 + 基频乱跳 → background（雨声、噪声、纯音）
        # 4. 有声且状态在切换 → speech（换气/辅音/停顿是人声的结构特征）
        # 5. 剩下的有声段 → mixed
        if st0["silence"] >= 0.6:
            kind = "background"
        elif spoken:
            kind = "speech"
        elif st0["switch_per_sec"] < 0.3 and st0["jump_p90"] > 1.5:
            kind = "background"
        elif st0["switch_per_sec"] >= 0.8 and voice_share >= 0.6:
            kind = "speech"
        elif voice_share >= 0.3:
            kind = "mixed"
        else:
            kind = "background"

        out.append({
            "start": round(t0, 2),
            "end": round(t1, 2),
            "kind": kind,
            "voiced": round(st0["voiced"], 3),
            "silence": round(st0["silence"], 3),
            "switchPerSec": round(st0["switch_per_sec"], 2),
            "jumpP90": round(st0["jump_p90"], 2),
        })

    # 一致性收口：整段已经被 detect_non_speech 判成"不是人声"时，
    # 分段不能再宣称这里有 speech——那会自相矛盾，调用方不知道该信哪个。
    # 实测 24 秒的疑似噪声样本：整段 nonSpeech=True，分段却 5/6 段标成 speech。
    # 这种情况下把所有 speech/mixed 降级为 background，并注明原因。
    if summary and summary.get("suspectedNonSpeech"):
        for sg in out:
            if sg["kind"] in ("speech", "mixed"):
                sg["kind"] = "background"
                sg["note"] = "整段已判为疑似非人声，这一段不按人声计"

    return out


def summarize_segments(segments, hop=None):
    """把区间列表压成一句人话 + 各类型的总时长。"""
    if not segments:
        return None
    total = {"speech": 0.0, "background": 0.0, "mixed": 0.0}
    for sg in segments:
        total[sg["kind"]] = total.get(sg["kind"], 0.0) + max(0.0, sg["end"] - sg["start"])
    parts = []
    if total["speech"] > 0:
        parts.append("人声 %.1f 秒" % total["speech"])
    if total["background"] > 0:
        parts.append("背景 %.1f 秒" % total["background"])
    if total["mixed"] > 0:
        parts.append("交织 %.1f 秒" % total["mixed"])
    return {
        "count": len(segments),
        "seconds": {k: round(v, 2) for k, v in total.items()},
        "note": "、".join(parts) + "（只做时间定位，没有分离出音频轨）",
    }



# ---------------------------------------------------------------------------
# 统一变化点检测
#
# 为什么做这个：
#   目标"听懂意思"分三层——字面转写、谁在说、什么意思。
#   前两层已经可用（转写准、说话人 0.72-0.78 vs 0.45、背景音全对）。
#   第三层卡在模型能力：实测 qwen3.5:4b 对"韵律数字→情绪"的映射完全失效
#   （4 条差别明显的样本，它全答"愤怒"；置换测试打乱数据结论不变）。
#
#   所以换一个可验证的问题：**"这里变了没有"**。
#   "这里音高突然升了 12 个半音"可验证；"这句话是愤怒"不可验证。
#
#   已有三个检测器各自为政（换腔、微颤峰、发声块），这里合并成统一时间轴。
# ---------------------------------------------------------------------------

def detect_changes(a, summary, min_gap=None):
    """把各种变化检测合并成一条时间轴上的变化点。

    检测四类：
      register  发声位置变了（音高整体平移）
      pitch     音高突变（相邻帧跳变）
      loudness  响度突变
      silence   静音开始/结束（换人说话、停顿）

    返回 [{"at": 秒, "kind": 类型, "delta": 数值, "unit": 单位, "note": 中文说明}]，
    按时间排序。min_gap 用来合并挨得太近的同类变化。
    """
    # min_gap 以前是写死的 0.35 形参，配置里的 changes.minGapSec 从来没被读到
    # （而且环境变量名拼成了 XIYOUNG_CHANGES_MINGAP_SEC，差一个下划线）。
    # 现在从这个项目的 cfg_num 取，形参只作为显式覆盖。
    if min_gap is None:
        min_gap = cfg_num("XIYOUNG_CHANGES_MIN_GAP_SEC", 0.35)
    times = a["times"]
    f0 = a["f0"]
    db = a["db"]
    state = a["state"]
    changes = []

    # 1) 换腔：直接用已有的 registerShifts
    for seg in summary.get("registerShifts") or []:
        changes.append({
            "at": round(float(seg.get("start", 0)), 2),
            "kind": "register",
            "delta": round(float(seg.get("semitone", 0)), 1),
            "unit": "半音",
            "note": "发声位置变了（%+.1f 半音），可能是换了语气或换了人"
                    % float(seg.get("semitone", 0)),
        })

    # 2) 音高突变：相邻帧跳变超过阈值
    #    关键：排除八度跳变。实测 7.98 秒对话里 8 处"音高突变"全是整倍数
    #    （203.7→348.9、114.2→228.5、101.9→188.4），那是追踪器选错了周期，
    #    不是人真的变调。真实变调不会恰好差一个八度。
    def is_octave_jump(ratio):
        """判断频率比是不是接近整数倍（0.5/2/3 倍等）。"""
        if ratio <= 0:
            return True
        for mult in (2.0, 0.5, 3.0, 1/3, 4.0, 0.25):
            if abs(12.0 * np.log2(ratio / mult)) < 1.5:   # 1.5 半音容差
                return True
        return False

    #    第二个关键：要求"前后各 3 帧都稳定"。实测剩下的 5 处里，
    #    2.57s 的 101.9→188.4（比率 1.85）是清浊边界上的追踪抖动，
    #    前后帧本身在乱跳，不是人真的变调。真实变调前后是平稳的。
    stable_win = 3
    for i in range(stable_win, len(f0) - stable_win):
        if np.isnan(f0[i]) or np.isnan(f0[i - 1]) or f0[i - 1] <= 0:
            continue
        ratio = f0[i] / f0[i - 1]
        st = 12.0 * np.log2(ratio)
        if abs(st) < PITCH_JUMP_SEMITONE:
            continue
        if is_octave_jump(ratio):
            continue
        # 跳变前的窗口要稳定，跳变后的窗口也要稳定
        before = f0[i - stable_win:i]
        after = f0[i:i + stable_win]
        if np.any(np.isnan(before)) or np.any(np.isnan(after)):
            continue
        def span_semitone(arr):
            if len(arr) < 2 or np.min(arr) <= 0:
                return 999.0
            return float(12.0 * np.log2(np.max(arr) / np.min(arr)))
        if span_semitone(before) > 2.0 or span_semitone(after) > 2.0:
            continue   # 窗口内本身就在乱跳，不算突变
        changes.append({
            "at": round(float(times[i]), 2),
            "kind": "pitch",
            "delta": round(float(st), 1),
            "unit": "半音",
            "note": "音高瞬间%s了 %.1f 个半音" % ("升" if st > 0 else "降", abs(st)),
        })

    # 3) 响度突变：滑窗中位数的变化
    #    关键：只在"窗口内全部有声"时算。静音边界会让响度从 -80dB 跳到 -20dB，
    #    报出 55-75dB 的假突变（实测 7.98 秒对话里误报 4 处）。
    win = max(3, int(0.3 / max(a.get("hop_s", 0.01), 1e-6)))
    # 自适应阈值：配乐环境响度本身就在起伏，固定 12dB 会报出 41 次。
    # 实测嘈杂视频的响度突变幅度中位 14.1 dB，全在阈值边缘。
    # 改成"全片响度标准差 × 2.5"，安静录音约 12dB，配乐环境会自动抬高。
    db_valid = np.asarray([v for v in db if v is not None and np.isfinite(v)], dtype=float)
    db_sd = float(np.std(db_valid)) if len(db_valid) > 20 else 0.0
    loud_floor = cfg_num('XIYOUNG_CHANGES_LOUDNESS_FLOOR_DB', 12.0)
    loud_ceil = cfg_num('XIYOUNG_CHANGES_LOUDNESS_CEIL_DB', 25.0)
    loud_thr = max(loud_floor, min(loud_ceil, db_sd * 2.5))
    if len(db) > win * 2:
        last_loud_at = -999.0
        for i in range(win, len(db) - win, max(1, win // 2)):
            # 前后两个窗口都不能含静音帧
            if np.any(state[i - win:i] == "silence") or np.any(state[i:i + win] == "silence"):
                continue
            before = np.nanmedian(db[i - win:i])
            after = np.nanmedian(db[i:i + win])
            if np.isnan(before) or np.isnan(after):
                continue
            d = float(after - before)
            # 判据分三档，只有第三档值得报：
            #   a) 前后都是浊音，只是音量起伏（开口音 vs 闭口音）-> 正常，不报
            #   b) 清音<->浊音转换 -> 正常语音特征，不报
            #   c) 从"接近静音"跳到"正常"或反过来 -> 这才是真突变
            # 实测 573 秒单人口播：11 次"音量变化"前后浊音占比都在 47%-100%，
            # 全是 (a)，但阈值 25dB 把它们都报出来了。
            before_db = float(np.nanmedian(db[i - win:i]))
            after_db = float(np.nanmedian(db[i:i + win]))
            # 低于 -45dB 视为接近静音（正常语音中位 -8.5dB）
            near_silent_before = before_db <= -45.0
            near_silent_after = after_db <= -45.0
            is_gate = near_silent_before != near_silent_after

            # 同类变化 5 秒内只报一次，避免连续刷屏
            if abs(d) >= loud_thr and (times[i] - last_loud_at) >= 5.0 and is_gate:
                last_loud_at = times[i]
                if near_silent_after:
                    note = "声音突然出现，音量升了 %.1f dB（之前接近静音）" % abs(d)
                else:
                    note = "声音突然消失，音量降了 %.1f dB（降到接近静音）" % abs(d)
                changes.append({
                    "at": round(float(times[i]), 2),
                    "kind": "loudness",
                    "delta": round(d, 1),
                    "unit": "dB",
                    "note": note,
                })

    # 4) 静音边界
    #    关键：只有 >= 0.4 秒的静音才算"停顿"。
    #    实测动画视频里静音段 29 个、中位 0.13 秒——那是句中换气，
    #    不是停顿。全报出来会变成 26 次"停顿"，毫无意义。
    MIN_PAUSE = cfg_num("XIYOUNG_CHANGES_MIN_PAUSE_SEC", 0.4)
    i = 0
    while i < len(state):
        if state[i] == "silence":
            j = i
            while j + 1 < len(state) and state[j + 1] == "silence":
                j += 1
            dur = times[j] - times[i]
            if dur >= MIN_PAUSE:
                changes.append({
                    "at": round(float(times[i]), 2),
                    "kind": "silence",
                    "delta": round(dur, 2),
                    "unit": "秒",
                    "note": "停顿 %.1f 秒（可能换人说话）" % dur,
                })
            i = j + 1
        else:
            i += 1

    # 按时间排序 + 合并挨太近的同类
    changes.sort(key=lambda c: c["at"])
    merged = []
    for c in changes:
        if merged:
            last = merged[-1]
            if last["kind"] == c["kind"] and (c["at"] - last["at"]) < min_gap:
                # 保留幅度更大的那个
                if last["delta"] is None or c["delta"] is None or abs(c["delta"]) > abs(last["delta"]):
                    merged[-1] = c
                continue
        merged.append(c)
    return merged


def summarize_changes(changes, duration):
    """给变化点一个概览，避免几百条刷屏。"""
    if not changes:
        return {"count": 0, "note": "整段没有明显变化"}
    by_kind = {}
    for c in changes:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
    names = {"register": "换腔", "pitch": "音高突变", "loudness": "音量变化",
             "stateFlip": "清浊转换", "silence": "停顿"}
    parts = ["%s %d 次" % (names.get(k, k), v) for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])]
    return {
        "count": len(changes),
        "byKind": by_kind,
        "note": "共 %d 处变化：%s" % (len(changes), "、".join(parts)),
        "density": round(len(changes) / duration, 2) if duration > 0 else None,
    }


def _osc_spans(osc, times, rates, min_sec=0.25, gap_sec=0.15):
    """把连续的振荡帧合成时段。

    2026-11-27 第一版的 bug：用 P75 作阈值，而纯微颤时 osc 分布很平
    （实测 0.495-0.822），阈值卡在中间，高值帧被切成 20 个 1-3 帧的碎片，
    全部小于 min_sec=0.25，结果一条时段都出不来。

    修法两步：
      1. 阈值仍用本段统计（不用跨库常数——设备差异会整体偏移），
         但取「中位 + 半个 P90-中位跨度」这种更宽松的位置
      2. 相邻碎片间隔 < gap_sec 就合并——微颤本来就是连续的，
         中间掉一两帧到阈值下面不代表它停了

    返回 [{start, end, seconds, peak, median, rate, frames}]。
    rate 是过零率中位（判据本身，便于复核「为什么算振荡」）。
    """
    import numpy as _np
    valid = ~_np.isnan(osc)
    if not valid.any():
        return []
    vals = osc[valid]
    med = float(_np.median(vals))
    p90 = float(_np.percentile(vals, 90))
    # 阈值放在中位和 P90 之间。纯微颤时两者都高，跨度小，阈值仍能切出大段；
    # 混合信号时跨度大，阈值偏向高分位，只挑真正突出的部分。
    thr = med + 0.5 * (p90 - med)

    # 先找出所有达标帧，再按 gap 合并
    idx = [i for i in range(len(osc)) if valid[i] and osc[i] >= thr]
    if not idx:
        return []

    groups = []
    cur = [idx[0]]
    for k in idx[1:]:
        if times[k] - times[cur[-1]] <= gap_sec:
            cur.append(k)
        else:
            groups.append(cur)
            cur = [k]
    groups.append(cur)

    spans = []
    for g in groups:
        i, j = g[0], g[-1]
        dur = float(times[j] - times[i]) if j > i else 0.0
        if dur < min_sec:
            continue
        seg = osc[i:j + 1]
        rseg = rates[i:j + 1] if rates is not None else None
        if rseg is not None:
            rseg = rseg[~_np.isnan(rseg)]
        spans.append({
            "start": round(float(times[i]), 2),
            "end": round(float(times[j]), 2),
            "seconds": round(dur, 2),
            "peak": round(float(_np.nanmax(seg)), 3),
            "median": round(float(_np.nanmedian(seg)), 3),
            "rate": round(float(_np.median(rseg)), 1) if rseg is not None and len(rseg) else None,
            "frames": int(j - i + 1),
        })
    return spans


def _pitch_glides(st, times, f0, min_semitones=3.0, min_sec=0.12,
                   max_sec=1.2, step_sec=0.05):
    """找出单调的大幅音高移动（滑音）。

    2026-11-27 第一版的 bug：用「连续浊音段」作扫描单位，
    但合成音频全程 voiced（2.40 秒），超过 max_sec=2.0 被整个跳过，
    一条都出不来。

    修法：改成**滑窗扫描**——从每个起点往后找，看后面
    min_sec~max_sec 秒内是否单调移动 ≥ min_semitones。
    不再依赖段落边界，也不要求整段都短。

    和振荡是**两条独立轨道**，可以重叠（先滑下去再抖是常见现象）。

    返回 [{start, end, semitones, seconds, direction, monotonicity, ratePerSec}]。
    """
    import numpy as _np
    out = []
    n = len(st)
    if n < 5:
        return out

    valid = ~_np.isnan(st)
    # 预计算有效帧的时间
    vt = times
    step = max(1, int(round(step_sec / max(1e-6, float(times[1] - times[0]) if n > 1 else 0.01))))

    last_end = -1.0
    i = 0
    while i < n - 3:
        if not valid[i]:
            i += 1
            continue
        # 从 i 往后找最长的一段，长度不超过 max_sec
        best = None
        j = i + 2
        while j < n and valid[j]:
            dur = float(vt[j] - vt[i])
            if dur > max_sec:
                break
            if dur >= min_sec:
                seg = st[i:j + 1]
                k = max(1, int(len(seg) * 0.15))
                head = float(_np.median(seg[:k]))
                tail = float(_np.median(seg[-k:]))
                delta = tail - head
                if abs(delta) >= min_semitones:
                    # 单调性用「净位移 / 总路程」，不用「同向帧比例」。
                    # 后者要求逐帧同向，而真实滑音总有微颤叠在上面
                    # （实测 6_先滑后抖 的滑音段同向帧只有 40%，但净降 5.4 半音）。
                    # 净位移比看的是累计效果：
                    #   纯滑音 → ≈1    来回抖 → ≈0
                    d = _np.diff(seg)
                    total_path = float(_np.sum(_np.abs(d)))
                    mono = (abs(delta) / total_path) if total_path > 1e-6 else 0.0
                    if mono >= 0.55:
                        # 记录更长的那个（滑得越远越可能是真滑音）
                        if best is None or abs(delta) > abs(best[3]):
                            best = (i, j, dur, delta, mono)
            j += 1
        if best is not None:
            bi, bj, bdur, bdelta, bmono = best

            # 抦掉两端平坦的部分。滑窗会一直延伸，
            # 把「滑完之后保持不动」也算进区间（实测 0.25 秒滑音报成 1.48 秒）。
            # 做法：从两端各剪掉「几乎不动」的帧（逐帧变化 < 0.05 半音）。
            seg_b = st[bi:bj + 1]
            d_b = _np.diff(seg_b)
            moving = _np.abs(d_b) > 0.05

            if moving.any():
                first = int(_np.argmax(moving))
                last = len(moving) - int(_np.argmax(moving[::-1])) - 1
                # 转换成帧索引（d 比 seg 短 1）
                nbi, nbj = bi + first, bi + last + 1
                nbj = min(nbj, bj)
                if nbj > nbi:
                    new_dur = float(vt[nbj] - vt[nbi])
                    if new_dur >= min_sec * 0.5:
                        bi, bj, bdur = nbi, nbj, new_dur
                        seg2 = st[bi:bj + 1]
                        k2 = max(1, int(len(seg2) * 0.15))
                        bdelta = float(_np.median(seg2[-k2:]) - _np.median(seg2[:k2]))
                        dd = _np.diff(seg2)
                        tp = float(_np.sum(_np.abs(dd)))
                        bmono = (abs(bdelta) / tp) if tp > 1e-6 else 0.0
            # 和上一段重叠就跳过（避免同一个滑音报很多次）。
            # 第一版写成了 `vt[bi] >= last_end - 0.3*bdur`，
            # 初始 last_end=-1.0 时任何起点都满足，结果第一个滑音就被跳过，
            # 然后一路跳过去，一条都出不来。
            overlaps = last_end > 0 and vt[bi] < last_end - 0.05
            if overlaps:
                i = bj + 1 if bj > bi else i + 1
                continue
            last_end = vt[bj]
            out.append({
                "start": round(float(vt[bi]), 2),
                "end": round(float(vt[bj]), 2),
                "semitones": round(float(abs(bdelta)), 2),
                "seconds": round(float(bdur), 2),
                "direction": "down" if bdelta < 0 else "up",
                "monotonicity": round(float(bmono), 2),
                "ratePerSec": round(float(abs(bdelta) / bdur), 1) if bdur > 0 else None,
            })
            i = bj + 1
        else:
            i += 1
    return out


def segment_summary(a, times, min_voiced=0.15):
    """把逐帧结果压成一句话能读的汇总。"""
    f0 = a["f0"]
    st = a["semitone"]
    jt = a["pitchOscillation"]
    db = a["db"]
    state = a["state"]
    voiced = ~np.isnan(f0)

    out = {
        "duration": float(times[-1] + a["hop_s"]) if len(times) else 0.0,
        "ref_hz": a["ref_hz"],
        "voicedRatio": float(np.mean(voiced)) if len(f0) else 0.0,
        "unvoicedRatio": float(np.mean(state == "unvoiced")) if len(state) else 0.0,
        "silenceRatio": float(np.mean(state == "silence")) if len(state) else 0.0,
    }

    if voiced.any():
        v = f0[voiced]
        s = st[~np.isnan(st)]
        out["f0Min"] = float(np.min(v))
        out["f0Max"] = float(np.max(v))
        out["f0Median"] = float(np.median(v))
        out["f0P5"] = float(np.percentile(v, 5))
        out["f0P95"] = float(np.percentile(v, 95))
        out["semitoneRange"] = float(np.percentile(s, 95) - np.percentile(s, 5))
        idx = np.where(voiced)[0]
        half = idx[len(idx) // 2]
        first = st[idx[idx <= half]]
        second = st[idx[idx > half]]
        if len(first) and len(second):
            out["trendSemitone"] = float(np.nanmedian(second) - np.nanmedian(first))
    # 音高振荡统计。2026-11-27 重做：
    #   - 只有过了四层闸门的帧才有值（见 analyze 里的说明）
    #   - jitterPeaks 已删除：它取 top-3 最大值，而最大值必然落在
    #     「语调滑动最快」处，不可能是真正微颤处。用户实际被它误导过。
    #     现在用 pitchOscillationSpans（连续时段）替代，更有用。
    valid_jt = np.where(~np.isnan(jt), jt, np.nan)
    if not np.isnan(valid_jt).all():
        out["pitchOscillationMedian"] = float(np.nanmedian(valid_jt))
        out["pitchOscillationP90"] = float(np.nanpercentile(valid_jt, 90))
        out["pitchOscillationFrames"] = int(np.sum(~np.isnan(valid_jt)))
        out["pitchOscillationCoverage"] = float(
            np.sum(~np.isnan(valid_jt)) / max(1, np.sum(~np.isnan(f0))))

    # 过零率（判据本身，字段保留——藏起来就成黑箱了）
    zc = a.get("pitchOscillationRate")
    if zc is not None:
        vzc = zc[~np.isnan(zc)]
        if len(vzc):
            out["pitchOscillationRateMedian"] = float(np.median(vzc))

    # 振荡时段：阈值以上的连续区间。
    # 阈值用本段自己的 P75，不用跨库常数（换设备会整体偏移）。
    out["pitchOscillationSpans"] = _osc_spans(jt, times, a.get("pitchOscillationRate"))

    # 振荡不可用的原因（比给个 0 有用——0 会被读成「测了，是零」）
    if "pitchOscillationMedian" not in out:
        _rng = out.get("semitoneRange")
        _f0m = out.get("f0Median")
        try:
            _fmin = cfg_num("XIYOUNG_AUDIO_F0_MIN", 75.0)
        except Exception:
            _fmin = 75.0
        if (_rng is not None and _rng < 3.0
                and _f0m is not None and _f0m <= _fmin * 1.15):
            out["pitchOscillationNote"] = (
                "整段音域只有 %.1f 半音且基频贴着搜索下限 %.0fHz，"
                "属于机械声/纯音，基频的细微变化来自追踪抖动而非声带振动，"
                "不给振荡值" % (_rng, _fmin))
            # 关键：机械声时明确标「振荡可忽略」。
            #
            # 不编造一个 0 —— 那是假数值（这段根本没量到微颤）。
            # 但也要让下游拿到「微颤极小」这个证据，
            # 否则音乐判定会少一票（旧版靠 jitterMedian=0.000 判 car.wav 是合成音，
            # 新版给 None 之后这条失效，car 从 nonSpeech 变成 nonverbal）。
            out["pitchOscillationNegligible"] = True
        else:
            out["pitchOscillationNote"] = (
                "没有帧通过闸门（非浊音/跨阶跃/断裂/滑音），"
                "这不代表没有振荡，只代表这段不适合用这个方法量")

    # 滑音：单调的大幅音高移动。和振荡是**两条独立轨道**，可以重叠——
    # 一句话里完全可能先滑下去、滑到底再抖（人激动时就是这样）。
    out["pitchGlides"] = _pitch_glides(st, times, f0)
    out["dbMedian"] = float(np.median(db)) if len(db) else 0.0
    out["dbMax"] = float(np.max(db)) if len(db) else 0.0

    # 音强包络：音量怎么起伏（催促是急促起伏、敷衍是平推）
    try:
        out.update(loudness_envelope(db, a.get("hop_s", 0.01)))
    except Exception:
        pass

    # 频谱特征的汇总。只统计"有声"帧（浊音+清音），静音帧的频谱是底噪，
    # 混进来会把质心/滚降拉低——这是实测踩过的坑：静音多的录音全都显得"闷"。
    spec = a.get("spectral") or {}
    sounding = state != "silence"
    for key, label in (("centroid", "spectralCentroid"),
                       ("rolloff", "spectralRolloff"),
                       ("flatness", "spectralFlatness"),
                       ("hnr", "hnrMedian")):
        arr = spec.get(key)
        if arr is None:
            continue
        arr = np.asarray(arr, dtype=float)
        if len(arr) != len(state):
            continue
        vals = arr[sounding]
        vals = vals[~np.isnan(vals)]
        if len(vals) >= 3:
            if key == "flatness":
                # 频谱平坦度量级是 1e-4，直接放进去会被其他维度完全盖住。
                # 取 log10 把它拉到 -4..-1 的可用范围（实测范围 0.0000..0.0195）。
                vals = np.log10(np.maximum(vals, 1e-8))
                out[label] = float(np.median(vals))
                continue
            out[label] = float(np.median(vals))
            if key == "hnr":
                # 谐噪比的分布也有用：气声段落会拉低 P10
                out["hnrP10"] = float(np.percentile(vals, 10))

    # 换腔检测：看局部参考相对全片中位的偏移
    drift = a.get("drift")
    if drift is not None and not np.isnan(drift).all():
        d = drift[~np.isnan(drift)]
        if len(d):
            out["driftMedian"] = float(np.median(d))
            out["driftRange"] = float(np.max(d) - np.min(d))
            # 找出偏移超过 6 半音的连续段，报出时间范围。
            # 阈值从 4 提到 6：实测动画视频里 +1.9 / +1.2 半音也被报成"换腔"，
            # 那不是换人，是同一人语调的自然起伏。6 半音约等于纯四度，
            # 正常语调起伏到不了这个幅度。
            big = np.abs(drift) > 6.0
            if np.any(big):
                segs = []
                i = 0
                n = len(big)
                while i < n:
                    if big[i]:
                        j = i
                        while j + 1 < n and big[j + 1]:
                            j += 1
                        # 人声换腔不会超过一个八度。实测嘈杂视频里报出 +25 半音，
                        # 那是配乐的低频（75Hz，正好等于 fmin）被当成基频，
                        # 不是人真的变了 3 个八度。超过 12 半音的一律不报。
                        seg_median = float(np.median(drift[i:j + 1]))
                        # 第二道关：段内必须有足够多的浊音帧。
                        # 实测动画视频里 30 次"换腔"，前 1.5 秒全是 NaN（无基频），
                        # 那是"从静音/清音进入发声"，不是换了发声位置。
                        seg_f0 = f0[i:j + 1]
                        voiced_in_seg = int(np.sum(~np.isnan(seg_f0)))
                        voiced_ratio_seg = voiced_in_seg / max(1, (j - i + 1))
                        # 段前 1 秒也要有基频，否则是"从无到有"不是"换腔"
                        pre = f0[max(0, i - 100):i]
                        pre_voiced = int(np.sum(~np.isnan(pre)))
                        # 第三道关：用段前/段内的实际 f0 中位再核一次，
                        # 防止 drift 的滑窗平滑把小幅波动放大。
                        actual_diff = None
                        if pre_voiced >= 10 and voiced_in_seg >= 10:
                            pre_med = float(np.nanmedian(pre))
                            seg_med_f0 = float(np.nanmedian(seg_f0))
                            if pre_med > 0 and seg_med_f0 > 0:
                                actual_diff = float(12.0 * np.log2(seg_med_f0 / pre_med))
                        # 第三道关：必须是"跳变"不是"渐变"。
                        # 实测麦克风测评视频 85.98s 报 -4.9 半音，但实际 f0 是
                        #   85.50s 209.7 -> 85.68s 111.7 -> 86.01s 93.4 -> 86.49s 78.1
                        # 同一句话内连续下滑，不是换腔。drift 滑窗把渐变算成了偏移。
                        # 判据：段前后各 0.3 秒的 f0 中位差，要明显大于段内跨度的 1/2。
                        # 第四道关：前后必须"各自稳定"。
                        # 实测麦克风测评视频 11 次换腔，前后 f0 标准差都在 22-59 Hz，
                        # 说明 f0 本身在乱跳，不是"稳定在 A 然后切到 B"。
                        # 真实换腔：前后各 0.5 秒的半音跨度应 < 4（约一个三度）。
                        is_step = True
                        for win_f0 in (pre, f0[j:j + 50]):
                            wv = [v for v in win_f0 if v is not None and not np.isnan(v)]
                            if len(wv) >= 8:
                                span = 12.0 * np.log2(max(wv) / max(min(wv), 1e-6))
                                if span > 5.0:
                                    is_step = False
                                    break
                        tail_f0 = f0[j:j + 30]
                        tail_ok = [v for v in tail_f0 if v is not None and not np.isnan(v)]
                        if len(tail_ok) >= 8 and pre_voiced >= 8:
                            pre_clean = [v for v in pre if v is not None and not np.isnan(v)]
                            if len(pre_clean) >= 8:
                                b_med = float(np.median(pre_clean))
                                a_med = float(np.median(tail_ok))
                                step_st = abs(12.0 * np.log2(a_med / b_med)) if b_med > 0 and a_med > 0 else 0.0
                                # 段内跨度
                                seg_clean = [v for v in seg_f0 if v is not None and not np.isnan(v)]
                                inner_span = 0.0
                                if len(seg_clean) >= 4:
                                    inner_span = float(12.0 * np.log2(max(seg_clean) / max(min(seg_clean), 1e-6)))
                                # 跳变幅度要占总变化的一半以上，否则判为渐变
                                if step_st < 4.0 or (inner_span > 0 and step_st < inner_span * 0.5):
                                    is_step = False

                        if ((times[j] - times[i]) >= 0.5
                                and abs(seg_median) <= REGISTER_MAX_SEMITONE
                                and voiced_ratio_seg >= 0.3
                                and pre_voiced >= 10
                                and actual_diff is not None
                                and REGISTER_MIN_SEMITONE <= abs(actual_diff) <= REGISTER_MAX_SEMITONE
                                and is_step):
                            segs.append({
                                "start": round(float(times[i]), 2),
                                "end": round(float(times[j]), 2),
                                "semitone": round(actual_diff, 1),
                            })
                        i = j + 1
                    else:
                        i += 1
                if segs:
                    out["registerShifts"] = segs
                    out["registerWarning"] = (
                        "有 %d 段偏离全片中位超过 4 个半音，可能是换了发声位置/换了人，"
                        "按全片基准算出来的半音数在这些段里不可比" % len(segs)
                    )

    # 发声块：任何"有声"的连续段（浊音或清音），静音才切断。
    # 这样气声不会被当成停顿吞掉——第一层缺的正是这块。
    runs = []
    i = 0
    n = len(state)
    while i < n:
        if state[i] != "silence":
            j = i
            while j + 1 < n and state[j + 1] != "silence":
                j += 1
            if (times[j] - times[i]) >= min_voiced:
                seg = f0[i:j + 1]
                seg = seg[~np.isnan(seg)]
                chunk = state[i:j + 1]
                voiced_n = int(np.sum(chunk == "voiced"))
                kind = "voiced" if voiced_n > (j - i + 1) * 0.5 else "unvoiced"
                runs.append({
                    "start": round(float(times[i]), 2),
                    "end": round(float(times[j]), 2),
                    "kind": kind,
                    "f0Median": round(float(np.median(seg)), 1) if len(seg) else 0.0,
                })
            i = j + 1
        else:
            i += 1
    out["voicedRuns"] = runs
    # transcript / segments 由 main 填进来（要在转写之后），这里先占位
    out.setdefault("transcript", None)
    out.setdefault("segments", [])
    return out


def to_jsonable(a):
    def arr(x):
        return [None if (isinstance(v, float) and np.isnan(v)) else round(float(v), 3) for v in x]

    return {
        "hop": round(a["hop_s"], 4),
        "refHz": round(a["ref_hz"], 2),
        "times": arr(a["times"]),
        "f0": arr(a["f0"]),
        "semitone": arr(a["semitone"]),
        "pitchOscillation": arr(a["pitchOscillation"]),
        # 过零率是判据本身，必须输出——藏起来就成黑箱了。
        "pitchOscillationRate": arr(a.get("pitchOscillationRate")),
        "db": arr(a["db"]),
        "state": [str(s) for s in a["state"]],
        "localRef": arr(a.get("local_ref", [])),
        "drift": arr(a.get("drift", [])),
    }


def write_markdown(path, summary, curves, meta):
    L = []
    L.append("# 韵律分析")
    L.append("")
    # 疑似非人声：放在最前面，别让人先看到数字
    if summary.get("suspectedNonSpeech"):
        L.append("> ⚠ **疑似非人声**——下面的数字不可信，不要当声音素材用。")
        L.append(">")
        for r in summary.get("nonSpeechReasons") or []:
            L.append("> - " + r)
        L.append("")
    L.append("- 来源：%s" % meta.get("source", ""))
    L.append("- 时长：%.2f 秒" % summary.get("duration", 0))
    L.append("- 基频参考（说话人自己的中位）：%.1f Hz" % summary.get("ref_hz", 0))
    L.append("")
    L.append("## 汇总")
    L.append("")
    L.append("- 浊音 %.0f%% · 清音（气声）%.0f%% · 静音 %.0f%%" % (
        summary.get("voicedRatio", 0) * 100,
        summary.get("unvoicedRatio", 0) * 100,
        summary.get("silenceRatio", 0) * 100,
    ))
    if "f0Median" in summary:
        L.append("- 基频：中位 %.1f Hz，P5–P95 %.1f–%.1f Hz" % (
            summary["f0Median"], summary["f0P5"], summary["f0P95"]))
        L.append("- 音域跨度：%.1f 个半音" % summary.get("semitoneRange", 0))
        trend = summary.get("trendSemitone", 0)
        if trend > 0.5:
            L.append("- 走向：后半段比前半段高 %.1f 个半音（往上走）" % trend)
        elif trend < -0.5:
            L.append("- 走向：后半段比前半段低 %.1f 个半音（沉下去）" % abs(trend))
        else:
            L.append("- 走向：前后基本持平（%.1f 个半音）" % trend)
    # 2026-11-27：jitterPeaks 已删除。它取 top-3 最大值，而最大值必然落在
    # 「语调滑动最快」处，不可能是真正微颤处——用户实际被它误导过
    # （看到 3.99 以为是「抖得最明显」，去看帧才发现是断口）。
    # 现在改成时段 + 过零率：给现象，不给排名。
    if summary.get("pitchOscillationMedian") is not None:
        L.append("- 音高振荡（3-12 Hz 频段）：中位 %.3f 半音，P90 %.3f 半音" % (
            summary["pitchOscillationMedian"], summary["pitchOscillationP90"]))
        cov = summary.get("pitchOscillationCoverage")
        if cov is not None:
            L.append("  有效帧占浊音帧 %.0f%%（其余被闸门排除：非浊音/阶跃/断裂/滑音）"
                     % (cov * 100))
        spans = summary.get("pitchOscillationSpans") or []
        if spans:
            L.append("  振荡时段：")
            for sp in spans[:6]:
                rate = ("，来回 %.1f 次/秒" % sp["rate"]) if sp.get("rate") else ""
                L.append("    %.2f–%.2fs（%.2fs）峰值 %.3f 半音%s" % (
                    sp["start"], sp["end"], sp["seconds"], sp["peak"], rate))
        else:
            L.append("  没有连续 0.25 秒以上的振荡时段")

    # 滑音：和振荡是两条独立轨道，可以重叠（先滑下去再抖是常见现象）
    glides = summary.get("pitchGlides") or []
    if glides:
        L.append("- 音高滑移（单调移动 ≥3 半音）：")
        for g in glides[:6]:
            arrow = "↓" if g["direction"] == "down" else "↑"
            L.append("    %.2f–%.2fs  %s%.1f 半音 / %.2f 秒（%.0f 半音/秒，单调性 %.0f%%）" % (
                g["start"], g["end"], arrow, g["semitones"],
                g["seconds"], g.get("ratePerSec") or 0, g["monotonicity"] * 100))
    L.append("- 响度：中位 %.1f dB，峰值 %.1f dB" % (
        summary.get("dbMedian", 0), summary.get("dbMax", 0)))
    if summary.get("pitchOscillationFrames") is not None:
        L.append("- 音高振荡只统计过闸门的浊音帧（%d 帧）；"
                 "清音/静音、跨阶跃、断裂、纯滑音段都不给值" % summary["pitchOscillationFrames"])
    L.append("")

    # 换腔警告
    warn = summary.get("registerWarning")
    if warn:
        L.append("> ⚠ " + warn)
        for seg in summary.get("registerShifts") or []:
            L.append("> - %.2fs–%.2fs（%+.1f 半音）" % (seg["start"], seg["end"], seg["semitone"]))
        L.append("")
    runs = summary.get("voicedRuns") or []
    if runs:
        L.append("## 发声块")
        L.append("")
        L.append("| 起 | 止 | 类型 | 中位基频 |")
        L.append("|---|---|---|---|")
        for r in runs:
            kind = "浊音" if r.get("kind") == "voiced" else "清音（气声）"
            hz = ("%.1f Hz" % r["f0Median"]) if r.get("f0Median") else "—"
            L.append("| %.2fs | %.2fs | %s | %s |" % (r["start"], r["end"], kind, hz))
        L.append("")
    kinds = summary.get("segmentsByKind") or []
    if kinds:
        ks = summary.get("segmentSummary") or {}
        L.append("## 人声 / 背景 时间轴")
        L.append("")
        if ks.get("note"):
            L.append("> " + ks["note"])
            L.append("")
        L.append("| 起 | 止 | 类型 | 浊音 | 静音 | 状态切换 | 基频跳变P90 |")
        L.append("|---|---|---|---|---|---|---|")
        label = {"speech": "人声", "background": "背景", "mixed": "交织"}
        for sg in kinds:
            L.append("| %.2fs | %.2fs | %s | %.0f%% | %.0f%% | %.2f 次/秒 | %.2f 半音 |" % (
                sg.get("start", 0), sg.get("end", 0), label.get(sg.get("kind"), sg.get("kind")),
                (sg.get("voiced") or 0) * 100, (sg.get("silence") or 0) * 100,
                sg.get("switchPerSec") or 0, sg.get("jumpP90") or 0))
        L.append("")
        L.append("说明：这只是把整段切成「像人声 / 像背景」的时间区间，**没有**分离出独立音轨。"
                 "真正的源分离需要 demucs 之类的模型，不在本插件依赖范围内。")
        L.append("")
    segs = summary.get("segments") or []
    if segs:
        L.append("## 文本与韵律对照")
        L.append("")
        L.append("| 起 | 止 | 文本 | 基频 | 半音 | 微颤 |")
        L.append("|---|---|---|---|---|---|")
        for s in segs:
            txt = str(s.get("text", "")).replace("|", "\\|").strip()
            L.append("| %.2fs | %.2fs | %s | %s | %s | %s |" % (
                s.get("start", 0), s.get("end", 0), txt,
                ("%.1f Hz" % s["f0Median"]) if s.get("f0Median") else "—",
                ("%+.2f" % s["semitoneMedian"]) if s.get("semitoneMedian") is not None else "—",
                ("%.2f" % s["pitchOscillationMedian"]) if s.get("pitchOscillationMedian") is not None else "—"))
        L.append("")
    L.append("## 曲线")
    L.append("")
    L.append("完整逐帧数据见 prosody.json（%.2f 秒一帧）。" % curves["hop"])
    L.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--start", type=float, default=None)
    ap.add_argument("--duration", type=float, default=None)
    ap.add_argument("--hop", type=float, default=None,
                    help="分析帧长秒数（默认取配置 XIYOUNG_AUDIO_HOP，回落 0.01）")
    ap.add_argument("--fmin", type=float, default=None,
                    help="基频搜索下限 Hz（默认取配置 XIYOUNG_AUDIO_F0_MIN，回落 75）")
    ap.add_argument("--fmax", type=float, default=None,
                    help="基频搜索上限 Hz（默认取配置 XIYOUNG_AUDIO_F0_MAX，回落 400）")
    ap.add_argument("--json-only", action="store_true")
    ap.add_argument("--no-transcribe", action="store_true",
                    help="跳过语音转文字（默认有模型就转）")
    ap.add_argument("--no-speaker", action="store_true",
                    help="跳过说话人嵌入（默认装了 resemblyzer 就算）")
    ap.add_argument("--no-mfcc", action="store_true",
                    help="跳过 MFCC 声纹特征")
    ap.add_argument("--baseline", default=None,
                    help="基线文件（labels.json 或 batch.json），给了就算相对量")
    ap.add_argument("--compare", default=None,
                    help="给另一个音频路径，比较两者的说话人相似度")
    ap.add_argument("--lang", default=None, help="转写语言（默认取配置 XIYOUNG_AUDIO_LANGUAGE，回落 zh）")
    args = ap.parse_args()

    # 参数没给就从配置取（配置来自 Host 注入的环境变量）。
    # 之前 fmin/fmax/lang 的默认值是硬编码常量，所以 XIYOUNG_AUDIO_F0_MIN /
    # _F0_MAX / _LANGUAGE 这三个环境变量注入了却没人读——配置页改了不生效。
    if args.fmin is None:
        args.fmin = cfg_num("XIYOUNG_AUDIO_F0_MIN", 75.0)
    if args.fmax is None:
        args.fmax = cfg_num("XIYOUNG_AUDIO_F0_MAX", 400.0)
    if args.lang is None:
        args.lang = cfg_str("XIYOUNG_AUDIO_LANGUAGE", "zh")
    if args.hop is None:
        args.hop = cfg_num("XIYOUNG_AUDIO_HOP", 0.01)

    os.makedirs(args.outdir, exist_ok=True)
    print("[prosody] 解码音频", flush=True)
    wav = decode_to_wav(args.source, args.outdir, args.start, args.duration)
    y, sr = read_wav(wav)
    print("[prosody] 时长 %.2f 秒，采样率 %d" % (len(y) / sr, sr), flush=True)

    print("[prosody] 追踪基频", flush=True)
    a = analyze(y, sr, hop_s=args.hop, fmin=args.fmin, fmax=args.fmax)

    print("[prosody] 汇总", flush=True)
    summary = segment_summary(a, a["times"])
    curves = to_jsonable(a)

    # 语音转文字：有模型就转，转不了不影响分析结果
    transcript = None
    segments = []
    # transcriptStatus 是这次的关键新增：必须能区分"模型跑了但没出字"
    # 和"这段确实没人说话"。之前两者都是 transcript=None，调用方没法判断。
    transcript_status = "skipped"
    if not args.no_transcribe:
        model_info = find_sensevoice_model()
        if model_info:
            print("[prosody] 语音转文字", flush=True)
            transcript, segments, transcript_status = transcribe(
                wav, model_info[0], model_info[1], args.lang)
            if transcript_status == "ok" and transcript:
                segments = attach_segments(segments, a, a["times"])
                summary["transcript"] = transcript
                summary["segments"] = segments
                print("[prosody] 转写 %d 字，%d 段" % (len(transcript), len(segments)), flush=True)
            elif transcript_status == "punct":
                print("[prosody] 转写只出了标点/语气词（这段可能没人说话）：%r"
                      % (transcript or "")[:20], flush=True)
                summary["transcript"] = transcript
            elif transcript_status == "empty":
                print("[prosody] 模型跑完了但没出字（这段可能没人说话）", flush=True)
            elif transcript_status == "no_model":
                print("[prosody] SenseVoice 模型加载失败（环境问题，不是音频问题）", flush=True)
            elif transcript_status == "decode_fail":
                print("[prosody] 音频解码失败", flush=True)
        else:
            transcript_status = "no_model"
            print("[prosody] 没找到 SenseVoice 模型，跳过转写", flush=True)
    summary["transcriptStatus"] = transcript_status

    # 语速：需要转写的逐句时间。没有转写就没有这一项（不猜）。
    try:
        sr_stats = speaking_rate(segments, summary.get("duration") or 0.0)
        if sr_stats:
            summary.update(sr_stats)
    except Exception:
        pass

    # 疑似非人声检测：噪声会被当成"沙哑低语"，数字看着很正经但全是假的。
    is_non_speech, reasons = detect_non_speech(a, summary, transcript)
    # 音乐性评分单独暴露，即使没判成非人声也能看到
    try:
        _m = _music_diagnose(a, summary)
        if _m["score"] >= 2:
            summary["musicLike"] = _m
    except Exception:
        pass
    # 唱歌检测：是人声，但不该当"说话语气"用
    try:
        _sing = detect_singing(a, summary)
        if _sing:
            summary["singingLike"] = _sing
            print("[prosody] 提示：" + _sing["warning"], flush=True)
    except Exception:
        pass

    if is_non_speech:
        summary["suspectedNonSpeech"] = True
        summary["nonSpeechReasons"] = reasons
        summary["nonSpeechWarning"] = (
            '这段可能是噪声而不是人声：上面的基频/音域/微颤是按「有周期」算出来的，'
            '但曲线在随机漂移，数字不可信。不要当成声音素材导入样本库。'
        )
        print("[prosody] 警告：疑似非人声（" + "；".join(reasons) + "）", flush=True)
    else:
        summary["suspectedNonSpeech"] = False

    # 统一裁决：音乐性和"疑似非人声"可能同时有分，调用方不该自己猜谁算数。
    # 实测 buried.wav（人声被音乐盖住）：musicLike.score=2 但 suspectedNonSpeech=false，
    # 两个字段指方向相反——那是对的（里面确实有人声），但接口上要讲清优先级。
    #
    # 位置很重要：必须放在 suspectedNonSpeech 赋值**之后**。
    # 之前放在前面，白噪声读到的还是旧的 False，contentClass 报成了 speech。
    summary["contentClass"] = _classify_content(summary, transcript=transcript, transcript_status=transcript_status)

    # 背景音 / 人声 的时间定位。
    # 交接书原话是"能识别但无法分离"——分离要源分离模型，这里不装新依赖；
    # 但"哪几秒是人声、哪几秒是背景"用已有的逐帧 state 就能答，这是能落地的部分。
    try:
        segs = segment_speech_background(a, summary, segments, hop=a.get("hop"))
        summary["segmentsByKind"] = segs
        summary["segmentSummary"] = summarize_segments(segs)
        if segs:
            print("[prosody] 时间轴定位 %d 段，%s" % (len(segs), summary["segmentSummary"]["note"]), flush=True)
    except Exception as e:
        summary["segmentsByKind"] = []
        summary["segmentSummary"] = None
        print("[prosody] 背景音定位失败：%s" % str(e)[:120], flush=True)

    # MFCC 声纹特征（13 维均值）：比韵律强一截，但不如嵌入模型
    mfcc = None
    if not args.no_mfcc:
        print("[prosody] MFCC 特征", flush=True)
        try:
            mfcc = [round(float(v), 4) for v in mfcc_features(y, sr)]
            print("[prosody] MFCC %d 维" % len(mfcc), flush=True)
        except Exception as e:
            print("[prosody] MFCC 失败：%s" % str(e)[:100], flush=True)

    # 说话人嵌入：给一段音频算 256 维向量，用于比较"是不是同一个人"
    speaker = None
    speaker_error = None
    if not args.no_speaker:
        print("[prosody] 说话人嵌入", flush=True)
        speaker, speaker_error = speaker_embedding(y, sr)
        if speaker:
            print("[prosody] 嵌入 %d 维" % len(speaker), flush=True)
        else:
            print("[prosody] 跳过：%s" % speaker_error, flush=True)

    # 变化点：把"这里变了没有"做成可验证的输出
    changes = detect_changes(a, summary)
    change_summary = summarize_changes(changes, summary.get("duration") or 0)
    if changes:
        print("[prosody] 变化点 %d 处：%s" % (len(changes), change_summary["note"]), flush=True)

    # 相对基线：把绝对数字换成"跟谁比、偏了多少"
    relative = None
    if args.baseline:
        print("[prosody] 计算相对基线", flush=True)
        base = load_baseline_from_labels(args.baseline)
        if base is None:
            try:
                import json as _json
                with open(args.baseline, encoding="utf-8") as _f:
                    _d = _json.load(_f)
                base = baseline_from_batch(_d.get("records") or [])
            except Exception:
                base = None
        if base:
            relative = build_relative(summary, base)
            it = relative.get("intensity")
            if it:
                print("[prosody] %s" % it.get("note", ""), flush=True)
                for n in (it.get("notable") or [])[:3]:
                    print("[prosody]   - %s" % n.get("note", ""), flush=True)
        else:
            print("[prosody] 基线不足（少于 5 条），跳过", flush=True)

    payload = {
        "source": args.source,
        "decoded": wav,
        "sampleRate": sr,
        "hop": curves["hop"],
        "refHz": curves["refHz"],
        "summary": summary,
        "transcript": transcript,
        "segments": segments,
        "mfcc": mfcc,
        "changes": changes,
        "changeSummary": change_summary,
        "relative": relative,
        "speaker": speaker,
        "speakerError": speaker_error,
        "curves": curves,
    }
    json_path = os.path.join(args.outdir, "prosody.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print("[prosody] 已写 %s" % json_path, flush=True)

    # --compare：和另一段音频比"是不是同一个人"
    # 对比：嵌入和 MFCC 各自独立可用（--no-speaker 时 MFCC 仍能比）
    if args.compare and (speaker or mfcc):
        cmp_dir = os.path.join(args.outdir, "_cmp")
        os.makedirs(cmp_dir, exist_ok=True)
        other_wav = decode_to_wav(args.compare, cmp_dir, None, None)
        oy, osr = read_wav(other_wav)
        cmp_result = {"source": args.compare}

        if speaker:
            other, other_err = speaker_embedding(oy, osr)
            if other:
                sim = cosine_similarity(speaker, other)
                cmp_result["similarity"] = sim
                cmp_result["verdict"] = speaker_verdict(sim)
                print("[prosody] 说话人相似度 %.4f（%s）" % (sim, speaker_verdict(sim)), flush=True)
            else:
                cmp_result["speakerError"] = other_err
                print("[prosody] 嵌入对比失败：%s" % other_err, flush=True)

        if mfcc:
            try:
                other_mfcc = mfcc_features(oy, osr)
                md = mfcc_distance(mfcc, other_mfcc)
                cmp_result["mfccDistance"] = md
                cmp_result["mfccVerdict"] = mfcc_verdict(md)
                print("[prosody] MFCC 距离 %.2f（%s）" % (md, mfcc_verdict(md)), flush=True)
                print("[prosody] 注意：MFCC 对录音设备敏感，跨来源比较不可靠；"
                      "判同人请看上面的说话人相似度", flush=True)
            except Exception as e:
                cmp_result["mfccError"] = str(e)[:120]

        if len(cmp_result) > 1:
            payload["speakerCompare"] = cmp_result
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)

    if not args.json_only:
        md_path = os.path.join(args.outdir, "prosody.md")
        write_markdown(md_path, summary, curves, {"source": args.source})
        print("[prosody] 已写 %s" % md_path, flush=True)

    print("[prosody] done", flush=True)


if __name__ == "__main__":
    main()
