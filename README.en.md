# Auris Oculi

A DSH plugin that puts a set of **fully local** audio/video tools behind one sidebar entry.
No network calls, no uploads, no cloud services.

## What it does

| Capability | Description |
|---|---|
| Video frame watch | Bilibili link → download → frame contact sheets → local vision model → report |
| One-shot analysis | A video/audio file: look at frames and sound together |
| Audio clip | Cut a segment; mp4 if it has video, mp3 if audio-only |
| Prosody analysis | 23 objective numbers (pitch / range / jitter / spectrum / envelope / rate) + transcript |
| Sound notes | Record an observation about a clip; searchable, find-similar |
| Batch import | Drop in a folder; labels inferred, every file analysed |
| Voiceprint compare | Are two clips the same person? |
| Speaker clustering | Group a folder by speaker: "roughly how many people?" |
| Speaker diarization | Which speaker said what, when |
| Change detection | Where did this clip change (register shift / pitch jump / loudness jump / pause) |
| Feature benchmark | Can these numbers actually separate people/emotions? |
| Cache cleanup | Remove intermediates, keep reports and outputs |

## Three things to know up front

**1. It measures sound, it does not judge emotion.**

All 27 numbers are verifiable (median F0 152 Hz, range 11 semitones, 3.3 chars/sec).
But "what emotion is this" is out of reach — 7-class classification on real speech
reaches only 34.3% against a 14.3% chance baseline. Those numbers carry *how* the
voice is produced, not *what* it means.

**2. Clustering and diarization are unreliable; read `caveats`.**

Both rest on Resemblyzer embeddings, which lack discrimination on short clips:
same-speaker 0.79 vs different-speaker 0.75 — a gap of 0.04.
`speakerCount: 1` may mean "one person" or "I cannot tell".

**3. Voiceprint compare is reliable, within limits.**

`speaker_compare` is the one dependable tool in this group, provided you give it
**at least 4 seconds** (8 seconds is where it stabilises) and read the
**relative rank** rather than an absolute threshold.

---

## Install

DSH → **Plugins → Add plugin** → pick this directory.

The sidebar entry appears once enabled. There is no build step — edit and refresh.

---

## Requirements

Three tiers: **runtime** (nothing works without it), **per feature**
(that feature is disabled), **optional** (better results).

The page footer probes every item on startup and marks what is missing.

### 1. Runtime (required)

| Requirement | Tested | For |
|---|---|---|
| Node.js ≥ 20 | v26.4.0 | DSH runtime, usually bundled |
| ffmpeg / ffprobe | 9.0.2 | frame extraction, clipping, decoding |

**Installing ffmpeg** (any one):

```powershell
winget install Gyan.FFmpeg          # Win10+
choco install ffmpeg                # what this machine uses
# or download from https://www.gyan.dev/ffmpeg/builds/ and add bin/ to PATH
```

Verify: `ffmpeg -version`

> Reopen your terminal after installing so PATH refreshes. The plugin also probes
> `C:\ProgramData\chocolatey\bin` and a few other common locations directly.

### 2. Per feature

#### Python + scientific stack (prosody, batch import, all speaker tools)

DSH ships a Python runtime — use that one:

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py -m pip install librosa soundfile scipy numpy
```

~100 MB (pulls in numba, llvmlite, scikit-learn).

Verify: `& $py -c "import librosa, soundfile, scipy, numpy; print('ok')"`

#### Transcription (transcript + the four speech-rate fields)

```powershell
& $py -m pip install sherpa-onnx
```

A **SenseVoice model file** is also needed. Without it transcription is skipped
(`transcriptStatus` becomes `no_model`) and prosody numbers are unaffected.

#### Voiceprint (compare / cluster / diarize)

Pick one backend, or install both:

```powershell
# A. Resemblyzer — works once installed, no extra model
& $py -m pip install resemblyzer webrtcvad-wheels

# B. CAM++ — needs sherpa-onnx plus a model file, more accurate
& $py -m pip install sherpa-onnx
```

**⚠️ Install `webrtcvad-wheels`, not `webrtcvad`** — the latter fails to build on Python 3.12+.

**⚠️ Resemblyzer downloads a ~200 MB voice encoder on first run.** It looks stuck; let it finish.

CAM++ model (27 MB) goes into the plugin's `models/` directory:

```text
https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
```

> `recongition` is the official spelling in that URL, not a typo here.

#### Downloading Bilibili links

```powershell
& $py -m pip install -U yt-dlp
```

`pip` installs it into Python's `Scripts` directory, which is **usually not on PATH**.
The plugin probes `%APPDATA%\Python\Python*\Scripts\` itself, so no PATH edit is needed.

**`yt-dlp` changes often and Bilibili breaks it regularly.** On a download failure,
run `yt-dlp -U` first before suspecting the plugin.

#### Vision model (frame-by-frame video watch)

```powershell
winget install Ollama.Ollama
ollama pull qwen3.5:4b        # 3.3 GB, recommended
ollama list                    # confirm the service is up
```

**Use `qwen3.5:4b`, not `qwen3-vl:4b`** — the latter returns empty content on this setup.

Remote Ollama and OpenAI-compatible endpoints (LM Studio / vLLM / OneAPI) also work:
set `model.provider` and `model.host` in the config.

### 3. Optional

| Requirement | For | Install |
|---|---|---|
| `openpyxl` | reading acoustic parameter spreadsheets | `& $py -m pip install openpyxl` |
| `pyarrow` | reading HuggingFace parquet datasets | `& $py -m pip install pyarrow` |

`Pillow` (used by the frame-sheet builder) normally arrives with librosa.
If you see `No module named PIL`: `& $py -m pip install Pillow`.

### Install everything at once

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py -m pip install librosa soundfile scipy numpy sherpa-onnx resemblyzer webrtcvad-wheels yt-dlp
```

Plus at the system level: `ffmpeg` (required), `Ollama + qwen3.5:4b` (video only).

### What breaks without each

| Missing | Symptom |
|---|---|
| ffmpeg | every audio/video tool errors out |
| librosa | prosody analysis and batch import unavailable |
| yt-dlp | local files only; Bilibili links fail |
| Ollama / model | video frame watch unavailable, rest fine |
| SenseVoice model | no `transcript`, speech-rate fields absent |
| speaker backend | the three `speaker_*` tools report "model unavailable" |
| CAM++ model | silently falls back to Resemblyzer |

---

## Session tools

Twelve tools are registered; any session can call them.

| Tool | Required | Notes |
|---|---|---|
| `toolbox_analyze` | `source` | Frames + sound together |
| `video_summary` | `url` | Bilibili frame-by-frame watch |
| `media_clip` | `source` `start` | Cut a segment |
| `prosody_analyze` | `source` | 27 numbers + transcript + change points |
| `prosody_label` | — | Sound notes (`action: 'list'` to read) |
| `prosody_batch` | `dir` | Batch import a folder |
| `speaker_compare` | `a` `b` | **Synchronous**; two clips, same person? |
| `speaker_cluster` | `dir` | Rough grouping (see caveats) |
| `speaker_diarize` | `source` | **Unreliable** — read caveats |
| `toolbox_benchmark` | `dir` | Can these features separate the labels? |
| `toolbox_job` | `id` | **Unified job lookup** (replaces 7 `_status` tools) |
| `toolbox_cache_clean` | — | Clean intermediates |

Job lookup is unified: `toolbox_job({ id })` infers the job kind from the id,
so you never need to remember which `_status` tool to call.

## Data location

Everything lives under `%USERPROFILE%\.dsh\xiyoungtools\`:

```text
runs/      video analyses (reports, contact sheets)
clips/     clipped segments
prosody/   prosody results
labels/    the label pool (labels.json)
batches/   batch import results
```

---

## Technical notes

### Dual-track pitch tracking

`librosa.pyin` alone has a measured failure mode: on some recordings it returns zero voiced frames while the audio itself is fine. No fmin/fmax combination fixes it, but `librosa.yin` produces sensible results on the same file.

Both are run: pyin first, YIN fills the gaps when coverage drops below 25%.

Measured on the CASIA corpus: 47 of 1200 files had no detectable pitch before the fix, 0 after.

### Three-layer octave correction

1. **Ceiling runaway** — pyin guesses values near fmax on noisy segments; rebuilt from the lower part of the neighbourhood
2. **Whole-utterance octave shift** — when the median exceeds 260 Hz and lowering an octave lands mostly in the plausible human range, shift it back
3. **Isolated octave jumps** — neighbourhood-median consistency check

### Accuracy

Verified against pure tones at 16 kHz:

| Input | Expected | Measured | Error |
|---|---|---|---|
| tone | 220 Hz | 219.7 Hz | −0.1% |
| tone | 120 Hz | 120.5 Hz | +0.4% |
| two-tone | 220→330 Hz | 219.7 / 331.1 Hz | 7.10 semitones (theory 7.02) |

---

## Known limitations

- **OCR may misread characters**: the 4B vision model is imperfect on Chinese screens; keep the raw description and verify key frames by hand
- **One job per kind at a time**: video analysis, clipping, prosody and batch import each queue independently
- **Prosody gives numbers, not verdicts**: no "is this urging or probing" — that needs labelled samples
- **Jitter needs multiple samples**: a single clip's jitter figure may just be noise
- **Speaker tools need long clips**: below 4 seconds, "not the same person" is unreliable; 8 seconds is where it stabilises
- **Emotion classification is out of scope**: 34.3% on real speech against a 14.3% baseline
## License

MIT
