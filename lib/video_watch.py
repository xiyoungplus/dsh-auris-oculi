#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
video_watch.py — 把一条视频切成带时间戳的拼图，逐张交给本机 Ollama 视觉模型，
再把逐格描述整理成 Markdown 报告。

用法示例：
  python video_watch.py "https://www.bilibili.com/video/BV16v4w63EeV"
  python video_watch.py BV16v4w63EeV --interval 2 --max-sheets 24 --model qwen3.5:4b
  python video_watch.py URL --summary

依赖：yt-dlp、ffmpeg、Pillow、本机 Ollama（默认 http://127.0.0.1:11434）。
建议用 DSH 自带 Python（含 Pillow）运行：
  %USERPROFILE%/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
"""

import argparse
import base64
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.error
import urllib.request

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
except Exception:
    Image = None

DEFAULT_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b")



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


def detect_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for candidate in (
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
        r"C:\ffmpeg\bin\ffmpeg.exe",
        os.path.expanduser("~/scoop/apps/ffmpeg/current/bin/ffmpeg.exe"),
    ):
        if os.path.exists(candidate):
            return candidate
    return "ffmpeg"


FFMPEG = detect_ffmpeg()

PROMPT = """这是一张由 {n} 个视频画面拼成的图，每个格子左上角有黄色时间戳（mm:ss）。请逐格描述这一格的画面。

要求：
1. 只描述你真正看到的内容，绝对不要推测剧情、动机或前后因果；看不清就写"看不清"。
2. 用中文，具体一些：画面场景、角色/物体（外形、颜色、衣着）、正在发生的动作、画面里出现的文字或字幕（原样抄写，没有就写"无"）、镜头或画风。
3. 注意：每格左上角的黄色时间戳是拼图标注，不是画面字幕；不要把时间戳写进 text 字段。text 只抄写画面内部的文字或字幕，没有就写"无"。
4. 严格输出一个 JSON 对象：{{"items":[{{"time":"mm:ss","scene":"场景","characters":"角色/物体","action":"动作","text":"画面文字或字幕，无则填无"}}]}}，不要输出任何其他文字。"""


def log(msg):
    """打印日志。

    ⚠ 不要用 ≥U+2000 的符号（⚠ ✓ 之类的 emoji、破折号以外的装饰字符）：
    这些脚本在 Windows 上可能以 GBK 输出，遇到无法编码的字符会直接抛
    UnicodeEncodeError 把任务打断。实测 `⚠` 就会触发：
      ERROR: 'gbk' codec can't encode character '\u26a0'
    这里加一层兜底，把无法编码的字符替换掉，而不是让整条任务失败。
    """
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        safe = str(msg).encode(enc, "replace").decode(enc, "replace")
        print(safe, flush=True)


def run(cmd, cwd=None, timeout=None):
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("命令失败 (%s):\n%s\n%s" % (" ".join(cmd), p.stdout[-2000:], p.stderr[-2000:]))
    return p.stdout


def which_ytdlp():
    env = os.environ.get("YTDLP")
    if env and os.path.exists(env):
        return [env]
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    # Windows: pip --user 安装位置不在 PATH
    patterns = [
        os.path.expanduser("~/AppData/Roaming/Python/Python*/Scripts/yt-dlp.exe"),
        os.path.expanduser("~/AppData/Local/Programs/Python/Python*/Scripts/yt-dlp.exe"),
    ]
    for pat in patterns:
        hits = sorted(glob.glob(pat))
        if hits:
            return [hits[-1]]
    # 最后尝试当前 Python 的模块
    try:
        run([sys.executable, "-m", "yt_dlp", "--version"], timeout=30)
        return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        pass
    raise RuntimeError(
            "下载 B 站视频需要一个叫 yt-dlp 的小工具，现在还没装。\n"
            "对 DSH 说一句「帮我装 yt-dlp」就行。\n"
            "（本地文件不受影响，只有在线链接需要它）"
        )


def fetch_meta(url, ytdlp, extra=()):
    out = run(ytdlp + ["-J", "--no-warnings", *extra, url], timeout=180)
    return json.loads(out)


def pick_video_url(meta):
    # 直接返回原始 webpage_url；下载时让 yt-dlp 选格式
    return meta.get("webpage_url") or meta.get("original_url")


def probe_best_format(url, ytdlp, max_short_side, extra=()):
    """自己挑格式，不依赖 yt-dlp 的排序。

    为什么要自己挑：实测（BV1LTsA6aE9g）这个视频有 360/480/720/1080 四档，
    但 `bv*[height<=720]+ba` 这种写法会选中 **360**，`-S res` 也一样。
    yt-dlp 对这个站点的默认排序并不按像素降序，靠选择器表达式挑不可靠。

    这里改成：拉一遍 -j 的元数据 → 按 pixels 降序 → 在短边上限内取最大的那个 →
    用 format_id 精确指定。拿不到就返回 None，由调用方退回通用选择器。
    """
    try:
        out = run(ytdlp + ["-j", "--no-warnings", "--no-playlist", *extra, url], timeout=180)
        info = json.loads(out)
    except Exception as e:
        log("[download] 无法探测格式（%s），改用通用选择器" % str(e)[:80])
        return None

    formats = info.get("formats") or []
    vids = []
    for f in formats:
        if f.get("vcodec") in (None, "none"):
            continue
        w, h = f.get("width") or 0, f.get("height") or 0
        if w <= 0 or h <= 0:
            continue
        short = min(w, h)
        if short > max_short_side:
            continue
        vids.append((w * h, f.get("format_id"), w, h, f.get("tbr") or 0))

    if not vids:
        log("[download] 短边 <=%sp 内没有可用视频轨" % max_short_side)
        return None

    # 像素降序；同像素时偏向 avc1/h264（兼容性最好，避免 av1 解码失败）
    def score(item):
        pixels, fid, w, h, tbr = item
        return (pixels, tbr)
    vids.sort(key=score, reverse=True)
    pixels, fid, w, h, tbr = vids[0]
    log("[download] 选中格式 %s（%dx%d，短边 %d，%.0fk）" % (fid, w, h, min(w, h), tbr))
    return fid


def _link_or_copy(src, dst):
    """同一盘符用硬链接（零拷贝），跨盘/无权限时退回复制。"""
    try:
        if os.path.exists(dst):
            os.remove(dst)
        os.link(src, dst)
        return
    except Exception:
        pass
    shutil.copy2(src, dst)


def _download_cache_key(vid, height, seg_start, seg_duration):
    """缓存键：视频 id + 下载短边 + 时间段。整条与分段各存一份，互不覆盖。"""
    key = "%s-%sp" % (vid or "video", int(height))
    if seg_start is not None and seg_duration:
        key += "-%d-%d" % (int(round(seg_start)), int(round(seg_duration)))
    return key


def download_video(url, outdir, ytdlp, height=1080, extra=(), vid=None, cache_dir=None,
                   seg_start=None, seg_duration=None, section=True):
    """下载视频（或只下载某一段）。

    2026-11-27 补丁（社区贡献）：
      * cache_dir：按「视频 id + 短边 + 时间段」缓存。同一视频看第二段不必重下整条；
      * seg_start/seg_duration：给了时间段就只下这一段（yt-dlp --download-sections），
        段下载失败自动退回整条，不影响原行为。
    """
    video = os.path.join(outdir, "video.mp4")
    if os.path.exists(video) and os.path.getsize(video) > 10000:
        log("[download] 已存在 video.mp4，跳过下载")
        return video

    cached = None
    if cache_dir:
        try:
            os.makedirs(cache_dir, exist_ok=True)
            cached = os.path.join(
                cache_dir,
                _download_cache_key(vid, height, seg_start, seg_duration) + ".mp4")
        except Exception as e:
            log("[download] 缓存目录不可用（%s），这次不缓存" % e)
            cached = None
        if cached and os.path.exists(cached) and os.path.getsize(cached) > 10000:
            log("[download] 缓存命中：%s（跳过下载）" % os.path.basename(cached))
            _link_or_copy(cached, video)
            return video

    target = cached or video
    log("[download] 下载中（短边 <=%sp）..." % height)

    # 只用 height<=N 会把竖屏片全排除掉（竖屏的高度从 538 起，480 一个都不匹配）。
    # 改成"短边"判据：横屏看 height，竖屏看 width，两者取小。
    best = probe_best_format(url, ytdlp, height, extra)
    if best:
        fmt = "%s+ba/b" % best
    else:
        # 探测失败时的兜底：从高到低逐级放宽
        fmt = "/".join([
            "bv*[height<=%d]+ba" % height,
            "bv*[width<=%d]+ba" % height,
            "bv*+ba/b",
        ])

    sec_args = []
    if section and seg_start is not None and seg_duration:
        sec_args = [
            "--download-sections",
            "*%.3f-%.3f" % (float(seg_start), float(seg_start) + float(seg_duration)),
            "--force-keyframes-at-cuts",
            "--downloader", "ffmpeg",
        ]
        log("[download] 只下载 %s – %s 这一段" % (
            fmt_time(seg_start), fmt_time(seg_start + seg_duration)))

    def attempt(fmt_expr, use_section):
        argv = ["-f", fmt_expr, "--merge-output-format", "mp4", "--no-warnings"]
        if use_section and sec_args:
            argv += sec_args
        argv += ["-o", target, *extra, url]
        run(ytdlp + argv, timeout=1800)

    try:
        attempt(fmt, True)
    except RuntimeError as e:
        msg = str(e)
        if sec_args:
            # 段下载不是所有站点都支持（有些格式走不了 ffmpeg 下载器），退回整条
            log("[download] 段下载失败（%s），退回整条下载" % msg.splitlines()[-1][:120])
            try:
                attempt(fmt, False)
            except RuntimeError as e2:
                if "not available" in str(e2):
                    log("[download] 指定格式不可用，退回最佳可用格式重试")
                    attempt("bv*+ba/b", False)
                else:
                    raise
        elif "Requested format is not available" in msg or "not available" in msg:
            # 格式挑不到（竖屏、特殊编码、需要登录等）时退回"任意最佳"，别直接失败
            log("[download] 指定格式不可用，退回最佳可用格式重试")
            attempt("bv*+ba/b", False)
        else:
            raise

    if target != video:
        if not os.path.exists(target):
            # yt-dlp 可能在 target 旁加了后缀（video.mkv / video.webm），
            # 之前这里 glob 的是 outdir，但 target 通常指向 cache_dir，
            # 所以加了后缀时找不到文件、误报「下载完成但找不到 video」。
            tdir = os.path.dirname(target) or outdir
            stem = os.path.splitext(os.path.basename(target))[0]
            hits = sorted(glob.glob(os.path.join(tdir, stem + '.*')))
            if hits:
                target = hits[0]
        if not os.path.exists(target):
            raise RuntimeError("下载完成但找不到 video 文件")
        _link_or_copy(target, video)
    elif not os.path.exists(video):
        # yt-dlp 可能加了 .mp4 后缀或其他容器
        hits = sorted(glob.glob(os.path.join(outdir, "video.*")))
        if hits:
            video = hits[0]
    if not os.path.exists(video):
        raise RuntimeError("下载完成但找不到 video 文件")
    log("[download] 完成：%s (%.1f MB)" % (video, os.path.getsize(video) / 1048576))
    return video


def extract_frames_scene(video, frames_dir, interval, width, start=None,
                         seg_duration=None, threshold=None):
    """按画面变化抽帧（density="smart" 的实现）。

    和 extract_frames 的区别：
        固定间隔 → 不看内容，静态画面浪费帧、动态画面漏掉变化
        画面变化 → 抓真正变了的时刻

    但纯 scene 检测在静态视频（访谈、板书）上会抽不到帧，
    所以最后会补足到「按固定间隔应有的数量」，保证下限。

    阈值越高越挑（默认 0.30，越高帧越少）。
    """
    os.makedirs(frames_dir, exist_ok=True)
    existing = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    if existing:
        log("[frames] 已存在 %d 帧，跳过抽帧" % len(existing))
        return existing

    if threshold is None:
        threshold = cfg_num("XIYOUNG_VIDEO_SCENE_THRESHOLD", 0.30)
    threshold = max(0.05, min(0.9, float(threshold)))

    span = ""
    if start is not None or seg_duration is not None:
        span = "（只处理 %s 起%s）" % (
            fmt_time(start or 0),
            (" 的 %s" % fmt_time(seg_duration)) if seg_duration else " 到结尾")
    log("[frames] 按画面变化抽帧（阈值 %.2f），宽度 %d%s..." % (threshold, width, span))

    # 第一遍：只抽画面变化点
    vf = "select='gt(scene,%.3f)',scale=%d:-2" % (threshold, width)
    cmd = [FFMPEG, "-y"]
    if start is not None and start > 0:
        cmd += ["-ss", "%.3f" % start]
    cmd += ["-i", video]
    if seg_duration is not None and seg_duration > 0:
        cmd += ["-t", "%.3f" % seg_duration]
    cmd += ["-vf", vf, "-fps_mode", "vfr", "-q:v", "2",
            os.path.join(frames_dir, "frame_%05d.jpg")]
    try:
        run(cmd, timeout=1800)
    except RuntimeError as e:
        # 老版本 ffmpeg 没有 -fps_mode
        log("[frames] scene 抽帧失败（%s），退回固定间隔" % str(e).splitlines()[-1][:80])
        for f in glob.glob(os.path.join(frames_dir, "frame_*.jpg")):
            try:
                os.remove(f)
            except Exception:
                pass
        return extract_frames(video, frames_dir, interval, width, start, seg_duration)

    scene_frames = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    log("[frames] 画面变化点：%d 帧" % len(scene_frames))

    # 第二遍：算按固定间隔应该有多少帧，不够就补
    total = seg_duration
    if total is None:
        total = meta_duration(video)
    if total and interval > 0:
        want = max(1, int(round(total / interval)))
        if len(scene_frames) < want:
            need = want - len(scene_frames)
            log("[frames] 变化点只有 %d 帧，补 %d 帧到固定间隔密度" % (len(scene_frames), need))
            # 在整段上均匀取点，只补还没覆盖的时间
            base = len(scene_frames)
            step = total / float(want)
            added = 0
            for k in range(want):
                if added >= need:
                    break
                abs_t = (start or 0.0) + k * step
                idx = base + added + 1
                p = os.path.join(frames_dir, "frame_%05d.jpg" % idx)
                c = [FFMPEG, "-y", "-ss", "%.3f" % abs_t, "-i", video,
                     "-frames:v", "1", "-vf", "scale=%d:-2" % width,
                     "-q:v", "2", p]
                try:
                    run(c, timeout=120)
                    if os.path.exists(p):
                        added += 1
                except Exception:
                    pass
            log("[frames] 补了 %d 帧" % added)

    frames = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    log("[frames] 共 %d 帧" % len(frames))
    return frames


def meta_duration(video):
    """读视频时长（秒）。失败返回 None。"""
    # 没有 FFPROBE 常量（其他地方是 FFMPEG.replace 现算的），这里同样处理
    ffprobe = FFMPEG.replace("ffmpeg", "ffprobe") if FFMPEG else "ffprobe"
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", video],
            capture_output=True, text=True, timeout=30)
        return float((out.stdout or "").strip())
    except Exception:
        return None


def extract_frames(video, frames_dir, interval, width, start=None, seg_duration=None):
    """抽帧。start/seg_duration 用来只处理视频的一段。

    用 -ss 放在 -i 前面（快速定位，不解码前面的内容）+ -t 限制长度。
    注意 -ss 在 -i 前是"关键帧定位"，可能偏几十毫秒；对抽帧用途足够。
    """
    os.makedirs(frames_dir, exist_ok=True)
    existing = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    if existing:
        log("[frames] 已存在 %d 帧，跳过抽帧" % len(existing))
        return existing
    span = ""
    if start is not None or seg_duration is not None:
        span = "（只处理 %s 起%s）" % (
            fmt_time(start or 0),
            (" 的 %s" % fmt_time(seg_duration)) if seg_duration else " 到结尾")
    log("[frames] 每 %.2f 秒抽一帧，宽度 %d%s..." % (interval, width, span))
    # 用 fps 过滤器有个问题：它从段起点开始每隔 interval 取一帧，
    # 最后一帧可能离段末尾还有将近一个 interval（实测 30 秒段 / 6 秒间隔，
    # 只抽到 01:24，01:24–01:30 完全没看）。
    # 改成先按 fps 抽，再单独补一帧段末尾——补的那帧如果和最后一帧太近就跳过。
    vf = "fps=1/%s,scale=%d:-2" % (("%.4f" % interval).rstrip("0").rstrip("."), width)
    cmd = [FFMPEG, "-y"]
    if start is not None and start > 0:
        cmd += ["-ss", "%.3f" % start]
    cmd += ["-i", video]
    if seg_duration is not None and seg_duration > 0:
        cmd += ["-t", "%.3f" % seg_duration]
    cmd += ["-vf", vf, "-q:v", "2",
            os.path.join(frames_dir, "frame_%05d.jpg")]
    run(cmd, timeout=1800)

    # 补末尾帧：段末尾往前 0.2 秒取一张，只有当它比最后一帧晚半个 interval 以上才补
    frames = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    if frames and seg_duration and seg_duration > interval * 0.5:
        last_idx = len(frames)
        last_t = (last_idx - 1) * interval
        tail_t = max(0.0, seg_duration - 0.2)
        if tail_t - last_t > interval * 0.5:
            tail_path = os.path.join(frames_dir, "frame_%05d.jpg" % (last_idx + 1))
            tail_cmd = [FFMPEG, "-y"]
            abs_t = (start or 0.0) + tail_t
            tail_cmd += ["-ss", "%.3f" % abs_t, "-i", video, "-frames:v", "1",
                         "-vf", "scale=%d:-2" % width, "-q:v", "2", tail_path]
            try:
                run(tail_cmd, timeout=120)
                if os.path.exists(tail_path):
                    log("[frames] 补末尾帧 %.2f 秒" % abs_t)
            except Exception:
                pass   # 补帧失败不影响主流程
    frames = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    frames = sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))
    log("[frames] 共 %d 帧" % len(frames))
    return frames


def fmt_time(seconds):
    seconds = int(round(seconds))
    return "%02d:%02d" % (seconds // 60, seconds % 60)


def parse_time(value):
    """把 90 / "90" / "1:30" / "01:30" / "0:01:30" 解析成秒数。

    返回 None 表示没给；无法解析时抛 ValueError。
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        sec = float(value)
        if sec < 0:
            raise ValueError("时间不能是负数：%r" % (value,))
        return sec
    s = str(value).strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        raise ValueError("看不懂的时间格式：%r（支持 90 / 1:30 / 0:01:30）" % (s,))
    if len(nums) == 1:
        total = nums[0]
    elif len(nums) == 2:
        total = nums[0] * 60 + nums[1]
    elif len(nums) == 3:
        total = nums[0] * 3600 + nums[1] * 60 + nums[2]
    else:
        raise ValueError("时间格式太多段：%r" % (s,))
    if total < 0:
        raise ValueError("时间不能是负数：%r" % (s,))
    return total


def build_sheets(frames, sheets_dir, frames_per_sheet, sheet_width, interval, time_offset=0.0, per_row_arg=2):
    """把帧拼成带时间戳的图。

    time_offset：只处理某一段时，帧序号从 0 开始，但真实视频时间是
    offset + idx*interval。不传这个，报告里的时间戳会和视频对不上。
    """
    os.makedirs(sheets_dir, exist_ok=True)
    manifest_path = os.path.join(os.path.dirname(sheets_dir), "sheets_manifest.json")
    if os.path.exists(manifest_path):
        try:
            old = json.load(open(manifest_path, encoding="utf-8"))
            if old and len(old) >= 1:
                # 如果张数一致就复用
                expected = int(math.ceil(len(frames) / frames_per_sheet))
                if len(old) == expected and all(os.path.exists(os.path.join(sheets_dir, m["file"])) for m in old):
                    log("[sheets] 已存在 %d 张拼图，复用" % len(old))
                    return old
        except Exception:
            pass

    if Image is None:
        raise RuntimeError(
            "处理图片需要一个叫 Pillow 的组件，现在还没装。\n"
            "打开插件页面，点「检查环境」可以一键装上。"
        )

    per_row = max(1, int(per_row_arg or 2))
    rows = int(math.ceil(frames_per_sheet / per_row))

    # 格子宽高比跟随真实画面，不强制 16:9。
    #
    # 实测（48 帧竖屏 800x1420 的 B 站视频）：
    #   强制 16:9 的 640 宽拼图 → 单格 320x180 → contain 后画面只有 101x180，
    #   左右两侧全是黑边，字幕糊成一团；
    #   同样的帧按竖屏比例拼到 1200 宽 → 单格 600x1065 → 画面 600x1065，
    #   每句字幕都能读出来。差 11 倍面积，全浪费在黑边上。
    #
    # 所以这里取第一帧的宽高比定格子形状：竖屏片格子就是竖的，横屏片才是 16:9。
    aspect = 9.0 / 16.0
    if frames:
        try:
            with Image.open(frames[0]) as probe:
                if probe.width > 0 and probe.height > 0:
                    aspect = float(probe.height) / float(probe.width)
        except Exception:
            pass
        # 极端比例会把一维撑爆，夹在 0.5（超宽）~ 2.2（超高）之间
        aspect = max(0.5, min(2.2, aspect))

    cell_w = sheet_width // per_row
    cell_h = int(round(cell_w * aspect))
    sheet_w = cell_w * per_row
    sheet_h = cell_h * rows

    font = None
    for fp in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/msyhbd.ttc"):
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, max(14, cell_w // 18))
                break
            except Exception:
                pass
    if font is None:
        font = ImageFont.load_default()

    meta = []
    sheet_no = 0
    for start in range(0, len(frames), frames_per_sheet):
        chunk = frames[start:start + frames_per_sheet]
        sheet_no += 1
        canvas = Image.new("RGB", (sheet_w, sheet_h), (16, 16, 16))
        draw = ImageDraw.Draw(canvas)
        times = []
        for k, fp in enumerate(chunk):
            idx = int(re.search(r"(\d+)", os.path.basename(fp)).group(1))
            seconds = time_offset + (idx - 1) * interval
            label = fmt_time(seconds)
            # 超过 1 小时的时间戳要带小时，否则 3700s 会显示成 61:40
            if seconds >= 3600:
                label = "%d:%02d:%02d" % (seconds // 3600, (seconds % 3600) // 60, seconds % 60)
            times.append({"time": label, "seconds": round(seconds, 2), "frame": os.path.basename(fp)})
            cell_x = (k % per_row) * cell_w
            cell_y = (k // per_row) * cell_h
            im = Image.open(fp).convert("RGB")
            im = ImageOps.contain(im, (cell_w, cell_h), Image.LANCZOS)
            canvas.paste(im, (cell_x + (cell_w - im.width) // 2, cell_y + (cell_h - im.height) // 2))
            bbox = draw.textbbox((0, 0), label, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.rectangle([cell_x + 4, cell_y + 4, cell_x + tw + 20, cell_y + th + 16], fill=(0, 0, 0))
            draw.text((cell_x + 10, cell_y + 6), label, font=font, fill=(255, 255, 0))
        for r in range(1, rows):
            draw.line([(0, r * cell_h), (sheet_w, r * cell_h)], fill=(70, 70, 70), width=2)
        for c in range(1, per_row):
            draw.line([(c * cell_w, 0), (c * cell_w, sheet_h)], fill=(70, 70, 70), width=2)
        out = os.path.join(sheets_dir, "sheet_%03d.jpg" % sheet_no)
        canvas.save(out, quality=92)
        meta.append({"sheet": sheet_no, "file": os.path.basename(out),
                     "range": "%s-%s" % (times[0]["time"], times[-1]["time"]), "frames": times})
        log("[sheets] %s  (%s–%s)" % (os.path.basename(out), times[0]["time"], times[-1]["time"]))

    json.dump(meta, open(manifest_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    log("[sheets] 共 %d 张" % len(meta))
    return meta


def ollama_tags(host):
    with urllib.request.urlopen(host + "/api/tags", timeout=10) as r:
        return json.loads(r.read().decode("utf-8")).get("models", [])




# ---------------------------------------------------------------------------
# 模型后端抽象
#
# 原来只认 Ollama 的 /api/generate。不是每个人都有本地 Ollama：
#   - 有人用 LM Studio / vLLM / OneAPI（OpenAI 兼容协议）
#   - 有人直接调云端 API
#   - 有人用 Ollama 但跑在另一台机器
#
# 这里抽象成 provider：
#   ollama      本机或远程 Ollama（/api/generate）
#   openai      任何 OpenAI 兼容接口（/v1/chat/completions）
#
# 选择由环境变量 XIYOUNG_MODEL_PROVIDER 决定，Host 从配置注入。
# ---------------------------------------------------------------------------

def model_provider():
    return cfg_str("XIYOUNG_MODEL_PROVIDER", "ollama").lower()


def model_api_key():
    return cfg_str("XIYOUNG_MODEL_API_KEY", "")


def model_base_url():
    """后端根地址。ollama 默认 11434，openai 必须显式给。"""
    host = cfg_str("XIYOUNG_MODEL_HOST", "")
    if host:
        return host.rstrip("/")
    return "http://127.0.0.1:11434" if model_provider() == "ollama" else ""


def model_name():
    return cfg_str("XIYOUNG_MODEL_NAME", "qwen3.5:4b")


def _http_json(url, payload, headers, timeout):
    import urllib.request
    import urllib.error
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 把后端返回的错误正文带出来，否则只看到 "400 Bad Request" 没法排查
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        raise RuntimeError("HTTP %s: %s" % (e.code, body or e.reason))


def generate(host=None, model=None, prompt="", image_b64=None,
             num_predict=None, num_ctx=None, timeout=None, fmt="json", think=False):
    """统一的文本/视觉生成入口。按 provider 分发。

    返回模型输出的文本。失败抛异常（调用方负责重试）。
    """
    provider = model_provider()
    base = (host or model_base_url()).rstrip("/")
    name = model or model_name()
    npred = num_predict if num_predict is not None else cfg_num("XIYOUNG_MODEL_NUM_PREDICT", 600)
    nctx = num_ctx if num_ctx is not None else cfg_num("XIYOUNG_MODEL_NUM_CTX", 8192)
    tmo = timeout if timeout is not None else cfg_num("XIYOUNG_MODEL_TIMEOUT_SEC", 600)

    if provider == "ollama":
        payload = {
            "model": name,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": npred, "num_ctx": nctx},
        }
        if image_b64:
            payload["images"] = [image_b64]
        if fmt:
            payload["format"] = fmt
        if think is not None:
            payload["think"] = think
        out = _http_json(base + "/api/generate", payload,
                         {"Content-Type": "application/json"}, tmo)
        return out.get("response", "")

    if provider == "openai":
        # OpenAI 兼容：图片走 image_url + data URI
        content = [{"type": "text", "text": prompt}]
        if image_b64:
            content.append({
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64," + image_b64},
            })
        payload = {
            "model": name,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.2,
            "max_tokens": npred,
            "stream": False,
        }
        if fmt == "json":
            # 多数 OpenAI 兼容实现支持这个；不支持的会忽略
            payload["response_format"] = {"type": "json_object"}
        headers = {"Content-Type": "application/json"}
        key = model_api_key()
        if key:
            headers["Authorization"] = "Bearer " + key
        out = _http_json(base + "/v1/chat/completions", payload, headers, tmo)
        try:
            return out["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("OpenAI 兼容接口返回格式不对：%s" % json.dumps(out)[:300])

    raise RuntimeError("未知的模型后端：%s（可选 ollama / openai）" % provider)


def list_models():
    """扫描后端可用的模型列表。

    返回 {"ok": bool, "models": [{"name":..., "vision": bool|null}], "error": str|null}
    """
    provider = model_provider()
    base = model_base_url()
    if not base:
        return {"ok": False, "models": [], "error": "没有配置后端地址"}

    headers = {"Content-Type": "application/json"}
    if provider == "openai":
        key = model_api_key()
        if key:
            headers["Authorization"] = "Bearer " + key

    try:
        # 两个接口都是 GET，不能用 _http_json（它总带 body 走 POST，
        # Ollama 的 /api/tags 会返回 405）
        import urllib.request
        import urllib.error
        url = base + ("/api/tags" if provider == "ollama" else "/v1/models")
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            out = json.loads(r.read().decode("utf-8"))

        models = []
        if provider == "ollama":
            for m in out.get("models") or []:
                caps = m.get("capabilities") or []
                models.append({
                    "name": m.get("name"),
                    "size": m.get("size"),
                    # Ollama 新版给 capabilities；老版没有就是 null（未知）
                    "vision": ("vision" in caps) if caps else None,
                })
        else:
            for m in out.get("data") or []:
                models.append({"name": m.get("id"), "size": None, "vision": None})
        return {"ok": True, "models": models, "error": None}
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        return {"ok": False, "models": [], "error": "HTTP %s: %s" % (e.code, body or e.reason)}
    except Exception as e:
        return {"ok": False, "models": [], "error": str(e)[:200]}

    return {"ok": False, "models": [], "error": "未知后端：" + provider}


def ollama_generate(host=None, model=None, prompt="", image_b64=None, num_predict=600,
                    num_ctx=8192, timeout=600, fmt="json", think=False):
    """兼容旧签名的转发。实际分发在 generate()。

    保留这个名字是因为 analyze_one_sheet 等调用点都用它；
    换成 generate() 会导致调用点全改，没必要。
    """
    return generate(host=host, model=model, prompt=prompt, image_b64=image_b64,
                    num_predict=num_predict, num_ctx=num_ctx, timeout=timeout,
                    fmt=fmt, think=think)


def parse_items(text):
    try:
        obj = json.loads(text)
    except Exception:
        return []
    if isinstance(obj, dict):
        for k in ("items", "frames", "results", "data"):
            if isinstance(obj.get(k), list):
                return obj[k]
        return [obj] if obj.get("time") else []
    if isinstance(obj, list):
        return obj
    return []


def analyze_one_sheet(path, fn, m, host, model):
    """分析单张拼图。抽出来是为了能并发调用。

    重试策略（每档换一个失败模式去打）：
      第 1 次  原图 + num_predict=600
      第 2 次  原图 + 1200（模型话没说完就停了）
      第 3 次  缩到 60% + 1200（图太大，视觉 token 太多）
      第 4 次  缩到 45% + 1600（第 3 次仍撞重复上限）

    缩图这一档是实测加的：同一配置耗时极差达 1.9 倍
    （45.1s ~ 83.6s），说明视觉 token 数对耗时影响很大，
    只加大 num_predict 救不了「图太复杂」。

    ⚠️ 第 4 档是 2026-11-26 提高分辨率后新加的：
    清晰度上来以后，qwen3.5:4b 会撞 `token repeat limit reached`
    （HTTP 500）。那不是"没说完"，是模型在细节多的图上陷入重复循环，
    加 num_predict 只会让它重复更久。唯一的解是继续降图尺寸。
    所以重试表按"缩小比例"递增，而不是按"输出长度"递增。
    """
    b64 = base64.b64encode(open(path, "rb").read()).decode("ascii")
    n = len(m.get("frames", [])) or 4
    prompt = PROMPT.format(n=n)
    entry = {"file": fn, "sheet": m.get("sheet"), "range": m.get("range"),
             "frames": m.get("frames"), "items": [], "ok": False}
    b64_cur = b64
    attempts_plan = ((600, 0.0), (1200, 0.0), (1200, 0.6), (1600, 0.45))
    for attempt, (npred, scale) in enumerate(attempts_plan, 1):
        try:
            if scale and scale < 1.0:
                try:
                    from PIL import Image
                    import io as _io
                    im = Image.open(path)
                    im.thumbnail((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
                    buf = _io.BytesIO()
                    im.save(buf, format="JPEG", quality=85)
                    b64_cur = base64.b64encode(buf.getvalue()).decode("ascii")
                    log("[vision] %s 第%d次：缩到 %dx%d 重试" % (fn, attempt, im.width, im.height))
                except Exception as shrink_err:
                    log("[vision] %s 缩图失败（继续用原图）：%s" % (fn, shrink_err))
            t0 = time.time()
            txt = ollama_generate(host, model, prompt, b64_cur, num_predict=npred)
            items = parse_items(txt)
            entry["raw"] = txt
            entry["items"] = items
            entry["ok"] = bool(items)
            entry["elapsed"] = round(time.time() - t0, 1)
            entry["attempts"] = attempt
            log("[vision] %s 第%d次 ok=%s items=%d %.1fs" % (fn, attempt, entry["ok"], len(items), entry["elapsed"]))
            if entry["ok"]:
                break
        except Exception as e:
            entry["err"] = repr(e)
            if "repeat limit" in str(e):
                log("[vision] %s 第%d次撞重复上限（图太大），继续缩小重试" % (fn, attempt))
            else:
                log("[vision] %s 第%d次失败：%s" % (fn, attempt, e))
            time.sleep(2)
    return entry


# ---------------------------------------------------------------------------
# 全局并发闸门（2026-11-27）
#
# 为什么需要：每个任务独立 spawn python，各自 ThreadPoolExecutor。
# N 个任务 × M 并发会让 N*M 个请求同时打 Ollama，显存直接爆。
#
# 为什么用文件锁而不是内存信号量：跨进程。DSH 起了几个 python 就几套内存。
#
# 为什么不用 fcntl：Windows 上不可用。用 O_CREAT|O_EXCL 更可移植。
# ---------------------------------------------------------------------------

_GATE_DIR = None


def _gate_dir():
    """闸门目录：优先用配置，否则落到用户数据目录。"""
    global _GATE_DIR
    if _GATE_DIR:
        return _GATE_DIR
    d = os.environ.get("XIYOUNG_MODEL_GATE_DIR")
    if not d:
        home = os.environ.get("DSH_HOME") or os.path.join(
            os.path.expanduser("~"), ".dsh")
        d = os.path.join(home, "xiyoungtools", "locks")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        d = None
    _GATE_DIR = d
    return d


class ModelGate:
    """跨进程的模型调用闸门。

    用法：
        with ModelGate() as slot:
            call_model(...)

    拿不到槽位时**照常放行**（记一行日志），因为：
      - 卡死比慢一点更糟
      - 限制是优化，不是正确性要求
    """

    def __init__(self, limit=None, timeout=180.0):
        self.limit = limit
        if self.limit is None:
            try:
                self.limit = int(cfg_num("XIYOUNG_MODEL_MAX_CONCURRENCY", 1))
            except Exception:
                self.limit = 1
        self.timeout = timeout
        self.path = None

    def __enter__(self):
        if self.limit is None or self.limit <= 0:
            return self  # 不限制
        d = _gate_dir()
        if not d:
            return self
        deadline = time.time() + self.timeout
        me = "%d-%d" % (os.getpid(), threading.get_ident())
        while time.time() < deadline:
            for i in range(self.limit):
                p = os.path.join(d, "slot-%d" % i)
                # 清理僵尸槽位（进程崩了没删）
                try:
                    if os.path.exists(p) and time.time() - os.path.getmtime(p) > 600:
                        os.remove(p)
                except Exception:
                    pass
                try:
                    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.write(fd, me.encode("ascii", "ignore"))
                    os.close(fd)
                    self.path = p
                    return self
                except FileExistsError:
                    continue
                except Exception:
                    return self  # 文件系统不让写，放行
            time.sleep(0.2)
        log("[gate] 等了 %.0f 秒还没抢到模型槽位，这次不再等（避免卡死）" % self.timeout)
        return self

    def __exit__(self, *exc):
        if self.path:
            try:
                os.remove(self.path)
            except Exception:
                pass
            self.path = None
        return False


def analyze_sheets(sheets_dir, meta, out_json, host, model, force=False, concurrency=1):
    """分析所有拼图。

    concurrency：同时分析几张。默认 1（串行）。

    **什么时候该调大**：显卡够大、模型全部进显存、单张耗时稳定。
    这时 2-3 并发能接近线性提速。

    **什么时候不该调大**：模型只能部分进显存（GPU/CPU 混合），
    这时并发会让每次推理都在 PCIe 上争抢，实测可能比串行还慢。
    本机（4GB 卡跑 3.89GB 模型，只 48% 进显存）实测：
      2 并发测出过 1.62x / 1.03x / 1.54x / 0.90x 四种结果，
      3 并发稳定退化到 0.48x。波动比提速幅度还大。
    """
    results = []
    if os.path.exists(out_json) and not force:
        try:
            results = json.load(open(out_json, encoding="utf-8"))
        except Exception:
            results = []
    done = {r["file"] for r in results if r.get("ok")}
    mby = {m["file"]: m for m in meta}
    files = sorted([f for f in os.listdir(sheets_dir) if f.endswith(".jpg")])
    if not files:
        raise RuntimeError(
            "视频里没有抽到足够的画面。\n"
            "可能是这段时间没画面变化，或者视频太短。\n"
            "试试去掉时间段限制，或者把 interval 调小一点。"
        )

    todo = [fn for fn in files if force or fn not in done]
    if not todo:
        log("[vision] 全部已完成，跳过")
    else:
        workers = max(1, int(concurrency or 1))
        if workers > 1:
            log("[vision] 并发 %d 张（%d 张待分析）" % (workers, len(todo)))
        else:
            log("[vision] 串行分析 %d 张" % len(todo))

        lock = threading.Lock()
        state = {"results": results}

        def worker(fn):
            path = os.path.join(sheets_dir, fn)
            m = mby.get(fn, {})
            # 2026-11-27：全局闸门。多个任务同时跑时，跨进程限制同时打模型的
            # 请求数，避免 N 任务 × M 并发把显存抢爆。
            with ModelGate():
                entry = analyze_one_sheet(path, fn, m, host, model)
            # 每完成一张就落盘，中途取消也不丢已完成的
            with lock:
                cur = [r for r in state["results"] if r.get("file") != fn] + [entry]
                cur.sort(key=lambda r: r.get("file", ""))
                state["results"] = cur
                json.dump(cur, open(out_json, "w", encoding="utf-8"),
                          ensure_ascii=False, indent=2)
            return entry

        if workers == 1:
            for fn in todo:
                worker(fn)
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(worker, fn) for fn in todo]
                for fut in as_completed(futures):
                    try:
                        fut.result()
                    except Exception as e:
                        log("[vision] 某张分析异常：%s" % e)
        results = state["results"]

    ok = sum(1 for r in results if r.get("ok"))
    failed = [r for r in results if not r.get("ok")]
    log("[vision] 完成 %d/%d 张" % (ok, len(results)))
    # 失败的单独列出来。并发时更要说清楚——串行时用户盯着日志能看到哪张卡住，
    # 并发时日志是交错的，不给清单就不知道漏了哪张。
    if failed:
        log("[vision] 有 %d 张失败：%s" % (
            len(failed), "、".join(r.get("file", "?") for r in failed)))
        for r in failed:
            if r.get("err"):
                log("[vision]   %s: %s" % (r.get("file"), r["err"][:120]))
    return results

def write_entries(path, results):
    """把逐格结果压成一份扁平的「时间 → 画面/动作/文字」清单。

    2026-11-27 补丁（社区贡献）：analysis.json 里每张拼图是一整段模型原文，
    agent 想用它还得自己展开、挑字段。这里额外落一份按时间排序的扁平表，
    工具层可以直接截前 N 条返回，省掉「读文件 + 解析 markdown」两步。
    """
    out = []
    for r in results or []:
        if not r.get("ok"):
            continue
        for it in r.get("items") or []:
            text = str(it.get("text") or "").strip()
            if text in ("", "无", "没有", "None", "none", "null"):
                text = ""
            out.append({
                "time": str(it.get("time") or ""),
                "sheet": r.get("sheet"),
                "range": r.get("range"),
                "scene": str(it.get("scene") or "").strip(),
                "characters": str(it.get("characters") or "").strip(),
                "action": str(it.get("action") or "").strip(),
                "text": text,
            })
    try:
        json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    except Exception as e:
        log("[entries] 写失败（不影响报告）：%s" % e)
    return out


def write_report(outdir, video_meta, results, args, interval, range_info=None):
    """写报告。range_info 给定时说明只看了某一段——这点必须写在最前面，

    否则读者会以为整条视频都看过了。
    """
    report = os.path.join(outdir, "report.md")
    sheets = json.load(open(os.path.join(outdir, "sheets_manifest.json"), encoding="utf-8"))
    lines = []
    lines.append("# 《%s》逐帧观看报告" % video_meta.get("title", "视频"))
    lines.append("")
    if range_info and range_info.get("start") is not None:
        s = range_info["start"]
        d = range_info.get("duration")
        span = ("%s – %s" % (fmt_time(s), fmt_time(s + d))) if d else ("%s – 结尾" % fmt_time(s))
        lines.append("> ⚠ **只看了 %s 这一段**（不是整条视频）。" % span)
        lines.append("")
    lines.append("## 基本信息")
    lines.append("")
    lines.append("- 标题：%s" % video_meta.get("title", ""))
    lines.append("- UP 主：%s" % video_meta.get("uploader", ""))
    dur = video_meta.get("duration") or 0
    lines.append("- 时长：%s（%.2f 秒）" % (fmt_time(dur), dur))
    if range_info and range_info.get("start") is not None:
        s = range_info["start"]
        d = range_info.get("duration")
        lines.append("- **本次只观看**：%s%s" % (
            fmt_time(s), (" – " + fmt_time(s + d)) if d else " – 结尾"))
    lines.append("- 观看方式：每 %.2f 秒抽 1 帧，共 %d 帧；每 %d 帧拼成 %d×%d 带时间戳拼图；由本机 Ollama 的 %s 视觉模型逐格识别。"
                 % (interval, sum(len(m["frames"]) for m in sheets), args.frames_per_sheet,
                    2, int(math.ceil(args.frames_per_sheet / 2)), args.model))
    lines.append("- 说明：引号内为画面字幕 OCR，可能有错字；只描述画面，不做剧情推测。")
    lines.append("")
    if video_meta.get("description"):
        lines.append("## 简介")
        lines.append("")
        lines.append(video_meta["description"].strip())
        lines.append("")
    lines.append("## 逐格记录")
    lines.append("")
    for e in sorted(results, key=lambda r: r.get("sheet", 0)):
        if not e.get("ok"):
            lines.append("### 第 %s 张（%s）" % (e.get("sheet"), e.get("range")))
            lines.append("")
            lines.append("（这张识别失败，未获得可用描述。）")
            lines.append("")
            continue
        lines.append("### 第 %s 张（%s）" % (e.get("sheet"), e.get("range")))
        lines.append("")
        m = next((x for x in sheets if x["file"] == e["file"]), {})
        times = [f["time"] for f in m.get("frames", [])]
        for i, it in enumerate(e.get("items", [])):
            t = it.get("time") or (times[i] if i < len(times) else "")
            lines.append("- **%s**　场景：%s" % (t, it.get("scene", "")))
            lines.append("  角色：%s" % it.get("characters", ""))
            lines.append("  动作：%s" % it.get("action", ""))
            lines.append("  字幕：%s" % it.get("text", ""))
        lines.append("")
    lines.append("## 说明")
    lines.append("")
    lines.append("- 本报告由本地视觉模型逐格识别后自动汇总；4B 模型可能误读细节。")
    lines.append("- 抽帧间隔固定，快速动作可能被漏掉；关键对白以画面字幕为准。")
    lines.append("")

    # OCR 不一致检测：同一段画面被不同帧读成不同文字时标出来。
    # 实测一本书的封面，作者名被读成「周晓辉」12 次、「司城怜」4 次、「周晓波」4 次，
    # 而真实名字是「圆城塔」——一次都没读对。这种错误在摘要里会被当成事实陈述。
    unstable = find_unstable_ocr(results)
    if unstable:
        lines.append("## ⚠ OCR 不稳定（同一处文字有多种读法）")
        lines.append("")
        lines.append("下面这些短句在不同帧里被识别成了不同写法。")
        lines.append("**真实内容很可能不是其中任何一个**——引用前请对照原视频。")
        lines.append("")
        for group in unstable:
            variants = "、".join("「%s」×%d" % (v, c) for v, c in group["variants"])
            lines.append("- %s" % variants)
        lines.append("")
    open(report, "w", encoding="utf-8").write("\n".join(lines))
    log("[report] 已写入 %s" % report)
    return report


def find_unstable_ocr(results, max_groups=8):
    """找出 OCR 不稳定的短句：同一位置附近被读成不同写法。

    做法：把每帧字幕拆成短行（2-8 字，看起来像人名/书名/术语），
    按出现次数统计。若一组长度相近、字数相同的短句各出现多次，
    它们很可能是同一处文字的多种误读。

    返回 [{"variants": [(文本, 次数), ...]}]。
    """
    from collections import Counter
    counts = Counter()
    for e in results:
        if not e.get("ok"):
            continue
        for it in e.get("items", []):
            raw = str(it.get("text") or "")
            for line in raw.split("\n"):
                line = line.strip()
                # 只看像"专名"的短行：2-8 个汉字，不含标点和数字
                if not line or len(line) < 2 or len(line) > 8:
                    continue
                if not all("\u4e00" <= ch <= "\u9fa5" for ch in line):
                    continue
                counts[line] += 1

    # 统计总帧数（不是拼图张数：一张拼图里有 4 帧）
    total_frames = 0
    for e in results:
        if not e.get("ok"):
            continue
        total_frames += max(1, len(e.get("items") or []))
    if total_frames == 0:
        return []
    # 排除"几乎每帧都出现"的固定标签（书名、奖项名）——那些不是误读，是稳定文字。
    # 两个条件都要满足才排除：
    #   a) 出现次数 >= 总帧数的 60%
    #   b) 且次数和总帧数很接近（差 <= 2 帧）—— 小样本时单看比例会误伤
    # 实测：24 帧的书名出现 24 次（100%），作者名被读错成 12/4/4 次；
    #       4 帧的小样本里，书名 4 次、作者 2 次，前者该排除、后者该保留。
    def is_fixed_label(count):
        if count < total_frames * 0.6:
            return False
        return (total_frames - count) <= 2

    threshold = total_frames * 0.6
    candidates = [(t, c) for t, c in counts.items()
                  if 2 <= c < total_frames and not is_fixed_label(c)]
    if len(candidates) < 2:
        return []

    # 分组：同一处文字的不同误读，特征通常是
    #   - 字数相同（或差 1），且
    #   - 出现在同一类画面里（这里用"出现次数都不多"近似：少于总帧数的一半）
    # 不做"首字相同"的限制——实测「周晓辉」「司城怜」「周晓波」里
    # 「司城怜」首字就不同，硬卡首字会漏掉。
    groups = []
    used = set()
    for i, (t1, c1) in enumerate(candidates):
        if t1 in used:
            continue
        group = [(t1, c1)]
        for t2, c2 in candidates[i + 1:]:
            if t2 in used:
                continue
            same_len = len(t1) == len(t2)
            near_len = abs(len(t1) - len(t2)) == 1
            both_rare = not is_fixed_label(c1) and not is_fixed_label(c2)
            if both_rare and (same_len or near_len):
                group.append((t2, c2))
                used.add(t2)
        if len(group) >= 2:
            used.add(t1)
            group.sort(key=lambda x: -x[1])
            groups.append({"variants": group})

    groups.sort(key=lambda g: -sum(c for _, c in g["variants"]))
    return groups[:max_groups]


def write_summary(outdir, results, host, model, video_meta=None):
    # 可选：把逐格记录交给同一个本地模型做一段摘要
    video_meta = video_meta or {}
    chunks = []
    for e in results:
        if not e.get("ok"):
            continue
        chunks.append("【%s】" % e.get("range"))
        for it in e.get("items", []):
            chunks.append("%s | %s | %s | %s | %s" % (
                it.get("time", ""), it.get("scene", ""), it.get("characters", ""),
                it.get("action", ""), it.get("text", "")))
    text = "\n".join(chunks)

    # 把真实元数据给模型：没有它，模型只能从画面猜"这是什么"，
    # 而封面上的作者名本来就是 OCR 读的，可能是错的。
    meta_lines = []
    if video_meta.get("title"):
        meta_lines.append("视频标题：%s" % video_meta["title"])
    if video_meta.get("uploader"):
        meta_lines.append("UP 主：%s" % video_meta["uploader"])
    if video_meta.get("description"):
        desc = video_meta["description"].strip()
        if desc:
            meta_lines.append("视频简介：%s" % desc[:500])
    meta_block = ("【视频本身的信息】\n" + "\n".join(meta_lines) + "\n\n") if meta_lines else ""

    prompt = (
        "下面是一条视频逐格画面的描述记录。请用中文写一段 200-400 字的摘要，"
        "按时间顺序讲清画面里发生了什么、出现了哪些角色、有哪些关键字幕。\n\n"
        + meta_block +
        "【重要规则】\n"
        "1. 画面里的文字（人名、书名、术语）来自 OCR，**可能读错**。"
        "如果同一个人名/书名在记录里出现了不同写法，说明 OCR 不稳定，"
        "请写「（OCR 识别，可能有误）」而不是当成确定的事实。\n"
        "2. 不要给作品补全作者、背景、评价——记录里没有的信息一律不写。\n"
        "3. 用「画面显示」「字幕写着」这类描述性说法，不要用「书中探讨」「作者认为」这种确定的说法。\n"
        "4. 只根据记录，不要编造。\n\n"
        "【逐格记录】\n" + text
    )
    try:
        out = ollama_generate(host, model, prompt, None, num_predict=800, num_ctx=16384, fmt=None, think=False)
        p = os.path.join(outdir, "summary.md")
        header = [
            "# 摘要",
            "",
            "> ⚠ **这是模型根据逐帧画面写的摘要，不是事实核对。**",
            "> 画面里的人名、书名、术语来自 OCR，可能读错（实测同一本书被读成三个不同作者名）。",
            "> 引用前请对照下方「视频信息」和原视频。",
            "",
        ]
        if meta_lines:
            header.append("## 视频信息（来自 B 站，可信）")
            header.append("")
            for line in meta_lines:
                header.append("- " + line)
            header.append("")
        header.append("## 摘要（模型生成，仅供参考）")
        header.append("")
        open(p, "w", encoding="utf-8").write("\n".join(header) + out.strip() + "\n")
        log("[summary] 已写入 %s" % p)
        return p
    except Exception as e:
        log("[summary] 生成失败：%s" % e)
        return None


def is_local_file(text):
    """判断输入是不是本地文件路径。

    支持 Windows 盘符、UNC、file:// 和裸相对路径。
    """
    s = str(text or "").strip().strip('"')
    if not s:
        return False
    if s.lower().startswith("file://"):
        return True
    if re.match(r"^[a-zA-Z]:[\\/]", s):
        return True
    if s.startswith("\\\\") or s.startswith("/"):
        return True
    # 裸相对路径：不做猜测，只认同已存在且带常见扩展名的
    if re.search(r"\.(mp4|mkv|mov|avi|flv|webm|ts|m4v|wmv|mp3|m4a|wav|flac|aac|ogg)$", s, re.I):
        return os.path.exists(s)
    return False


def probe_local_media(path):
    """用 ffprobe 读本地文件的时长和基本信息，替代 yt-dlp 的 fetch_meta。"""
    src = path
    if src.lower().startswith("file://"):
        from urllib.parse import unquote
        src = unquote(src[7:])
    src = os.path.abspath(os.path.expanduser(src))
    if not os.path.exists(src):
        raise SystemExit("找不到文件：%s" % src)

    ffprobe = FFMPEG.replace("ffmpeg", "ffprobe") if FFMPEG else "ffprobe"
    duration = 0.0
    meta = {}
    try:
        out = run([ffprobe, "-v", "error", "-select_streams", "v:0",
                   "-show_entries", "stream=width,height,duration",
                   "-show_entries", "format=duration",
                   "-of", "json", src], timeout=120)
        info = json.loads(out or "{}")
        fmt = info.get("format") or {}
        if fmt.get("duration"):
            duration = float(fmt["duration"])
        elif (info.get("streams") or [{}])[0].get("duration"):
            duration = float(info["streams"][0]["duration"])
        st = (info.get("streams") or [{}])[0]
        meta = {
            "id": os.path.splitext(os.path.basename(src))[0],
            "title": os.path.basename(src),
            "uploader": "",
            "description": "",
            "duration": duration,
            "width": st.get("width"),
            "height": st.get("height"),
            "localPath": src,
            "isLocal": True,
        }
    except Exception as e:
        # ffprobe 失败不致命：没有时长就按抽帧实际结果走
        log("[meta] ffprobe 读时长失败：%s（继续，时长按实际帧数推）" % str(e)[:120])
        meta = {
            "id": os.path.splitext(os.path.basename(src))[0],
            "title": os.path.basename(src),
            "uploader": "",
            "description": "",
            "duration": 0.0,
            "localPath": src,
            "isLocal": True,
        }
    return meta


def main():
    ap = argparse.ArgumentParser(description="视频 → 抽帧 → 拼图 → 本地视觉模型 → 报告")
    ap.add_argument("url", help="视频链接或 BV 号")
    ap.add_argument("--outdir", default=None, help="输出目录（默认 video-watch-<id>）")
    ap.add_argument("--interval", type=float, default=None,
                    help="抽帧间隔秒数。给了就按它走，不被任何下限夹住。")
    ap.add_argument("--min-interval", type=float, default=None,
                    help="自动规划时的最小间隔（默认取配置，保底 0.05）。想抽得密就调小。")
    ap.add_argument("--density", default=None, choices=["budget", "max", "smart"],
                    help="budget=在 maxSheets 预算内均匀铺满（默认）；max=不管预算，按 min-interval 抽到最密")
    ap.add_argument("--start", default=None,
                    help="只看这一段：起始时间，支持 90 / 1:30 / 0:01:30")
    ap.add_argument("--end", default=None,
                    help="只看这一段：结束时间（和 --start 配对；也可用 --duration）")
    ap.add_argument("--duration", default=None,
                    help="只看这一段：长度（和 --start 配对，二选一）")
    ap.add_argument("--max-sheets", type=int, default=None, help="最多拼图张数（默认取配置）")
    ap.add_argument("--frames-per-sheet", type=int, default=None, help="每张拼图帧数（默认取配置）")
    ap.add_argument("--per-row", type=int, default=None,
                    help="拼图每行几格（默认取配置，通常 2）。3 格/行适合宽画面。")
    ap.add_argument("--sheet-width", type=int, default=None, help="拼图宽度（默认取配置）")
    ap.add_argument("--width", type=int, default=None, help="单帧宽度（默认取配置）")
    ap.add_argument("--height", type=int, default=None, help="下载最大短边（默认取配置）")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="Ollama 视觉模型（默认 %s）" % DEFAULT_MODEL)
    ap.add_argument("--concurrency", type=int, default=1,
                    help="同时分析几张拼图，默认 1（串行）。"
                         "显卡够大、模型全进显存时调到 2-3 能明显加速；"
                         "模型只能部分进显存时并发反而会变慢。")
    ap.add_argument("--host", default=DEFAULT_HOST, help="Ollama 地址（默认 %s）" % DEFAULT_HOST)
    ap.add_argument("--summary", action="store_true", help="额外生成一段模型摘要")
    ap.add_argument("--force", action="store_true", help="强制重新下载/抽帧/分析")
    ap.add_argument("--cookies-from-browser", default=None, help="传给 yt-dlp，如 edge / chrome")
    ap.add_argument("--cache-dir", default=None,
                    help="下载缓存目录。给了就按「视频id + 短边 + 时间段」复用已下载的文件。")
    ap.add_argument("--no-section-download", action="store_true",
                    help="即使给了时间段也整条下载（默认只下载这一段）。")
    ap.add_argument("--scene-threshold", type=float, default=None,
                    help="smart 模式的画面变化阈值（0~1，默认取配置 0.30）。越高越挑。")
    args = ap.parse_args()

    # 参数没给就从配置取（配置来自 Host 注入的环境变量）
    if args.width is None:
        args.width = cfg_num("XIYOUNG_VIDEO_FRAME_WIDTH", 1000)
    if args.sheet_width is None:
        args.sheet_width = cfg_num("XIYOUNG_VIDEO_SHEET_WIDTH", 1000)
    if args.height is None:
        args.height = cfg_num("XIYOUNG_VIDEO_HEIGHT", 1080)
    if args.max_sheets is None:
        args.max_sheets = cfg_num("XIYOUNG_VIDEO_MAX_SHEETS", 12)
    if args.frames_per_sheet is None:
        args.frames_per_sheet = cfg_num("XIYOUNG_VIDEO_FRAMES_PER_SHEET", 4)
    if args.concurrency is None:
        args.concurrency = cfg_num("XIYOUNG_VIDEO_CONCURRENCY", 1)
    if getattr(args, "min_interval", None) is None:
        args.min_interval = cfg_num("XIYOUNG_VIDEO_MIN_INTERVAL", 1.0)
    if getattr(args, "density", None) is None:
        args.density = cfg_str("XIYOUNG_VIDEO_DENSITY", "budget")
    if args.per_row is None:
        args.per_row = int(cfg_num("XIYOUNG_VIDEO_PER_ROW", 2))

    url = args.url.strip()
    if re.fullmatch(r"BV[0-9A-Za-z]+", url):
        url = "https://www.bilibili.com/video/" + url

    ytdlp = which_ytdlp()
    extra = []
    if args.cookies_from_browser:
        extra += ["--cookies-from-browser", args.cookies_from_browser]

    # 本地文件不走 yt-dlp：它只会报 "Unsupported url scheme" 之类。
    # 这是 toolbox_analyze 需要的路径——给个视频文件就该能看。
    local = is_local_file(url)
    if local:
        log("[meta] 本地文件，用 ffprobe 读信息...")
        meta = probe_local_media(url)
    else:
        log("[meta] 读取视频信息...")
        meta = fetch_meta(url, ytdlp, extra)
    vid = meta.get("id") or "video"
    title = meta.get("title") or vid
    duration = float(meta.get("duration") or 0)
    outdir = args.outdir or ("video-watch-" + vid)
    outdir = os.path.abspath(outdir)
    os.makedirs(outdir, exist_ok=True)
    if local:
        log("[meta] %s | %s" % (title, fmt_time(duration) if duration else "时长未知"))
    else:
        log("[meta] %s | %s | %s" % (title, meta.get("uploader", ""), fmt_time(duration)))

    # 时间段：start / end / duration 三选组合。
    # 规划（间隔、张数）要用"段长度"而不是全片时长，否则时间段很短时
    # 间隔会被算得极大，只抽出 1 帧。
    try:
        seg_start = parse_time(args.start)
        seg_end = parse_time(args.end)
        seg_dur_arg = parse_time(args.duration)
    except ValueError as e:
        raise SystemExit(str(e))

    if seg_start is None and (seg_end is not None or seg_dur_arg is not None):
        seg_start = 0.0
    if seg_end is not None and seg_dur_arg is not None:
        raise SystemExit("--end 和 --duration 只能给一个")
    if seg_end is not None:
        if seg_start is None:
            seg_start = 0.0
        if duration > 0 and seg_end > duration:
            raise SystemExit("结束时间 %.1fs 超过视频时长 %.1fs" % (seg_end, duration))
        if seg_end <= seg_start:
            raise SystemExit("结束时间必须晚于起始时间")
        seg_duration = seg_end - seg_start
    elif seg_dur_arg is not None:
        seg_duration = seg_dur_arg
    else:
        seg_duration = None

    if seg_start is not None:
        if duration > 0 and seg_start >= duration:
            raise SystemExit("起始时间 %.1fs 超过视频时长 %.1fs" % (seg_start, duration))
        if seg_duration is not None and duration > 0 and seg_start + seg_duration > duration + 0.5:
            raise SystemExit("时间段超出视频结尾（%.1fs + %.1fs > %.1fs）" % (
                seg_start, seg_duration, duration))
        log("[range] 只处理 %s%s" % (
            fmt_time(seg_start),
            (" 到 " + fmt_time(seg_start + seg_duration)) if seg_duration else " 到结尾"))

    # 有效时长：有时间段就按段长算
    eff_duration = seg_duration if seg_duration else max(0.0, duration - (seg_start or 0.0))

    per_sheet = max(1, args.frames_per_sheet)
    if args.interval:
        # 用户明确给了间隔，就用它——不再往下夹。
        # 以前这里无条件 max(1.0, ...)，等于把 "0.5 秒一帧" 这种需求直接吞掉。
        interval = float(args.interval)
    else:
        # 自动规划：在"拼图预算"内抽得最密。
        #
        # 预算 = maxSheets * framesPerSheet（能看的帧总数）。
        # 以前是"先按预算算间隔，再夹到 >=1.0 秒"，于是短视频被 1 秒下限锁死：
        # 30 秒的片子最多 30 帧，跟把 maxSheets 调多大无关。
        # 现在分两种策略：
        #   density=budget（默认）  均匀铺满预算，间隔不低于 minInterval
        #   density=max           不设上限，能多密就多密（慢一点没关系时用）
        target_frames = max(1, args.max_sheets * per_sheet)
        raw = eff_duration / target_frames if eff_duration > 0 else 2.0

        floor = float(args.min_interval) if getattr(args, "min_interval", None) else 1.0
        if floor <= 0:
            floor = 0.05  # ffmpeg 的 fps 过滤器下限，再小没意义

        if getattr(args, "density", "budget") == "max":
            # 只要能塞进预算，就把间隔压到下限
            interval = floor
        else:
            if 0 < eff_duration < 60:
                raw = max(raw, eff_duration / 24.0)
            interval = max(floor, math.ceil(raw * 100) / 100.0)

    est_frames = int(math.ceil(eff_duration / interval)) if eff_duration else 0
    est_sheets = int(math.ceil(est_frames / per_sheet)) if eff_duration else 0
    log("[plan] 间隔 %.2f 秒，预计 %d 帧 / %d 张拼图" % (interval, est_frames, est_sheets))
    # 超出预算要明说，别让用户以为全看了
    if args.max_sheets and est_sheets > args.max_sheets:
        log("[plan] 注意：预算 %d 张，实际会出 %d 张（按间隔算的，没截断）" % (args.max_sheets, est_sheets))

    if local:
        # 本地文件已经在盘上，不下载
        video = meta.get("localPath") or url
        log("[download] 本地文件，跳过下载：%s" % os.path.basename(video))
    else:
        video = download_video(url, outdir, ytdlp, args.height, extra,
                               vid=vid, cache_dir=args.cache_dir,
                               seg_start=seg_start, seg_duration=seg_duration,
                               section=not args.no_section_download)
    frames_dir = os.path.join(outdir, "frames")
    sheets_dir = os.path.join(outdir, "sheets")
    if getattr(args, "density", "budget") == "smart":
        # 2026-11-27：按画面变化抽帧。静态视频（访谈/板书）会退化成固定间隔，
        # 动态视频（切镜/动作）抓真正变了的时刻，同样帧数看更多内容。
        frames = extract_frames_scene(video, frames_dir, interval, args.width,
                                      start=seg_start, seg_duration=seg_duration,
                                      threshold=getattr(args, "scene_threshold", None))
    else:
        frames = extract_frames(video, frames_dir, interval, args.width,
                               start=seg_start, seg_duration=seg_duration)
    meta_sheets = build_sheets(frames, sheets_dir, per_sheet, args.sheet_width, interval,
                               time_offset=(seg_start or 0.0), per_row_arg=args.per_row)

    out_json = os.path.join(outdir, "analysis.json")
    results = analyze_sheets(sheets_dir, meta_sheets, out_json, args.host, args.model,
                             force=args.force, concurrency=args.concurrency)
    # 2026-11-27 补丁（社区贡献）：额外落一份扁平清单，工具层直接消费，不必再解析 markdown。
    entries_path = os.path.join(outdir, "entries.json")
    entries = write_entries(entries_path, results)
    report = write_report(outdir, meta, results, args, interval,
                          range_info=({"start": seg_start, "duration": seg_duration}
                                      if seg_start is not None else None))
    if args.summary:
        write_summary(outdir, results, args.host, args.model, video_meta=meta)

    ok = sum(1 for r in results if r.get("ok"))
    log("")
    log("完成：%d/%d 张拼图识别成功" % (ok, len(results)))
    log("输出：%s" % outdir)
    log("  报告：%s" % report)
    log("  逐格 JSON：%s" % out_json)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("已中断")
        sys.exit(130)
    except Exception as e:
        log("ERROR: %s" % e)
        sys.exit(1)
