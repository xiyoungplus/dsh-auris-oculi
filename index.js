/**
 * Auris Oculi 感知工具箱 — Host half.
 *
 * Serves the local routes the browser page uses to start a video-watch job,
 * poll it, read the report, and fetch a contact sheet. The heavy lifting stays
 * in video_watch.py (yt-dlp + ffmpeg + local Ollama vision model); this file
 * only manages jobs and files.
 *
 * Job state is both in memory and on disk: every run directory carries
 * job.json + job.log, so re-entering the page (or restarting DSH) can restore
 * the latest job and its log.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'xiyoungtools'
export const inject = ['webServer', 'tools']

const SCRIPT = fileURLToPath(new URL('./lib/video_watch.py', import.meta.url))
// 模型名一律在运行时用 resolveModel() 解析：工具参数 > config.json model.name > 内置默认。
// 这里只保留一个兜底常量，绝不参与判断——之前的 `=== DEFAULT_MODEL` 守卫就是因为
// 它是 null、而模型名是 'qwen3.5:4b'，永远不相等，把 video_summary 整个拦死了。
const FALLBACK_MODEL = 'qwen3.5:4b'

// DSH 的数据根目录：优先用它自己的 DSH_HOME，回退到 ~/.dsh。
// 写死 homedir()/.dsh 在自定义安装位置（或换了 DSH_HOME）时会指错地方。
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const TOOLBOX_HOME = path.join(DSH_HOME, 'xiyoungtools')

// ---------------------------------------------------------------------------
// 配置系统
//
// 问题：之前所有默认值都是按"这台机器"调的——qwen3.5:4b、480p、8 秒块、
// 并发 1、阈值全是实测出来的固定数。换台机器、换个用途就不合适了。
//
// 三层优先级（高的覆盖低的）：
//   1. 工具调用参数（单次生效）
//   2. 环境变量 XIYOUNG_*（进程级）
//   3. 配置文件 config.json（用户级，持久）
//   4. 内置默认值（按"最保守"设，不偏向任何机器）
//
// 配置文件位置：<TOOLBOX_HOME>/config.json
// 也可以用 XIYOUNG_CONFIG 指定别处。
//
// 各种"机况预设"见 PRESETS。用户不用逐项调，选一个预设再改几项就行。
// ---------------------------------------------------------------------------

/** 内置默认值。按"最小机器也能跑"设，不偏向任何特定硬件。 */
const BUILTIN_DEFAULTS = {
  // --- 模型与推理 ---
  "model": {
    // provider: ollama（本机/远程 Ollama）| openai（任何 OpenAI 兼容接口）
    // openai 兼容的包括 LM Studio、vLLM、OneAPI、各类云厂商
    "provider": "ollama",
    "name": "qwen3.5:4b",
    "host": "http://127.0.0.1:11434",
    "apiKey": "",
    "numCtx": 8192,
    "numPredict": 600,
    "timeoutSec": 600,
  "maxConcurrency": 1,
    "slowModels": ["qwen3-vl:4b"],
    // 自动扫描：启动和刷新时去后端拉模型列表
    "autoDiscover": true
  },
  // --- 视频分析 ---
  // 清晰度优先：这些值决定模型能不能读出字幕。
  // 实测 480p 源 + 640 宽拼图的竖屏片，单格画面只有 101x180，字幕全糊。
  // 慢一点可以接受，读错要重跑才是真贵。
  "video": {
    "height": 1080,
    "sheetWidth": 1000,
    "frameWidth": 1000,
    "framesPerSheet": 4,
    "maxSheets": 12,
    "concurrency": 1,
    // --- 抽帧密度（0.12.0）---
    // minInterval 是"自动规划"时的间隔下限。想让模型看得更细就调小它。
    // 0.05 是 ffmpeg 的 fps 过滤器还能给出不同帧的实用下限（20 帧/秒）。
    "minInterval": 1.0,
    // budget = 在 maxSheets*framesPerSheet 的预算内均匀铺满（快）
    // max    = 不管预算，按 minInterval 抽到最密（细，但慢很多）
    "density": "budget",
    "sceneThreshold": 0.3,
    // 拼图每行几格。2 = 2x2；3 = 3 格一排，适合宽画面
    "perRow": 2,
    // maxSheets 的硬上限。默认放开到 200，一部长片也能逐 2 秒看全。
    "maxSheetsHardCap": 200
  },
  // --- 音频 / 转写 ---
  "audio": {
    "chunkSec": 8.0,
    "overlapSec": 0.5,
    "f0Min": 75.0,
    "f0Max": 400.0,
    "language": "zh",
    // 分析帧长（秒）。0.01 = 10ms 一帧；调小更细但更慢、prosody.json 更大。
    "hop": 0.01
  },
  // --- 说话人 ---
  "speaker": {
    "clusterSeed": 0.82,
    "clusterMerge": 0.75,
    "diarizeWindow": 2.0,
    "backend": "auto",
    "modelPath": ""
  },
  // --- 变化点检测 ---
  "changes": {
    "minPauseSec": 0.4,
    "loudnessFloorDb": 12.0,
    "loudnessCeilDb": 25.0,
    "minGapSec": 5.0,
    "pitchJumpSemitone": 6.0,
    "registerMaxSemitone": 12.0
  },
  // --- 资源 ---
  "limits": {
    "maxLogLines": 400,
    "maxJobs": 60
    // maxSheetsHardCap 归到 video 组了（它只影响视频抽帧，放 limits 里语义不对）
  },
  // --- 界面 ---
  "ui": {
    "defaultTab": "analyze",
    "showAdvanced": false,
    "language": "zh"
  }
}

/** 机况预设。选一个当起点，再改个别项。
 *
 *  注意：这里**不再靠降分辨率换速度**。
 *
 *  实测（2026-11-26，48 帧竖屏 B 站视频）：
 *    - 格子宽高比跟随画面后，同样 640 宽的单格画面从 101x180 变成 320x568，
 *      不再有 68% 的黑边浪费；
 *    - 下载高度从 480 提到 1080，源视频的细节才留得住（480 是源头就丢了）。
 *  降清晰度省下的时间，远不如"模型读错字幕、要重跑"代价大。
 *  真正影响速度的是 maxSheets 和 concurrency，那两个才是该调的地方。
 */
const PRESETS = {
  "low": {
    "label": "低配（4GB 显存 / CPU 也能跑）",
    "note": "靠减少拼图张数省时间，不牺牲清晰度（清晰度降了模型会读错，反而更慢）",
    "patch": {
      video: { height: 720, sheetWidth: 800, frameWidth: 800, maxSheets: 8, concurrency: 1 },
      model: { numCtx: 4096, numPredict: 400 },
      audio: { chunkSec: 12.0 },
    },
  },
  "balanced": {
    "label": "均衡（默认）",
    "note": "8GB 显存左右，能开一点并发；1080p 源 + 1000 宽拼图",
    "patch": {
      video: { height: 1080, sheetWidth: 1000, frameWidth: 1000, maxSheets: 12, concurrency: 2 },
    },
  },
  "high": {
    "label": "高配（12GB+ 显存 / 独显）",
    "note": "分辨率高、并发高、更细的采样",
    "patch": {
      video: { height: 1080, sheetWidth: 1280, frameWidth: 1280, maxSheets: 20, concurrency: 3 },
      model: { numCtx: 8192, numPredict: 800 },
    },
  },
  "cpu": {
    "label": "纯 CPU（无可用 GPU）",
    "note": "不并发、拼图少，但清晰度仍保 720p —— 宁可少看几张，不要看错",
    "patch": {
      video: { height: 720, sheetWidth: 800, frameWidth: 800, maxSheets: 6, concurrency: 1 },
      model: { numCtx: 4096, numPredict: 400, timeoutSec: 1200 },
      audio: { chunkSec: 14.0 },
    },
  },
}

const CONFIG_PATH = process.env.XIYOUNG_CONFIG
  ? path.resolve(process.env.XIYOUNG_CONFIG)
  : path.join(TOOLBOX_HOME, 'config.json')

let configCache = null
let configCacheAt = 0

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base)
  for (const key of Object.keys(patch)) {
    const pv = patch[key]
    const bv = out[key]
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, pv)
    } else {
      out[key] = pv
    }
  }
  return out
}


/** 找出"用户手动设置盖住了预设"的项。
 *
 *  切换预设时，之前手动改过的字段不会跟着变（手动设置优先级更高）。
 *  这在逻辑上对，但用户会以为预设没生效。这里把冲突列出来让他知道。
 */
function findPresetShadowed(presetName, userData) {
  const preset = PRESETS[presetName]
  if (!preset) return []
  const shadowed = []
  const walk = (patch, userPatch, prefix) => {
    for (const key of Object.keys(patch)) {
      const pv = patch[key]
      const uv = userPatch ? userPatch[key] : undefined
      const path = prefix ? prefix + '.' + key : key
      if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
        if (uv && typeof uv === 'object') walk(pv, uv, path)
      } else if (uv !== undefined && uv !== pv) {
        shadowed.push({ path, presetValue: pv, userValue: uv })
      }
    }
  }
  const userPatch = Object.assign({}, userData)
  delete userPatch.preset
  walk(preset.patch, userPatch, '')
  return shadowed
}

/** 从环境变量读覆盖项。XIYOUNG_VIDEO_HEIGHT=720 这种。 */
function envOverrides() {
  const patch = {}
  const env = process.env
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  // 逐项映射，命名规则 XIYOUNG_<分组>_<字段>（大写蛇形）
  const map = [
    ['XIYOUNG_MODEL_PROVIDER', 'model', 'provider', String],
    ['XIYOUNG_MODEL_API_KEY', 'model', 'apiKey', String],
    ['XIYOUNG_MODEL_NAME', 'model', 'name', String],
    ['XIYOUNG_MODEL_HOST', 'model', 'host', String],
    ['XIYOUNG_MODEL_NUM_CTX', 'model', 'numCtx', num],
    ['XIYOUNG_MODEL_NUM_PREDICT', 'model', 'numPredict', num],
    ['XIYOUNG_MODEL_TIMEOUT_SEC', 'model', 'timeoutSec', num],
    ['XIYOUNG_MODEL_MAX_CONCURRENCY', 'model', 'maxConcurrency', num],
    ['XIYOUNG_VIDEO_HEIGHT', 'video', 'height', num],
    ['XIYOUNG_VIDEO_SHEET_WIDTH', 'video', 'sheetWidth', num],
    ['XIYOUNG_VIDEO_FRAME_WIDTH', 'video', 'frameWidth', num],
    ['XIYOUNG_VIDEO_FRAMES_PER_SHEET', 'video', 'framesPerSheet', num],
    ['XIYOUNG_VIDEO_MAX_SHEETS', 'video', 'maxSheets', num],
    ['XIYOUNG_VIDEO_CONCURRENCY', 'video', 'concurrency', num],
    ['XIYOUNG_VIDEO_SCENE_THRESHOLD', 'video', 'sceneThreshold', num],
    ['XIYOUNG_AUDIO_CHUNK_SEC', 'audio', 'chunkSec', num],
    ['XIYOUNG_AUDIO_OVERLAP_SEC', 'audio', 'overlapSec', num],
    ['XIYOUNG_AUDIO_F0_MIN', 'audio', 'f0Min', num],
    ['XIYOUNG_AUDIO_F0_MAX', 'audio', 'f0Max', num],
    ['XIYOUNG_AUDIO_LANGUAGE', 'audio', 'language', String],
    ['XIYOUNG_AUDIO_HOP', 'audio', 'hop', num],
    ['XIYOUNG_SPEAKER_CLUSTER_SEED', 'speaker', 'clusterSeed', num],
    ['XIYOUNG_SPEAKER_CLUSTER_MERGE', 'speaker', 'clusterMerge', num],
    ['XIYOUNG_SPEAKER_DIARIZE_WINDOW', 'speaker', 'diarizeWindow', num],
    ['XIYOUNG_SPEAKER_BACKEND', 'speaker', 'backend', String],
    ['XIYOUNG_SPEAKER_MODEL', 'speaker', 'modelPath', String],
    ['XIYOUNG_CHANGES_MIN_PAUSE_SEC', 'changes', 'minPauseSec', num],
    ['XIYOUNG_CHANGES_LOUDNESS_FLOOR_DB', 'changes', 'loudnessFloorDb', num],
    ['XIYOUNG_CHANGES_LOUDNESS_CEIL_DB', 'changes', 'loudnessCeilDb', num],
    ['XIYOUNG_CHANGES_MIN_GAP_SEC', 'changes', 'minGapSec', num],
    ['XIYOUNG_CHANGES_PITCH_JUMP_SEMITONE', 'changes', 'pitchJumpSemitone', num],
    ['XIYOUNG_CHANGES_REGISTER_MAX_SEMITONE', 'changes', 'registerMaxSemitone', num],
    ['XIYOUNG_LIMITS_MAX_LOG_LINES', 'limits', 'maxLogLines', num],
    ['XIYOUNG_LIMITS_MAX_JOBS', 'limits', 'maxJobs', num],
    ['XIYOUNG_UI_LANGUAGE', 'ui', 'language', String],
  ]
  for (const [envName, group, field, cast] of map) {
    const raw = env[envName]
    if (raw === undefined || raw === '') continue
    const val = cast(raw)
    if (val === undefined) continue
    patch[group] = patch[group] || {}
    patch[group][field] = val
  }
  return patch
}

/** 读配置文件。文件不存在或坏掉都退回空对象，不抛。 */
function readConfigFile() {
  try {
    if (!existsSync(CONFIG_PATH)) return { data: {}, exists: false }
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const data = JSON.parse(raw)
    return { data: data && typeof data === 'object' ? data : {}, exists: true }
  } catch (err) {
    return { data: {}, exists: false, error: String(err && err.message ? err.message : err) }
  }
}

/** 算出生效配置。带 1 秒缓存，避免每次读盘。 */
function getConfig(force = false) {
  const now = Date.now()
  if (!force && configCache && now - configCacheAt < 1000) return configCache
  const file = readConfigFile()
  // 预设先铺底，用户覆盖放最后
  let cfg = deepMerge(BUILTIN_DEFAULTS, {})
  const presetName = file.data && file.data.preset
  if (presetName && PRESETS[presetName]) {
    cfg = deepMerge(cfg, PRESETS[presetName].patch)
    cfg.preset = presetName
  }
  // 用户配置里除 preset 外的字段都是覆盖
  const userPatch = Object.assign({}, file.data)
  delete userPatch.preset
  cfg = deepMerge(cfg, userPatch)
  // 环境变量最高
  cfg = deepMerge(cfg, envOverrides())
  cfg.__meta = {
    configPath: CONFIG_PATH,
    configExists: file.exists,
    configError: file.error || null,
    preset: presetName || null,
    presetApplied: Boolean(presetName && PRESETS[presetName]),
  }
  configCache = cfg
  configCacheAt = now
  return cfg
}

/** 取某一项配置，带默认兜底。 */
function cfg(group, field, fallback) {
  const c = getConfig()
  const g = c[group]
  if (!g || typeof g !== 'object') return fallback
  const v = g[field]
  return v === undefined || v === null ? fallback : v
}

/** 写配置。只写用户显式设过的值，不把默认值全写进去。 */
function saveConfig(patch) {
  const file = readConfigFile()
  const next = deepMerge(file.data || {}, patch || {})
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
  configCache = null
  configCacheAt = 0
  return next
}

const LEGACY_HOME = path.join(DSH_HOME, 'xiyoung-toolbox')
const WORK_ROOT = process.env.XIYOUNG_WORK_ROOT || path.join(TOOLBOX_HOME, 'runs')

/**
 * 0.2.0 起数据目录从 ~/.dsh/xiyoung-toolbox 改成 ~/.dsh/xiyoungtools。
 * 老用户升级后如果只新建目录，会看不到之前的任务和标注池——所以第一次启动时
 * 把旧目录整个搬过来。只搬一次：新目录已经存在就跳过，不会覆盖新数据。
 */
function migrateLegacyHome() {
  try {
    if (!existsSync(LEGACY_HOME)) return
    if (existsSync(TOOLBOX_HOME)) return
    mkdirSync(path.dirname(TOOLBOX_HOME), { recursive: true })
    renameSync(LEGACY_HOME, TOOLBOX_HOME)
    console.log('xiyoungtools: migrated data from ' + LEGACY_HOME + ' to ' + TOOLBOX_HOME)
  } catch (error) {
    console.warn('xiyoungtools: could not migrate the legacy data directory', error)
  }
}
/**
 * 修正记录里写死的旧路径。
 *
 * 0.2.0 改名时目录从 xiyoung-toolbox 变成 xiyoungtools，但 clip.json / job.json 里
 * 存的绝对路径是当时写下的，搬家后仍然指向旧位置——文件其实在，只是记录说错了。
 * 这里把记录里的旧前缀替换成新前缀，只改文本，不动文件。
 */
function fixLegacyPathsInRecords() {
  if (!existsSync(TOOLBOX_HOME)) return
  if (!LEGACY_HOME || LEGACY_HOME === TOOLBOX_HOME) return
  // JSON 文件里反斜杠是转义过的（\\\\），按原文匹配会一个都匹配不上。
  const oldPrefix = LEGACY_HOME.replace(/\\/g, '\\\\')
  const newPrefix = TOOLBOX_HOME.replace(/\\/g, '\\\\')
  let fixed = 0
  const visit = (dir, depth = 0) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full, depth + 1)
        continue
      }
      if (!/^(clip|job)\.json$/.test(entry.name)) continue
      try {
        const raw = readFileSync(full, 'utf8')
        if (!raw.includes(oldPrefix)) continue
        const next = raw.split(oldPrefix).join(newPrefix)
        writeFileSync(full, next, 'utf8')
        fixed += 1
      } catch {
        /* 单个文件失败不影响别的 */
      }
    }
  }
  for (const kind of ['clips', 'prosody', 'runs', 'batches', 'analyze', 'clusters', 'diarize', 'bench']) {
    const dir = path.join(TOOLBOX_HOME, kind)
    if (existsSync(dir)) visit(dir)
  }
  if (fixed > 0) {
    console.log('xiyoungtools: fixed legacy paths in ' + fixed + ' record file(s)')
  }
}

const MAX_BODY = 1024 * 1024
// 这几个改成运行时从配置读，不再写死。
// 保留同名包装函数，调用点不用改。
function MAX_LOG() { return cfg('limits', 'maxLogLines', 400) }
function MAX_JOBS() { return cfg('limits', 'maxJobs', 60) }
function SLOW_MODELS() { return new Set(cfg('model', 'slowModels', ['qwen3-vl:4b'])) }
function OLLAMA() { return String(cfg('model', 'host', 'http://127.0.0.1:11434')).replace(/\/+$/, '') }
/** 运行时解析模型名：工具参数 > 配置 > 内置默认。 */
function resolveModel(explicit) {
  if (explicit) return String(explicit)
  return String(cfg('model', 'name', 'qwen3.5:4b'))
}

/** @type {Map<string, any>} */
const jobs = new Map()

function detectPython() {
  const candidates = [
    process.env.XIYOUNG_PYTHON,
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    process.platform === 'win32' ? 'python.exe' : 'python3',
    'python'
  ].filter(Boolean)

  // 逐个解析成真实可执行路径，再按「能不能 import librosa」排序。
  // 光看存在不够：PATH 里的系统 Python 往往没装 librosa，
  // 直接选它会等到跑韵律分析时才崩，错误还很难懂。
  const resolved = []
  for (const candidate of candidates) {
    const full = candidate.includes('/') || candidate.includes('\\')
      ? (existsSync(candidate) ? candidate : null)
      : findCommand(candidate)
    if (full && !resolved.includes(full)) resolved.push(full)
  }
  for (const full of resolved) {
    if (pythonHasLibrosa(full)) return full
  }
  // 一个都没装 librosa 的话，仍返回第一个能跑的（视频分析只要有 Pillow 就够）
  if (resolved.length) return resolved[0]
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

/** 这个解释器能不能 import librosa。同步探测一次，结果缓存。 */
const librosaCache = new Map()
function pythonHasLibrosa(pythonPath) {
  if (librosaCache.has(pythonPath)) return librosaCache.get(pythonPath)
  let ok = false
  try {
    const res = spawnSync(pythonPath, ['-c', 'import librosa'], {
      timeout: 15000,
      windowsHide: true,
      stdio: 'ignore'
    })
    ok = res.status === 0
  } catch {
    ok = false
  }
  librosaCache.set(pythonPath, ok)
  return ok
}

/** 这个解释器能不能 import resemblyzer。同步探测一次，结果缓存。 */
let resemblyzerProbe = null
function probeResemblyzer() {
  if (resemblyzerProbe !== null) return resemblyzerProbe
  try {
    const res = spawnSync(PYTHON, ['-c', 'import resemblyzer'], { timeout: 15000, windowsHide: true, stdio: 'ignore' })
    resemblyzerProbe = res.status === 0
  } catch {
    resemblyzerProbe = false
  }
  return resemblyzerProbe
}

function findCommand(name, extraDirs = []) {
  const names = process.platform === 'win32'
    ? [name + '.exe', name + '.cmd', name + '.bat', name]
    : [name]
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .concat(extraDirs)
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return null
}

function findYtDlp() {
  const fromPath = findCommand('yt-dlp')
  if (fromPath) return fromPath
  // Windows 的 pip 用户安装位置；别的平台 pip 一般已经在 PATH 里了
  if (process.platform !== 'win32') return null
  const bases = [
    path.join(homedir(), 'AppData', 'Roaming', 'Python'),
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'Scripts')
  ]
  for (const base of bases) {
    try {
      if (!existsSync(base)) continue
      // 前者是「Python3XX/Scripts/」，后者本身就是 Scripts 目录
      const direct = path.join(base, 'yt-dlp.exe')
      if (existsSync(direct)) return direct
      for (const entry of readdirSync(base)) {
        const candidate = path.join(base, entry, 'Scripts', 'yt-dlp.exe')
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* 这个位置没有 */
    }
  }
  return null
}

const PYTHON = detectPython()
const FFMPEG = findCommand('ffmpeg', [path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin')])
const YTDLP = findYtDlp()

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(body)
}

/** 请求体不合法时抛这个，路由据此回 400 而不是 500。 */
class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new BadRequestError('请求体过大（上限 1MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new BadRequestError('请求体不是有效 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function originOK(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

function contentTypeOK(req) {
  return String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')
}

function normalizeInput(raw) {
  const text = String(raw || '').trim()
  if (/^BV[0-9A-Za-z]+$/.test(text)) return 'https://www.bilibili.com/video/' + text
  try {
    const url = new URL(text)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
  } catch {
    /* not a URL */
  }
  return null
}

function isAllowedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv')
  } catch {
    return false
  }
}

function stageOf(line) {
  if (line.startsWith('[meta]')) return '读取视频信息'
  if (line.startsWith('[plan]')) return '规划抽帧'
  if (line.startsWith('[download]')) return '下载视频'
  if (line.startsWith('[frames]')) return '抽帧'
  if (line.startsWith('[sheets]')) return '拼图'
  if (line.startsWith('[vision]')) return '逐张识别'
  if (line.startsWith('[report]')) return '生成报告'
  if (line.startsWith('[summary]')) return '生成摘要'
  if (line.startsWith('[toolbox]')) return '准备中'
  return null
}


/** 读任务日志的最后几行，用来把真原因带进失败回执。 */
function tailLog(dir, lines = 3) {
  try {
    const p = path.join(dir, 'job.log')
    if (!existsSync(p)) return ''
    const all = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    return all.slice(-lines).join(' | ').slice(0, 400)
  } catch {
    return ''
  }
}

/** 从日志里挑出最像"真原因"的那一行。 */
function pickErrorLine(dir) {
  try {
    const p = path.join(dir, 'job.log')
    if (!existsSync(p)) return ''
    const all = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    // 优先找常见的错误特征
    const patterns = [
      /Error opening input/i,
      /Requested format is not available/i,
      /No such file/i,
      /Traceback/,
      /error:/i,
      /失败/,
      /ERROR/,
    ]
    for (let i = all.length - 1; i >= 0; i--) {
      const line = all[i]
      if (patterns.some((re) => re.test(line))) return line.slice(0, 300)
    }
    return all.length ? all[all.length - 1].slice(0, 300) : ''
  } catch {
    return ''
  }
}

/**
 * 统一日志泵：所有任务家族共用。
 *
 * 以前 8 个 append*Log 各自抄了一遍"剥 ANSI → 按行切 → 截断 → 写 stream"，
 * 差别只在 stage 解析。抄出来的问题很实在：改一处忘七处，0.10.2 修清理规则时
 * 就栽在这上面。这里把共通部分收进来，各家族只传自己的 onLine。
 *
 * @param {object} job           任务对象（需要有 log 数组，可选 logStream）
 * @param {string|Buffer} chunk  子进程输出
 * @param {object} [opts]
 * @param {(line:string)=>void} [opts.onLine]  每行的额外解析
 * @param {number} [opts.maxLines]             保留多少行，默认取配置
 */
function pumpLog(job, chunk, opts = {}) {
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : MAX_LOG()
  // eslint-disable-next-line no-control-regex
  const clean = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '')
  for (const line of clean.split('\n')) {
    const text = line.replace(/\s+$/, '')
    if (!text) continue
    if (!Array.isArray(job.log)) job.log = []
    job.log.push(text)
    while (job.log.length > maxLines) job.log.shift()
    if (job.logStream) {
      try {
        job.logStream.write(text + '\n')
      } catch {
        /* 日志文件是尽力而为 */
      }
    }
    if (opts.onLine) {
      try {
        opts.onLine(text)
      } catch {
        /* 单行解析失败不该影响整条日志 */
      }
    }
  }
}

function appendLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      const stage = stageOf(text)
      if (stage) job.stage = stage

      const sheets = text.match(/\[sheets\]\s*共\s*(\d+)\s*张/)
      if (sheets) job.total = Number(sheets[1])

      const vision = text.match(/\[vision\]\s*(\S+\.jpg).*?ok=(True|False).*?items=(\d+)/)
      if (vision) {
        const file = vision[1]
        if (!job.seen.has(file)) {
          job.seen.add(file)
          if (vision[2] === 'True') job.done += 1
          // 记录每张实际耗时，用来估剩时间
          const elapsed = text.match(/\s([\d.]+)s$/m)
          if (elapsed) {
            job.sheetTimes = job.sheetTimes || []
            job.sheetTimes.push(Number(elapsed[1]))
            if (job.sheetTimes.length > 12) job.sheetTimes.shift()
          }
        }
      }
      // 当前正在分析哪张：出现 [vision] xxx 但还没出 ok= 时
      const started = text.match(/^\[vision\]\s*(\S+\.jpg)(?!.*ok=)/)
      if (started) job.currentSheet = started[1]
      if (vision) job.currentSheet = null
    },
  })
}

/** 估剩余秒数。样本不足或没有总数时返回 null，不猜。
 *
 *  用已完成的平均耗时 × 剩余张数。因为单张耗时抖动很大
 *  （实测 45–84 秒），这个数只能当"还要等几分钟"的量级参考。
 */
function estimateEta(job) {
  const times = job.sheetTimes || []
  const total = job.total
  if (!times.length || !total || job.status !== 'running') return null
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  // 正在处理的那张算半张
  const remaining = Math.max(0, total - job.done - (job.currentSheet ? 0.5 : 0))
  return Math.round(avg * remaining)
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    model: job.model || null,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    error: job.error || null,
    progress: {
      done: job.done,
      total: job.total,
      currentSheet: job.currentSheet || null,
      // 剩余时间估算：用已完成的平均耗时 × 剩余张数。
      // 实测这台机器单张 45–84 秒（极差 1.9 倍），所以估算只能当量级参考。
      etaSeconds: estimateEta(job)
    },
    result: job.result || null,
    log: job.log.slice(-160)
  }
}

/** 把某个任务表压到 MAX_JOBS() 以内：先删最老的已结束任务。 */
function pruneMap(map) {
  while (map.size > MAX_JOBS) {
    const finished = [...map.values()]
      .filter((job) => job.status !== 'running' && job.status !== 'queued')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    if (finished.length === 0) return
    map.delete(finished[0].id)
  }
}

function pruneJobs() {
  pruneMap(jobs)
}

function buildJobResult(job) {
  const outDir = job.outDir
  const analysisPath = path.join(outDir, 'analysis.json')
  let analysis = []
  try {
    if (existsSync(analysisPath)) analysis = JSON.parse(readFileSync(analysisPath, 'utf8'))
  } catch {
    analysis = []
  }
  const analyzed = Array.isArray(analysis) ? analysis.filter((entry) => entry && entry.ok).length : 0
  const total = Array.isArray(analysis) ? analysis.length : 0

  // 2026-11-27 补丁（社区贡献）：扁平清单（时间 → 场景/动作/文字），给 agent 直接消费。
  // python 那边新版本会写 entries.json；旧版本的 run 目录没有，就从 analysis.json 现推。
  const entriesPath = path.join(outDir, 'entries.json')
  let entries = []
  try {
    if (existsSync(entriesPath)) {
      const raw = JSON.parse(readFileSync(entriesPath, 'utf8'))
      if (Array.isArray(raw)) entries = raw
    }
  } catch {
    entries = []
  }
  if (!entries.length && Array.isArray(analysis)) {
    for (const sheet of analysis) {
      if (!sheet || !sheet.ok) continue
      for (const it of sheet.items || []) {
        const text = String(it?.text ?? '').trim()
        entries.push({
          time: String(it?.time ?? ''),
          sheet: sheet.sheet,
          range: sheet.range,
          scene: String(it?.scene ?? '').trim(),
          characters: String(it?.characters ?? '').trim(),
          action: String(it?.action ?? '').trim(),
          text: ['', '无', '没有', 'None', 'none', 'null'].includes(text) ? '' : text
        })
      }
    }
  }

  const sheetsDir = path.join(outDir, 'sheets')
  let sheetFiles = []
  try {
    if (existsSync(sheetsDir)) sheetFiles = readdirSync(sheetsDir).filter((file) => file.endsWith('.jpg')).sort()
  } catch {
    sheetFiles = []
  }

  return {
    outDir,
    reportPath: path.join(outDir, 'report.md'),
    summaryPath: path.join(outDir, 'summary.md'),
    analysisPath,
    entriesPath,
    entries,
    entriesTotal: entries.length,
    sheets: sheetFiles.length,
    analyzed,
    total,
    sheetFiles
  }
}

function writeJobMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify({
      id: job.id,
      url: job.url,
      model: job.model || null,
      summary: job.summary !== false,
      status: job.status,
      stage: job.stage || null,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      endedAt: job.endedAt || null,
      error: job.error || null,
      result: job.result || null
    }, null, 2), 'utf8')
  } catch {
    /* metadata is best effort */
  }
}

function finalize(job, code) {
  if (job.finalized) return
  job.finalized = true
  job.endedAt = Date.now()
  job.exitCode = code
  job.result = buildJobResult(job)

  if (code === 0 && existsSync(job.result.reportPath)) {
    job.status = 'done'
    job.stage = '已完成'
  } else {
    job.status = 'error'
    job.stage = '失败'
    if (!job.error && job.result.total > 0 && job.result.analyzed === 0) {
      job.error = '视觉模型“' + (job.model || '') + '”没有返回可用结果；请改用 qwen3.5:4b 重试'
    } else if (!job.error && job.model === 'qwen3-vl:4b') {
      job.error = 'qwen3-vl:4b 运行失败（可能内存不足或返回空内容）；请改用 qwen3.5:4b'
    }
    if (!job.error) {
      const reason = pickErrorLine(job.outDir)
      const tail = tailLog(job.outDir, 2)
      job.error = (existsSync(job.result.reportPath)
        ? '分析进程退出码 ' + code
        : '分析进程退出码 ' + code + '（没有生成 report.md）')
        + (reason ? '\n原因：' + reason : '')
        + (tail && tail !== reason ? '\n日志末尾：' + tail : '')
    }
    appendLog(job, '[toolbox] ' + job.error)
  }

  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* already closed */
    }
    job.logStream = null
  }
  writeJobMeta(job)
}

/** 把 "90" / "1:30" / "0:01:30" 转成秒数。看不懂返回 null。
 *  这是 python 侧 parse_time 的 JS 镜像，只用于路由层的浅校验——
 *  真正的解析和边界检查在 video_watch.py 里，那边才对视频时长有认知。
 */
function timeToSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parts = String(value).trim().split(':')
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (nums.length === 1) return nums[0]
  if (nums.length === 2) return nums[0] * 60 + nums[1]
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
  return null
}

/** 把生效配置注入成环境变量，供 python 子进程读。
 *
 *  python 侧不直接读 config.json——路径传递、编码、竞态都麻烦。
 *  统一由 Host 读好配置，用环境变量下发，python 只认环境变量。
 */
/**
 * 把"单次调用"的模型参数翻译成环境变量覆盖。
 *
 * 为什么走环境变量而不是 CLI：模型参数是所有 python 脚本共享的（video_watch.py
 * 和 prosody.py 都读 XIYOUNG_MODEL_*），但它们的 CLI 参数各叫各的名字。
 * 走 pythonEnv(extra) 这一层，一处生效、所有脚本受益，也不用给每个脚本都加 CLI 参数。
 */
function modelEnvOverrides(options = {}) {
  const extra = {}
  const numCtx = Number(options.numCtx)
  if (Number.isFinite(numCtx) && numCtx > 0) extra.XIYOUNG_MODEL_NUM_CTX = String(numCtx)
  const numPredict = Number(options.numPredict)
  if (Number.isFinite(numPredict) && numPredict > 0) extra.XIYOUNG_MODEL_NUM_PREDICT = String(numPredict)
  const timeoutSec = Number(options.timeoutSec)
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) extra.XIYOUNG_MODEL_TIMEOUT_SEC = String(timeoutSec)
  if (options.modelHost) extra.XIYOUNG_MODEL_HOST = String(options.modelHost)
  return extra
}

/**
 * 把单次调用的 changes 阈值翻译成环境变量覆盖。
 * 和 modelEnvOverrides 同样的道理：prosody.py 读的是 XIYOUNG_CHANGES_*，
 * 给它加 6 个 CLI 参数不值当，走环境变量一层就够。
 */
function changesEnvOverrides(options = {}) {
  const extra = {}
  const map = [
    ['minPauseSec', 'XIYOUNG_CHANGES_MIN_PAUSE_SEC'],
    ['loudnessFloorDb', 'XIYOUNG_CHANGES_LOUDNESS_FLOOR_DB'],
    ['loudnessCeilDb', 'XIYOUNG_CHANGES_LOUDNESS_CEIL_DB'],
    ['minGapSec', 'XIYOUNG_CHANGES_MIN_GAP_SEC'],
    ['pitchJumpSemitone', 'XIYOUNG_CHANGES_PITCH_JUMP_SEMITONE'],
    ['registerMaxSemitone', 'XIYOUNG_CHANGES_REGISTER_MAX_SEMITONE'],
  ]
  for (const [key, envName] of map) {
    const v = Number(options[key])
    if (Number.isFinite(v) && v >= 0) extra[envName] = String(v)
  }
  return extra
}

function pythonEnv(extra = {}) {
  const c = getConfig()
  const env = Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    // 模型
    XIYOUNG_MODEL_PROVIDER: String(c.model.provider || 'ollama'),
    XIYOUNG_MODEL_API_KEY: String(c.model.apiKey || ''),
    XIYOUNG_MODEL_NAME: String(c.model.name || 'qwen3.5:4b'),
    XIYOUNG_MODEL_HOST: String(c.model.host || ''),
    XIYOUNG_MODEL_NUM_CTX: String(c.model.numCtx || 8192),
    XIYOUNG_MODEL_NUM_PREDICT: String(c.model.numPredict || 600),
    XIYOUNG_MODEL_TIMEOUT_SEC: String(c.model.timeoutSec || 600),
    XIYOUNG_MODEL_MAX_CONCURRENCY: String(c.model.maxConcurrency ?? 1),
    // 视频：这一组之前漏了，导致 config 里的 video.* 对页面上发起的分析完全无效，
    // video_watch.py 只能回落到它自己的默认值（480 / 12 / 800）。
    XIYOUNG_VIDEO_HEIGHT: String(c.video.height || 480),
    XIYOUNG_VIDEO_SHEET_WIDTH: String(c.video.sheetWidth || 800),
    XIYOUNG_VIDEO_FRAME_WIDTH: String(c.video.frameWidth || 800),
    XIYOUNG_VIDEO_FRAMES_PER_SHEET: String(c.video.framesPerSheet || 4),
    XIYOUNG_VIDEO_MAX_SHEETS: String(c.video.maxSheets || 12),
    XIYOUNG_VIDEO_CONCURRENCY: String(c.video.concurrency || 1),
    // 抽帧密度控制（0.12.0）：原来只有 interval 一个旋钮，且 python 侧把它夹在 >=1 秒，
    // 短视频怎么调都是 1 秒/帧。现在这三个一起决定"看多细"。
    XIYOUNG_VIDEO_MIN_INTERVAL: String(c.video.minInterval ?? 1.0),
    XIYOUNG_VIDEO_DENSITY: String(c.video.density || 'budget'),
    XIYOUNG_VIDEO_SCENE_THRESHOLD: String(c.video.sceneThreshold ?? 0.3),
    XIYOUNG_VIDEO_PER_ROW: String(c.video.perRow || 2),
    // 音频
    XIYOUNG_AUDIO_CHUNK_SEC: String(c.audio.chunkSec || 8),
    XIYOUNG_AUDIO_OVERLAP_SEC: String(c.audio.overlapSec || 0.5),
    XIYOUNG_AUDIO_F0_MIN: String(c.audio.f0Min || 75),
    XIYOUNG_AUDIO_F0_MAX: String(c.audio.f0Max || 400),
    XIYOUNG_AUDIO_LANGUAGE: String(c.audio.language || 'zh'),
    XIYOUNG_AUDIO_HOP: String(c.audio.hop || 0.01),
    // 说话人
    XIYOUNG_SPEAKER_CLUSTER_SEED: String(c.speaker.clusterSeed || 0.82),
    XIYOUNG_SPEAKER_CLUSTER_MERGE: String(c.speaker.clusterMerge || 0.75),
    XIYOUNG_SPEAKER_DIARIZE_WINDOW: String(c.speaker.diarizeWindow || 2.0),
    XIYOUNG_SPEAKER_BACKEND: String(c.speaker.backend || 'auto'),
    XIYOUNG_SPEAKER_MODEL: String(c.speaker.modelPath || ''),
    // 变化点
    XIYOUNG_CHANGES_MIN_PAUSE_SEC: String(c.changes.minPauseSec || 0.4),
    XIYOUNG_CHANGES_LOUDNESS_FLOOR_DB: String(c.changes.loudnessFloorDb || 12),
    XIYOUNG_CHANGES_LOUDNESS_CEIL_DB: String(c.changes.loudnessCeilDb || 25),
    // 之前写成了 MINGAP（少一个下划线），prosody.py 读的是 MIN_GAP_SEC，于是这个配置项一直失效
    XIYOUNG_CHANGES_MIN_GAP_SEC: String(c.changes.minGapSec ?? 0.35),
    // 这两项以前是完全没人读的死键，现在 python 侧接了 cfg_num
    XIYOUNG_CHANGES_PITCH_JUMP_SEMITONE: String(c.changes.pitchJumpSemitone || 6.0),
    XIYOUNG_CHANGES_REGISTER_MAX_SEMITONE: String(c.changes.registerMaxSemitone || 12.0),
  }, extra)
  return env
}

function startJob(input, options) {
  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(WORK_ROOT, id)
  mkdirSync(outDir, { recursive: true })

  const model = String(resolveModel(options.model))
  const logPath = path.join(outDir, 'job.log')
  let logStream = null
  try {
    logStream = createWriteStream(logPath, { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const job = {
    id,
    url: input,
    model,
    summary: options.summary !== false,
    start: options.start !== undefined ? String(options.start) : null,
    end: options.end !== undefined ? String(options.end) : null,
    duration: options.duration !== undefined ? String(options.duration) : null,
    // maxSheets 被 maxSheetsHardCap 夹住时记下来，回执里说明（之前是静默的）
    maxSheetsCapped: options.maxSheetsCapped === true,
    wantSheets: Number(options.wantSheets) || null,
    effectiveMaxSheets: Number(options.effectiveMaxSheets) || null,
    outDir,
    status: 'queued',
    stage: '准备中',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    error: null,
    code: null,
    log: [],
    done: 0,
    total: null,
    seen: new Set(),
    result: null,
    finalized: false,
    logStream
  }
  jobs.set(id, job)
  pruneJobs()
  writeJobMeta(job)

  const args = [SCRIPT, input, '--outdir', outDir, '--model', model]
  if (job.summary) args.push('--summary')
  const interval = Number(options.interval)
  if (Number.isFinite(interval) && interval > 0) args.push('--interval', String(interval))
  const maxSheets = Number(options.maxSheets)
  if (Number.isFinite(maxSheets) && maxSheets > 0) args.push('--max-sheets', String(maxSheets))
  const minInterval = Number(options.minInterval)
  if (Number.isFinite(minInterval) && minInterval > 0) args.push('--min-interval', String(minInterval))
  if (options.density) args.push('--density', String(options.density))
  if (options.sceneThreshold !== undefined && options.sceneThreshold !== null) {
    args.push('--scene-threshold', String(options.sceneThreshold))
  }
  const framesPerSheet = Number(options.framesPerSheet)
  if (Number.isFinite(framesPerSheet) && framesPerSheet > 0) args.push('--frames-per-sheet', String(framesPerSheet))
  const perRow = Number(options.perRow)
  if (Number.isFinite(perRow) && perRow > 0) args.push('--per-row', String(perRow))
  const height = Number(options.height)
  if (Number.isFinite(height) && height > 0) args.push('--height', String(height))
  // 拼图宽度和单帧宽度：以前只有配置页能调，agent 调用改不了。
  const sheetWidth = Number(options.sheetWidth)
  if (Number.isFinite(sheetWidth) && sheetWidth > 0) args.push('--sheet-width', String(sheetWidth))
  const frameWidth = Number(options.frameWidth)
  if (Number.isFinite(frameWidth) && frameWidth > 0) args.push('--width', String(frameWidth))
  // 并发：默认 1（串行）。显卡够大、模型全进显存时才值得调大。
  const concurrency = Number(options.concurrency)
  if (Number.isFinite(concurrency) && concurrency > 1) args.push('--concurrency', String(Math.min(8, Math.floor(concurrency))))
  // 时间段：start / end / duration，接受 "1:30" 或秒数。
  // 原样传字符串，让 python 那边统一 parse_time —— JS 不重复实现解析。
  if (options.start !== undefined && options.start !== null && String(options.start).trim() !== '') {
    args.push('--start', String(options.start).trim())
  }
  if (options.end !== undefined && options.end !== null && String(options.end).trim() !== '') {
    args.push('--end', String(options.end).trim())
  }
  if (options.duration !== undefined && options.duration !== null && String(options.duration).trim() !== '') {
    args.push('--duration', String(options.duration).trim())
  }
  // 2026-11-27 补丁（社区贡献）：跨任务下载缓存。默认落到 $DSH_HOME/xiyoungtools/cache/video，
  // 同一视频看第二段时按「视频id + 短边 + 时间段」命中，不再重下整条。
  const cacheDir = options.cacheDir
    ? String(options.cacheDir)
    : path.join(TOOLBOX_HOME, 'cache', 'video')
  args.push('--cache-dir', cacheDir)

  appendLog(job, '[toolbox] 启动分析：' + input + '\n[toolbox] 模型：' + model)

  const child = spawn(PYTHON, args, {
    cwd: WORK_ROOT,
    env: pythonEnv(modelEnvOverrides(options)),
    windowsHide: true
  })
  job.child = child
  job.status = 'running'
  job.startedAt = Date.now()
  writeJobMeta(job)

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => appendLog(job, chunk))
  child.stderr.on('data', (chunk) => appendLog(job, chunk))
  child.on('error', (error) => {
    job.error = String(error && error.message ? error.message : error)
    appendLog(job, '[toolbox] 启动失败：' + job.error)
    finalize(job, 1)
  })
  child.on('close', (code) => finalize(job, code === null ? 1 : code))

  return job
}

function activeJob() {
  return [...jobs.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function readJobReport(job) {
  const result = job.result || buildJobResult(job)
  return {
    report: existsSync(result.reportPath) ? readFileSync(result.reportPath, 'utf8') : '',
    summary: existsSync(result.summaryPath) ? readFileSync(result.summaryPath, 'utf8') : '',
    outDir: job.outDir,
    sheetFiles: result.sheetFiles || [],
    sheets: result.sheets || 0,
    analyzed: result.analyzed || 0,
    total: result.total || 0
  }
}

async function waitForJob(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return job
}

// 2026-11-27 补丁（社区贡献）：逐格结果只回前 80 条，剩下的给路径。
// 80 条大约 4-6 KB，对上下文友好；要看全的读 entriesPath。
const TOOL_ENTRIES_MAX = 80

function finishedToolResult(job, includeReport) {
  const report = readJobReport(job)
  const titleMatch = report.report.match(/^#\s*《(.+?)》/m)
  const summary = String(report.summary || '').trim()
  const full = String(report.report || '')
  const limit = 12000

  // 从报告里抽元数据（可信，来自 B 站）
  const uploaderMatch = report.report.match(/^- UP 主：(.+)$/m)
  const descMatch = report.report.match(/## 简介\n\n([\s\S]*?)(?=\n## |$)/)

  // OCR 不稳定警告：同一处文字被读成多个写法
  const unstableMatch = report.report.match(/## ⚠ OCR 不稳定[\s\S]*?(?=\n## |$)/)
  const unstableLines = unstableMatch
    ? unstableMatch[0].split('\n').filter((l) => l.startsWith('- 「')).map((l) => l.replace(/^- /, '').trim())
    : []

  // 本次请求的时间段（从请求参数或报告横幅里取）
  const rangeBanner = report.report.match(/^> ⚠ \*\*只看了 (.+?) 这一段\*\*/m)

  // 被 maxSheetsHardCap 夹住时要说清楚，否则用户会以为设的 300 生效了
  const capNote = (job.maxSheetsCapped && job.wantSheets && job.effectiveMaxSheets)
    ? ('maxSheets 给了 ' + job.wantSheets + '，但被 video.maxSheetsHardCap 限制为 '
       + job.effectiveMaxSheets + '。想要更多拼图，调高那个配置项。')
    : null

  return {
    ok: job.status === 'done',
    jobId: job.id,
    status: job.status,
    stage: job.stage || null,
    title: titleMatch ? titleMatch[1] : null,
    requestedRange: job.requestedRange || null,
    watchedRange: rangeBanner ? rangeBanner[1].trim() : null,
    uploader: uploaderMatch ? uploaderMatch[1].trim() : null,
    videoDescription: descMatch ? descMatch[1].trim().slice(0, 500) : null,
    // 摘要由模型生成，人名/书名来自 OCR，不可靠
    summaryIsModelGenerated: Boolean(summary),
    maxSheetsNote: capNote,
    summaryCaveat: summary
      ? '摘要是本地视觉模型根据逐帧画面写的，不是事实核对。画面里的人名、书名、术语来自 OCR，可能读错。'
      : null,
    unstableOcr: unstableLines.length ? unstableLines : [],
    sheets: report.sheets,
    analyzed: report.analyzed,
    total: report.total,
    // maxSheets 的实际生效值。schema 允许到 500，但被 maxSheetsHardCap 夹住，
    // 之前用户传 300 变成 200 是完全静默的。
    maxSheetsCapped: job.maxSheetsCapped === true,
    effectiveMaxSheets: job.effectiveMaxSheets,
    wantedMaxSheets: job.wantSheets,
    // 2026-11-27 补丁（社区贡献）：逐格结构化结果（按时间排序），
    // agent 不必再读 report.md 找时间点。只回前 80 条，剩下的给路径。
    entries: Array.isArray(job.result && job.result.entries)
      ? job.result.entries.slice(0, TOOL_ENTRIES_MAX)
      : [],
    entriesTotal: (job.result && job.result.entriesTotal) || 0,
    entriesOmitted: Math.max(0, ((job.result && job.result.entriesTotal) || 0) - TOOL_ENTRIES_MAX),
    analysisPath: (job.result && job.result.analysisPath) || path.join(job.outDir, 'analysis.json'),
    entriesPath: (job.result && job.result.entriesPath) || path.join(job.outDir, 'entries.json'),
    summary: summary || full.slice(0, 800),
    report: includeReport ? full.slice(0, limit) : '',
    reportTruncated: Boolean(includeReport && full.length > limit),
    outDir: report.outDir,
    reportPath: (job.result && job.result.reportPath) || path.join(job.outDir, 'report.md'),
    error: job.error || null
  }
}

function runningToolResult(job) {
  return {
    ok: false,
    jobId: job.id,
    status: job.status,
    stage: job.stage || null,
    progress: { done: job.done, total: job.total },
    note: '任务仍在后台运行；请调用 toolbox_job({ id }) 查询，不要重复启动。',
    log: job.log.slice(-20),
    outDir: job.outDir
  }
}


// ---------------------------------------------------------------------------
// 统一任务查询
//
// 原来 7 个工具各有一个 _status（video_summary_status、prosody_status、
// batch_status、cluster_status、diarize_status、benchmark_status、
// media_clip_status），接口完全一样都是"给 id 拿结果"，纯冗余。
//
// 合并成一个 toolbox_job：给 id 就自动判断是哪种任务。
// 判断顺序：
//   1. 先查内存里的 map（正在跑的只在内存里）
//   2. 再查磁盘目录（历史任务）
// ---------------------------------------------------------------------------

const JOB_KINDS = [
  { kind: 'video', map: () => jobs, root: () => WORK_ROOT, public: publicJob, result: finishedToolResult },
  { kind: 'clip', map: () => clips, root: () => CLIP_ROOT, public: publicClip, result: clipToolResult },
  { kind: 'prosody', map: () => prosodies, root: () => PROSODY_ROOT, public: publicProsody, result: prosodyToolResult },
  { kind: 'batch', map: () => batches, root: () => BATCH_ROOT, public: publicBatch, result: batchToolResult },
  { kind: 'cluster', map: () => clusterJobs, root: () => CLUSTER_ROOT, public: publicCluster, result: clusterToolResult },
  { kind: 'diarize', map: () => diarizeJobs, root: () => DIARIZE_ROOT, public: publicDiarize, result: diarizeToolResult },
  { kind: 'bench', map: () => benchJobs, root: () => BENCH_ROOT, public: publicBench, result: benchToolResult },
  // 一站式分析：toolbox_analyze 的回执里让调用方用 toolbox_job 查，这里必须能被找到
  { kind: 'analyze', map: () => analyzeJobs, root: () => ANALYZE_ROOT, public: publicAnalyze, result: analyzeToolResult },
]

/** 按 id 找任务。返回 {kind, job, source} 或 null。 */
function findJobAnyKind(id) {
  if (!id) return null
  // 1) 内存优先——正在跑的任务只在内存里
  for (const item of JOB_KINDS) {
    let map
    try {
      map = item.map()
    } catch {
      continue
    }
    if (map && typeof map.get === 'function') {
      const job = map.get(id)
      if (job) return { kind: item.kind, job, source: 'memory', spec: item }
    }
  }
  // 2) 磁盘——历史任务
  for (const item of JOB_KINDS) {
    let rootDir
    try {
      rootDir = item.root()
    } catch {
      continue
    }
    if (!rootDir) continue
    const dir = path.join(rootDir, id)
    if (!existsSync(dir)) continue
    const metaPath = path.join(dir, 'job.json')
    let meta = null
    try {
      if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {
      meta = null
    }
    if (!meta) continue
    return { kind: item.kind, job: meta, source: 'disk', spec: item }
  }
  return null
}

// ---------------------------------------------------------------------------
// 一站式分析：一个视频/音频文件，同时做画面和声音
//
// 原来的问题：想做视频+音频得调两次工具、传两次同样的路径，
// 还得自己拼两份报告。
//
// 现在一个调用：
//   toolbox_analyze({ source: "D:\\video.mp4" })
//   → 画面：逐帧观看 + 摘要
//   → 声音：转写 + 韵律 + 变化点 + 说话人
//   → 一份合并报告
//
// 只给本地文件或直链；B 站链接仍建议用 video_summary（它有下载和元信息）。
// ---------------------------------------------------------------------------

const ANALYZE_ROOT = process.env.XIYOUNG_ANALYZE_ROOT || path.join(TOOLBOX_HOME, 'analyze')

/** @type {Map<string, any>} */
const analyzeJobs = new Map()

function activeAnalyze() {
  return [...analyzeJobs.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function publicAnalyze(job) {
  return {
    id: job.id,
    kind: 'analyze',
    source: job.source,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    progress: {
      video: job.videoState || null,
      audio: job.audioState || null,
    },
    outDir: job.outDir,
    log: job.log.slice(-120),
  }
}

function writeAnalyzeMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify(publicAnalyze(job), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function appendAnalyzeLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      if (text.startsWith('[prosody]')) job.audioState = text.replace(/^\[prosody\]\s*/, '')
      else if (text.startsWith('[video]')) job.videoState = text.replace(/^\[video\]\s*/, '')
      else if (text.startsWith('[analyze]')) job.stage = text.replace(/^\[analyze\]\s*/, '')
    },
  })
}

/**
 * 启动一站式分析。
 *
 * 两条流水线并行跑：
 *   - 音频：prosody.py（转写 + 韵律 + 变化点 + 说话人）
 *   - 视频：video_watch.py（抽帧 + 视觉模型）
 *
 * 画面要下载/解码，音频只要文件本身，所以音频通常更快出结果。
 */
function startAnalyze(source, options = {}) {
  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(ANALYZE_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  const audioDir = path.join(outDir, 'audio')
  const videoDir = path.join(outDir, 'video')
  mkdirSync(audioDir, { recursive: true })
  mkdirSync(videoDir, { recursive: true })

  let logStream = null
  try {
    // eslint-disable-next-line no-undef
    logStream = createWriteStream(path.join(outDir, 'job.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const job = {
    id,
    kind: 'analyze',
    source,
    outDir,
    status: 'running',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    audioState: null,
    videoState: null,
    log: [],
    children: [],
    logStream,
    finalized: false,
    videoSkipped: options.video === false,
    audioSkipped: options.audio === false,
  }
  analyzeJobs.set(id, job)
  pruneMap(analyzeJobs)
  writeAnalyzeMeta(job)

  // ---- 音频流水线 ----
  if (!job.audioSkipped) {
    const audioArgs = [PROSODY_SCRIPT, source, '--outdir', audioDir]
    if (options.start) audioArgs.push('--start', String(options.start))
    if (options.duration) audioArgs.push('--duration', String(options.duration))
    if (options.noTranscribe) audioArgs.push('--no-transcribe')
    const child = spawn(PYTHON, audioArgs, {
      cwd: ANALYZE_ROOT,
      env: pythonEnv(modelEnvOverrides(options)),
      windowsHide: true,
    })
    job.children.push(child)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => appendAnalyzeLog(job, chunk))
    child.stderr.on('data', (chunk) => appendAnalyzeLog(job, chunk))
    child.on('error', (error) => {
      job.audioError = String(error && error.message ? error.message : error)
      appendAnalyzeLog(job, '[analyze] 音频流水线启动失败：' + job.audioError)
    })
    child.on('close', () => {
      job.audioDone = true
      checkAnalyzeDone(job)
    })
  } else {
    job.audioDone = true
  }

  // ---- 视频流水线 ----
  if (!job.videoSkipped) {
    const videoArgs = [SCRIPT, source, '--outdir', videoDir, '--model', String(resolveModel(options.model))]
    if (options.summary !== false) videoArgs.push('--summary')
    if (options.start) videoArgs.push('--start', String(options.start))
    if (options.end) videoArgs.push('--end', String(options.end))
    if (options.duration) videoArgs.push('--duration', String(options.duration))
    if (options.maxSheets) videoArgs.push('--max-sheets', String(options.maxSheets))
    if (options.interval) videoArgs.push('--interval', String(options.interval))
    if (options.minInterval) videoArgs.push('--min-interval', String(options.minInterval))
    if (options.density) videoArgs.push('--density', String(options.density))
  if (options.sceneThreshold !== undefined && options.sceneThreshold !== null) {
    videoArgs.push('--scene-threshold', String(options.sceneThreshold))
  }
    if (options.framesPerSheet) videoArgs.push('--frames-per-sheet', String(options.framesPerSheet))
    if (options.perRow) videoArgs.push('--per-row', String(options.perRow))
    if (options.concurrency && options.concurrency > 1) {
      videoArgs.push('--concurrency', String(Math.min(8, Math.floor(options.concurrency))))
    }
    const child = spawn(PYTHON, videoArgs, {
      cwd: ANALYZE_ROOT,
      env: pythonEnv(modelEnvOverrides(options)),
      windowsHide: true,
    })
    job.children.push(child)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // video_watch.py 的输出没有 [video] 前缀，加一层标记免得和音频日志混在一起
    child.stdout.on('data', (chunk) => appendAnalyzeLog(job, String(chunk).replace(/^(?=\[)/gm, '[video] ')))
    child.stderr.on('data', (chunk) => appendAnalyzeLog(job, String(chunk).replace(/^(?=\[)/gm, '[video] ')))
    child.on('error', (error) => {
      job.videoError = String(error && error.message ? error.message : error)
      appendAnalyzeLog(job, '[analyze] 视频流水线启动失败：' + job.videoError)
    })
    child.on('close', () => {
      job.videoDone = true
      checkAnalyzeDone(job)
    })
  } else {
    job.videoDone = true
  }

  return job
}

function checkAnalyzeDone(job) {
  if (job.finalized) return
  if (!job.audioDone || !job.videoDone) {
    job.stage = (job.audioDone ? '声音已完成' : '声音分析中') + ' · ' + (job.videoDone ? '画面已完成' : '画面分析中')
    writeAnalyzeMeta(job)
    return
  }
  job.finalized = true
  job.endedAt = Date.now()
  // 合并报告：两个子流程各自有报告，这里只判断有没有产出
  const audioJson = path.join(job.outDir, 'audio', 'prosody.json')
  const videoReport = path.join(job.outDir, 'video', 'report.md')
  const hasAudio = existsSync(audioJson)
  const hasVideo = existsSync(videoReport)
  if (hasAudio || hasVideo) {
    job.status = 'done'
    job.stage = '已完成'
  } else {
    job.status = 'error'
    job.stage = '失败'
    job.error = job.audioError || job.videoError || '两条流水线都没有产出结果'
  }
  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* closed */
    }
    job.logStream = null
  }
  writeAnalyzeMeta(job)
}

function readAnalyzeAudio(job) {
  try {
    return JSON.parse(readFileSync(path.join(job.outDir, 'audio', 'prosody.json'), 'utf8'))
  } catch {
    return null
  }
}

function readAnalyzeVideoReport(job) {
  try {
    return readFileSync(path.join(job.outDir, 'video', 'report.md'), 'utf8')
  } catch {
    return null
  }
}

async function waitForAnalyze(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  return job
}

function analyzeToolResult(job) {
  const audio = readAnalyzeAudio(job)
  const videoReport = readAnalyzeVideoReport(job)
  const summary = (audio && audio.summary) || null
  return {
    ok: job.status === 'done',
    analyzeId: job.id,
    status: job.status,
    stage: job.stage || null,
    source: job.source,
    // 声音侧
    audio: audio ? {
      transcript: audio.transcript || null,
      transcriptStatus: audio.transcriptStatus || (summary && summary.transcriptStatus) || null,
      segments: Array.isArray(audio.segments) ? audio.segments : [],
      contentClass: audio.contentClass || (summary && summary.contentClass) || null,
      changes: Array.isArray(audio.changes) ? audio.changes : [],
      changeSummary: audio.changeSummary || null,
      duration: summary ? summary.duration : null,
      f0Median: summary ? summary.f0Median : null,
      voicedRatio: summary ? summary.voicedRatio : null,
      singingLike: audio.singingLike || (summary && summary.singingLike) || null,
      musicLike: audio.musicLike || (summary && summary.musicLike) || null,
    } : null,
    // 画面侧
    video: videoReport ? {
      report: videoReport.slice(0, 12000),
      reportTruncated: videoReport.length > 12000,
      reportPath: path.join(job.outDir, 'video', 'report.md'),
    } : null,
    outDir: job.outDir,
    log: job.log.slice(-20),
    error: job.error || null,
    note: job.status === 'done' ? null : '分析仍在运行；用 toolbox_job({ id }) 查询。',
  }
}

const analyzeTool = {
  name: 'toolbox_analyze',
  description:
    '一站式分析一个视频或音频文件：同时做画面（逐帧观看 + 摘要）和声音（转写 + 韵律 + 变化点 + 说话人），最后给一份合并结果。'
    + '适合「这个视频讲了什么、什么语气、哪里变了」这类一次问全的需求，不用分别调视频和音频工具。'
    + 'source 支持本地路径、file:// 或直链；B 站链接请用 video_summary（它有下载和视频元信息）。'
    + '两条流水线并行跑，声音通常更快出结果。'
    + '可以用 only 指定只做画面或只做声音。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '本地文件路径、file:// 或直链。' },
      only: {
        type: 'string',
        enum: ['both', 'video', 'audio'],
        description: '只做哪一路，默认 both。',
      },
      model: { type: 'string', enum: ['qwen3.5:4b'], description: '本地视觉模型。' },
      start: { oneOf: [{ type: 'string' }, { type: 'number' }], description: '只看这一段：起点。' },
      end: { oneOf: [{ type: 'string' }, { type: 'number' }], description: '只看这一段：终点。' },
      duration: { oneOf: [{ type: 'string' }, { type: 'number' }], description: '只看这一段：长度。' },
      maxSheets: { type: 'integer', minimum: 1, maximum: 500, description: '画面最多拼图张数，默认 12。想看得更全就调大——本机不怕慢的话给 100 也不过分。' },
      interval: { type: 'number', minimum: 0.05, maximum: 3600, description: '抽帧间隔秒数。给了就严格按它走（不再被 1 秒下限夹住），0.5 表示每半秒看一帧。' },
      minInterval: { type: 'number', minimum: 0.05, maximum: 60, description: '自动规划时的间隔下限，默认取配置（1.0）。配合 density:"max" 用。' },
      density: { type: 'string', enum: ['budget', 'max', 'smart'], description: 'budget=在 maxSheets 预算内均匀铺满（默认）；max=不管预算，抽到 minInterval 那么密。本机不在意时间就选 max。' },
      framesPerSheet: { type: 'integer', minimum: 1, maximum: 12, description: '每张拼图放几帧，默认 4。9 能一屏看更多但每格更小。' },
      perRow: { type: 'integer', minimum: 1, maximum: 4, description: '拼图每行几格，默认 2。' },
      sheetWidth: { type: 'integer', minimum: 256, maximum: 2400, description: '拼图总宽，默认取配置（1000）。单格宽 = 这个值 ÷ perRow。' },
      frameWidth: { type: 'integer', minimum: 256, maximum: 2400, description: '单帧缩放后的宽度，默认取配置（1000）。' },
      height: { type: 'integer', minimum: 120, maximum: 2160, description: '本地文件不用下载，此项无意义；直链时控制下载短边上限。' },
      concurrency: { type: 'integer', minimum: 1, maximum: 8, description: '画面并发数，默认 1。' },
      summary: { type: 'boolean', description: '画面是否让模型写摘要，默认 true。' },
      waitSeconds: { type: 'integer', minimum: 30, maximum: 3600, description: '最多等多少秒，默认 900。' },
    },
    required: ['source'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        analyzeId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        source: { type: 'string' },
        audio: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        video: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        outDir: { type: 'string' },
        log: { type: 'array' },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    render: (_args, value) => {
      if (!value) return [{ type: 'text', text: '没有结果' }]
      if (!value.ok) {
        return [{ type: 'text', text: '分析未完成（' + String(value.status || '') + '）：' + String(value.error || value.note || '') }]
      }
      const lines = ['分析完成：' + (path.basename(value.source) || value.analyzeId)]
      const a = value.audio
      if (a) {
        lines.push('')
        lines.push('【声音】')
        if (a.duration) lines.push('  时长 ' + Number(a.duration).toFixed(1) + ' 秒')
        if (a.transcript) lines.push('  文本：' + String(a.transcript).slice(0, 200))
        if (a.contentClass && a.contentClass.kind !== 'speech') {
          lines.push('  ⚠ ' + a.contentClass.kind + '：' + (a.contentClass.note || ''))
        }
        if (a.changeSummary && a.changeSummary.count > 0) {
          lines.push('  ' + a.changeSummary.note)
          for (const c of (a.changes || []).slice(0, 4)) lines.push('    ' + c.at.toFixed(2) + 's ' + c.note)
        }
      }
      const v = value.video
      if (v && v.report) {
        lines.push('')
        lines.push('【画面】')
        const body = v.report.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 8)
        for (const l of body) lines.push('  ' + l.replace(/^[-*]\s+/, '').slice(0, 100))
      }
      lines.push('')
      lines.push('输出：' + value.outDir)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    const raw = String((args && args.source) || '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!raw) throw new Error('toolbox_analyze: 需要 source（本地路径或直链）')
    const parsed = normalizeSource(raw)
    if (!parsed) throw new Error('toolbox_analyze: 无法识别的来源：' + raw)
    if (parsed.kind === 'local' && !existsSync(parsed.path)) {
      throw new Error('toolbox_analyze: 找不到文件 ' + parsed.path)
    }
    if (parsed.kind === 'url' && /bilibili\.com|b23\.tv/i.test(parsed.url)) {
      throw new Error('toolbox_analyze: B 站链接请用 video_summary（它有下载和视频元信息）；' +
        '本工具用于本地文件或直链')
    }
    const running = activeAnalyze()
    if (running) throw new Error('toolbox_analyze: 已有分析在跑（' + running.id + '），请用 toolbox_job 查询')

    const only = String((args && args.only) || 'both')
    const job = startAnalyze(parsed.kind === 'local' ? parsed.path : parsed.url, {
      video: only !== 'audio',
      audio: only !== 'video',
      model: args && args.model,
      summary: !(args && args.summary === false),
      start: args && args.start,
      end: args && args.end,
      duration: args && args.duration,
      maxSheets: args && args.maxSheets,
      interval: args && args.interval,
      minInterval: args && args.minInterval,
      density: args && args.density,
      framesPerSheet: args && args.framesPerSheet,
      perRow: args && args.perRow,
      sheetWidth: args && args.sheetWidth,
      frameWidth: args && args.frameWidth,
      height: args && args.height,
      numCtx: args && args.numCtx,
      numPredict: args && args.numPredict,
      timeoutSec: args && args.timeoutSec,
      concurrency: args && args.concurrency,
    })
    const waitSeconds = Math.max(30, Math.min(3600, Number(args && args.waitSeconds) || 900))
    const finished = await waitForAnalyze(job, waitSeconds * 1000)
    return analyzeToolResult(finished)
  },
}

const toolboxJobTool = {
  name: 'toolbox_job',
  description:
    '查任意一个工具箱任务的进度或结果。给 id 就行，自动判断是视频分析、截取、韵律、批量、聚类、说话人分离还是评测。'
    + '合并了原来 7 个 _status 工具（video_summary_status / media_clip_status / prosody_status / '
    + 'prosody_batch_status / speaker_cluster_status / speaker_diarize_status / toolbox_benchmark_status）。'
    + '正在跑的任务返回进度和日志；已完成返回结果。'
    + '另外可以用 list: true 列出最近的任务。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（任何类型的都行）。' },
      includeDetail: {
        type: 'boolean',
        description: '是否带完整细节（视频的完整报告、韵律的逐帧曲线），默认 true。',
      },
      list: { type: 'boolean', description: 'true 时列出最近的任务，不需要 id。' },
      kind: {
        type: 'string',
        enum: ['video', 'clip', 'prosody', 'batch', 'cluster', 'diarize', 'bench', 'analyze'],
        description: '和 list 一起用，只列某一类。',
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'list 时最多列几条，默认 20。' },
    },
    required: [],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        kind: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        status: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        progress: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        jobs: { type: 'array' },
        result: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    render: (_args, value) => {
      if (!value) return [{ type: 'text', text: '没有结果' }]
      if (Array.isArray(value.jobs)) {
        if (!value.jobs.length) return [{ type: 'text', text: '没有任务' }]
        const lines = ['最近 ' + value.jobs.length + ' 个任务：']
        for (const j of value.jobs) {
          lines.push('  ' + (j.kind || '?') + '  ' + j.id + '  ' + (j.status || '') + (j.stage ? ' · ' + j.stage : ''))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
      if (!value.ok) {
        return [{ type: 'text', text: '任务 ' + (value.id || '') + '（' + (value.kind || '?') + '）未完成：' + String(value.error || value.note || '') }]
      }
      const p = value.progress
      const parts = [value.kind + ' 任务 ' + value.id, String(value.status || '')]
      if (p && p.total) parts.push(p.done + '/' + p.total)
      if (value.stage) parts.push(value.stage)
      return [{ type: 'text', text: parts.join(' · ') }]
    },
  },
  async execute(args) {
    const wantList = Boolean(args && args.list)
    if (wantList) {
      const limit = Math.max(1, Math.min(100, Number(args && args.limit) || 20))
      const onlyKind = args && args.kind ? String(args.kind) : null
      const rows = []
      for (const item of JOB_KINDS) {
        if (onlyKind && item.kind !== onlyKind) continue
        let map
        try {
          map = item.map()
        } catch {
          continue
        }
        if (!map || typeof map.values !== 'function') continue
        for (const job of map.values()) {
          let pub
          try {
            pub = item.public(job)
          } catch {
            continue
          }
          rows.push({
            kind: item.kind,
            id: pub.id,
            status: pub.status,
            stage: pub.stage || null,
            createdAt: pub.createdAt || 0,
          })
        }
      }
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return { ok: true, jobs: rows.slice(0, limit), kind: onlyKind, id: null, status: null, stage: null, progress: null, result: null, error: null, note: null }
    }

    const id = String((args && args.id) || '').trim()
    if (!id) throw new Error('toolbox_job: 需要 id，或者传 list: true 列任务')
    const found = findJobAnyKind(id)
    if (!found) throw new Error('toolbox_job: 找不到任务 ' + id + '（任何类型都没有这个 id）')

    const includeDetail = !(args && args.includeDetail === false)
    let detail = null
    try {
      detail = found.spec.result(found.job, includeDetail)
    } catch (err) {
      detail = null
    }

    const pub = found.source === 'memory'
      ? (() => {
          try {
            return found.spec.public(found.job)
          } catch {
            return null
          }
        })()
      : found.job

    return {
      ok: Boolean(pub && (pub.status === 'done')),
      kind: found.kind,
      id,
      status: pub ? pub.status : null,
      stage: pub ? pub.stage : null,
      progress: pub && pub.progress ? pub.progress : null,
      result: detail,
      error: pub ? (pub.error || null) : null,
      note: found.source === 'disk'
        ? '这条是从磁盘读的历史任务，进程重启后内存里没有它'
        : null,
      jobs: null,
    }
  },
}

/**
 * 环境体检（2026-11-27）。
 *
 * 和 health 端点的区别：health 是给页面渲染用的（列原始事实），
 * doctor 是给 agent 用的（说清缺什么会导致什么不可用，以及磁盘占多少）。
 */
const toolboxDoctorTool = {
  name: 'toolbox_doctor',
  description:
    '体检这个插件的运行环境：依赖是否齐全、哪些功能因此不可用、各部分占多少磁盘。'
    + '遇到「找不到 ffmpeg」「模型不可用」「磁盘满了」这类问题，先调它，不用让用户去翻页面底部。'
    + '返回 dependencies（每项是否可用 + 缺了影响什么）、features（每个功能能不能用）、'
    + 'disk（各目录占用）、suggestion（一句话建议，没有问题时为 null）。',
  parameters: { type: 'object', properties: {} },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        dependencies: { type: 'object' },
        features: { type: 'object' },
        disk: { type: 'object' },
        diskTotalMB: { type: 'number' },
        suggestion: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        paths: { type: 'object' }
      }
    },
    render: (_args, v) => {
      if (!v || !v.ok) return [{ type: 'text', text: '体检失败：' + String((v && v.error) || '') }]
      const lines = []
      const deps = v.dependencies || {}
      const missing = Object.keys(deps).filter((k) => !deps[k].ok)
      if (missing.length === 0) {
        lines.push('依赖齐全')
      } else {
        lines.push('缺 ' + missing.length + ' 项依赖：')
        for (const k of missing) {
          lines.push('  · ' + deps[k].label + ' — ' + (deps[k].blocks || []).join('、') + ' 不可用')
          if (deps[k].fix) lines.push('    装法：' + deps[k].fix)
        }
      }
      const feats = v.features || {}
      const off = Object.keys(feats).filter((k) => !feats[k])
      if (off.length) {
        lines.push('')
        lines.push('不可用的功能：' + off.join('、'))
      }
      if (v.disk && Object.keys(v.disk).length) {
        lines.push('')
        lines.push('磁盘占用（合计 ' + Math.round(v.diskTotalMB || 0) + ' MB）：')
        for (const k of Object.keys(v.disk)) {
          const mb = v.disk[k]
          if (mb >= 1) lines.push('  ' + k + ': ' + Math.round(mb) + ' MB')
        }
      }
      if (v.suggestion) {
        lines.push('')
        lines.push('建议：' + v.suggestion)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute() {
    const h = await collectHealth()

    // ---------------------------------------------------------------- 依赖
    const dependencies = {
      ffmpeg: {
        ok: Boolean(h.ffmpegExists),
        label: 'ffmpeg',
        value: h.ffmpeg,
        blocks: ['视频逐帧观看', '片段截取', '韵律分析', '一站式分析'],
        fix: 'choco install ffmpeg  或  winget install Gyan.FFmpeg'
      },
      python: {
        ok: Boolean(h.pythonExists),
        label: 'Python 运行时',
        value: h.python,
        blocks: ['韵律分析', '批量导入', '声纹比对', '说话人聚类/分离', '特征评测'],
        fix: '通常随 DSH 自带；确认 DSH 安装完整'
      },
      librosa: (() => {
        const p = probePythonDeps()
        const lib = p.librosa || { ok: false, err: '未探测' }
        return {
          ok: Boolean(lib.ok),
          label: 'librosa',
          value: lib.ok ? '可 import' : (lib.err || null),
          blocks: ['韵律分析', '批量导入'],
          fix: 'pip install librosa soundfile scipy numpy'
        }
      })(),
      ytdlp: {
        ok: Boolean(h.ytdlpExists),
        label: 'yt-dlp',
        value: h.ytdlp,
        blocks: ['B 站链接下载'],
        fix: 'pip install -U yt-dlp'
      },
      ollama: {
        ok: Boolean(h.ollamaOK),
        label: 'Ollama',
        value: h.ollama,
        blocks: ['视频逐帧观看'],
        fix: 'winget install Ollama.Ollama'
      },
      visionModel: {
        ok: Array.isArray(h.models) && h.models.length > 0,
        label: '视觉模型',
        value: (h.models || []).slice(0, 3).join(', ') || null,
        blocks: ['视频逐帧观看'],
        fix: 'ollama pull qwen3.5:4b'
      },
      resemblyzer: {
        ok: Boolean(h.speakerModelAvailable),
        label: '声纹模型',
        value: h.speakerModelAvailable ? '可用' : null,
        blocks: ['声纹比对', '说话人聚类/分离'],
        fix: 'pip install resemblyzer webrtcvad-wheels'
      }
    }

    // ---------------------------------------------------------------- 功能
    const features = {
      '视频逐帧观看': Boolean(h.ffmpegExists) && Boolean(h.ytdlpExists) && Boolean(h.ollamaOK),
      '片段截取': Boolean(h.ffmpegExists),
      '韵律分析': Boolean(h.ffmpegExists) && Boolean(h.pythonExists),
      '批量导入': Boolean(h.ffmpegExists) && Boolean(h.pythonExists),
      '声纹比对': Boolean(h.pythonExists) && Boolean(h.speakerModelAvailable),
      '说话人聚类/分离': Boolean(h.pythonExists) && Boolean(h.speakerModelAvailable),
      '特征评测': Boolean(h.pythonExists)
    }

    // ---------------------------------------------------------------- 磁盘
    const roots = {
      runs: h.workRoot,
      clips: h.clipRoot,
      prosody: h.prosodyRoot,
      batches: h.batchRoot,
      clusters: h.clusterRoot,
      diarize: h.diarizeRoot,
      bench: h.benchRoot,
      cache: VIDEO_CACHE_ROOT
    }
    const disk = {}
    let diskTotalMB = 0
    for (const [k, p] of Object.entries(roots)) {
      if (!p) continue
      try {
        if (!existsSync(p)) continue
        const mb = dirSize(p) / (1024 * 1024)
        disk[k] = Math.round(mb * 10) / 10
        diskTotalMB += mb
      } catch {
        /* 目录不存在或没权限 */
      }
    }
    diskTotalMB = Math.round(diskTotalMB)

    // ---------------------------------------------------------------- 建议
    let suggestion = null
    const missingDeps = Object.keys(dependencies).filter((k) => !dependencies[k].ok)
    if (missingDeps.includes('ffmpeg')) {
      suggestion = '先装 ffmpeg——没有它所有音视频功能都用不了。'
    } else if (missingDeps.includes('python')) {
      suggestion = 'Python 运行时不可用，DSH 安装可能不完整。'
    } else if (missingDeps.includes('ollama') || missingDeps.includes('visionModel')) {
      suggestion = '视频逐帧观看需要 Ollama + 视觉模型；其他功能不受影响。'
    } else if (missingDeps.includes('ytdlp')) {
      suggestion = '没有 yt-dlp，只能处理本地文件，B 站链接不可用。'
    } else if (missingDeps.includes('resemblyzer')) {
      suggestion = '声纹相关功能需要 resemblyzer；韵律和截取不受影响。'
    } else if (disk.cache && disk.cache > 2048) {
      suggestion = '下载缓存已占 ' + Math.round(disk.cache) + ' MB，'
        + '可以用 toolbox_cache_clean({ kind: "cache" }) 清理。'
    } else if (diskTotalMB > 10240) {
      suggestion = '中间产物累计超过 10 GB，'
        + '可以用 toolbox_cache_clean({ kind: "all", maxAgeDays: 7 }) 清掉 7 天前的。'
    }

    return {
      ok: true,
      dependencies,
      features,
      disk,
      diskTotalMB,
      suggestion,
      paths: {
        toolboxHome: h.toolboxHome,
        labelFile: h.labelFile,
        cache: VIDEO_CACHE_ROOT
      }
    }
  }
}

const cacheCleanTool = {
  name: 'toolbox_cache_clean',
  description:
    '清理工具箱的中间产物。视频分析只保留报告/摘要/拼图，删掉下载的源视频和抽出的帧；'
    + '截取保留成品片段，删掉下载的源素材；韵律分析保留 prosody.json，删掉解码出来的 wav。'
    + '默认只清中间产物；all=true 连任务目录一起删（includeOutputs=true 时连成品片段也删）。'
    + 'maxAgeDays 可以只清多少天以前的。返回释放的字节数。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['all', 'runs', 'clips', 'prosody', 'analyze', 'batches', 'clusters', 'diarize', 'bench', 'cache'],
        description: '清哪一类，默认 all。'
      },
      all: { type: 'boolean', description: '连任务目录一起删，默认只清中间产物。' },
      includeOutputs: { type: 'boolean', description: 'all=true 时是否连成品片段（mp4/mp3）也删，默认 false。' },
      maxAgeDays: { type: 'number', description: '只清多少天以前的，默认全部。' }
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        freedBytes: { type: 'number' },
        touched: { type: 'number' },
        removedJobs: { type: 'number' },
        parts: { type: 'array' }
      }
    },
    render: (_args, value) => [{
      type: 'text',
      text: '已清理，释放 ' + Math.max(1, Math.round(((value && value.freedBytes) || 0) / 1024)) + ' KB'
        + (value && value.removedJobs ? '，删除 ' + value.removedJobs + ' 个任务' : '')
    }]
  },
  async execute(args) {
    const kind = String((args && args.kind) || 'all')
    const options = {
      all: args && args.all === true,
      includeOutputs: args && args.includeOutputs === true,
      maxAgeDays: Number(args && args.maxAgeDays) || 0
    }
    return kind === 'all' ? cleanAll(options) : cleanKind(kind, options)
  }
}

const videoSummaryTool = {
  name: 'video_summary',
  description:
    '用本机 Ollama 视觉模型逐帧观看并总结一条 B 站视频：下载最高可用清晰度、抽帧、拼成带时间戳的拼图，再逐张识别，最后返回摘要与报告路径。'
    + '适合用户说「总结/看看这条 B 站视频」。默认 maxSheets=12（覆盖 12 个时间段），单张约 50–70 秒。'
    + '抽帧密度可调：想看得更细就给 interval（比如 0.5 秒一帧）、maxSheets 调大（上限 500）、或 density:"max"。'
    + '本机不在意时间成本时，interval:0.5 + maxSheets:100 能把一部长片逐半秒看一遍。'
    + '若返回 status=running，用 toolbox_job({ id }) 带 jobId 查询，不要重复启动。'
    + 'height 控制下载分辨率（短边，默认 1080）。'
    + '推荐 qwen3.5:4b；qwen3-vl:4b 在这台机器上会返回空内容，不要用。',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'B 站视频链接或 BV 号。'
      },
      model: {
        type: 'string',
        enum: ['qwen3.5:4b'],
        description: '本地视觉模型；目前只支持推荐的 qwen3.5:4b。'
      },
      maxSheets: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: '最多拼图张数，默认 12。越大覆盖越细，耗时越长。本机不怕慢可以给到 100 以上。'
      },
      interval: {
        type: 'number',
        minimum: 0.05,
        maximum: 3600,
        description: '抽帧间隔秒数。给了就严格按它走（不再有 1 秒下限）。0.5 = 每半秒一帧，1 = 每秒一帧。不填则按时长和 maxSheets 自动算。'
      },
      minInterval: {
        type: 'number',
        minimum: 0.05,
        maximum: 60,
        description: '自动规划时的间隔下限，默认取配置（1.0）。配合 density:"max" 决定抽多密。'
      },
      density: {
        type: 'string',
        enum: ['budget', 'max', 'smart'],
        description: 'budget=在 maxSheets 预算内均匀铺满（默认，快）；max=不管预算，按 minInterval 抽到最密（细，慢）。'
      },
      framesPerSheet: {
        type: 'integer',
        minimum: 1,
        maximum: 12,
        description: '每张拼图放几帧，默认 4。9 能一屏看更多但每格更小。'
      },
      perRow: {
        type: 'integer',
        minimum: 1,
        maximum: 4,
        description: '拼图每行几格，默认 2。'
      },
      numCtx: {
        type: 'integer',
        minimum: 1024,
        maximum: 131072,
        description: '模型上下文长度，默认取配置（8192）。图大时调大能减少截断。'
      },
      numPredict: {
        type: 'integer',
        minimum: 100,
        maximum: 8192,
        description: '单张拼图最多生成多少 token，默认取配置（600）。'
      },
      timeoutSec: {
        type: 'integer',
        minimum: 30,
        maximum: 3600,
        description: '单次模型调用超时秒数，默认取配置（600）。'
      },
      sheetWidth: {
        type: 'integer',
        minimum: 256,
        maximum: 2400,
        description: '拼图总宽，默认取配置（1000）。单格宽 = 这个值 ÷ perRow。直接决定模型能读出多少字。'
      },
      frameWidth: {
        type: 'integer',
        minimum: 256,
        maximum: 2400,
        description: '单帧缩放后的宽度，默认取配置（1000）。'
      },
      summary: {
        type: 'boolean',
        description: '是否额外让模型写一段摘要，默认 true。'
      },
      includeReport: {
        type: 'boolean',
        description: '是否在返回值里带完整逐格报告（最多 12000 字），默认 true。'
      },
      waitSeconds: {
        type: 'integer',
        minimum: 30,
        maximum: 14400,
        description: '本次工具调用最多等待多少秒；超时返回 running 和 jobId。默认 900，细抽帧时可以给到 3600 以上。'
      },
      height: {
        type: 'integer',
        minimum: 120,
        maximum: 2160,
        description: '下载分辨率上限（短边），默认 1080。竖屏片也适用——判据是短边而不是 height。'
      },
      start: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: '只看这一段：起始时间。支持 "90"、"1:30"、"0:01:30" 三种写法。给了 start 就不再看整条。'
      },
      end: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: '只看这一段：结束时间（和 start 配对）。和 duration 二选一。'
      },
      duration: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: '只看这一段：长度（和 start 配对）。和 end 二选一。'
      },
      concurrency: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        description: '同时分析几张拼图，默认 1（串行）。'
          + '只在显卡够大、模型能全部进显存时调大才有意义（2-3 通常最快）；'
          + '模型只能部分进显存（GPU/CPU 混合）时，并发会让推理互相争抢，可能比串行还慢。'
      }
    },
    required: ['url']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        jobId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        requestedRange: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        watchedRange: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        uploader: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        videoDescription: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        summaryIsModelGenerated: { type: 'boolean' },
        summaryCaveat: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        unstableOcr: { type: 'array' },
        sheets: { type: 'number' },
        analyzed: { type: 'number' },
        total: { type: 'number' },
        summary: { type: 'string' },
        report: { type: 'string' },
        reportTruncated: { type: 'boolean' },
        outDir: { type: 'string' },
        reportPath: { type: 'string' },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        progress: { type: 'object' },
        note: { type: 'string' },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => {
      if (!value || !value.ok) {
        return [{ type: 'text', text: '视频总结未完成（' + String((value && value.status) || '') + '）：' + String((value && (value.error || value.note)) || '') }]
      }
      const lines = [
        '视频总结完成：' + (value.title || value.jobId) + ' · ' + value.analyzed + '/' + value.total + ' 张拼图'
      ]
      if (value.uploader) lines.push('UP 主：' + value.uploader)
      // 只看了某一段必须写在前面，否则会以为整条都看过了
      if (value.watchedRange) {
        lines.push('')
        lines.push('⚠ 只看了 ' + value.watchedRange + ' 这一段，不是整条视频')
      }
      // OCR 不稳定：必须在摘要前面说，否则读者会先信了摘要里的人名
      if (value.unstableOcr && value.unstableOcr.length) {
        lines.push('')
        lines.push('⚠ 画面文字 OCR 不稳定（同一处被读成多种写法，真实内容可能都不是）：')
        for (const u of value.unstableOcr.slice(0, 5)) lines.push('  ' + u)
      }
      if (value.summary) {
        lines.push('')
        lines.push('摘要（模型生成，仅供参考）：')
        lines.push(String(value.summary).slice(0, 600))
      }
      if (value.summaryCaveat) {
        lines.push('')
        lines.push('⚠ ' + value.summaryCaveat)
      }
      lines.push('')
      lines.push('输出：' + value.outDir)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const input = normalizeInput(args && args.url)
    if (!input) throw new Error('video_summary: 需要一个 B 站视频链接或 BV 号')
    if (!isAllowedHost(input)) throw new Error('video_summary: 目前只支持 bilibili.com / b23.tv 的链接')
    const running = activeJob()
    if (running) throw new Error('video_summary: 已有任务在运行（' + running.id + '），请用 toolbox_job({ id }) 查询')
    // 慢模型（qwen3-vl:4b）在这台机器上返回空内容——按 SLOW_MODELS 名单拦，
    // 不再拿模型名和某个常量比相等（那个常量为 null，永远比不中）。
    const model = String(resolveModel(args && args.model))
    if (SLOW_MODELS().has(model)) {
      throw new Error('video_summary: ' + model + ' 在显存不足的机器上会返回空内容；请改用 ' + FALLBACK_MODEL
        + '（或在配置里把 model.name 改回去）')
    }
    const sheetCap = Number(cfg('video', 'maxSheetsHardCap', 200)) || 200
    const wantSheets = Math.max(1, Number(args && args.maxSheets) || 12)
    const maxSheets = Math.max(1, Math.min(sheetCap, wantSheets))
    // schema 允许到 500，但实际被 maxSheetsHardCap 夹住。用户传 300 会变 200，
    // 之前完全静默——现在记下来，回执里说明。
    const maxSheetsCapped = wantSheets > sheetCap
    const interval = Number(args && args.interval)
    const waitSeconds = Math.max(30, Math.min(14400, Number(args && args.waitSeconds) || 900))
    const includeReport = !(args && args.includeReport === false)
    if (Number.isFinite(interval) && interval > 0 && interval < 0.05) {
      throw new Error('video_summary: interval 最小 0.05 秒（ffmpeg 抽帧的实用下限）')
    }
    const start = args && args.start !== undefined && String(args.start).trim() !== '' ? args.start : undefined
    const end = args && args.end !== undefined && String(args.end).trim() !== '' ? args.end : undefined
    const segDuration = args && args.duration !== undefined && String(args.duration).trim() !== '' ? args.duration : undefined
    if (end !== undefined && segDuration !== undefined) {
      throw new Error('video_summary: end 和 duration 只能给一个')
    }
    const job = startJob(input, {
      maxSheetsCapped,
      wantSheets,
      effectiveMaxSheets: maxSheets,
      model,
      summary: !(args && args.summary === false),
      maxSheets,
      interval: Number.isFinite(interval) && interval > 0 ? interval : undefined,
      minInterval: Number(args && args.minInterval) || undefined,
      density: args && args.density === 'max' ? 'max' : undefined,
      framesPerSheet: Number(args && args.framesPerSheet) || undefined,
      perRow: Number(args && args.perRow) || undefined,
      sheetWidth: Number(args && args.sheetWidth) || undefined,
      frameWidth: Number(args && args.frameWidth) || undefined,
      height: Number(args && args.height) || undefined,
      numCtx: Number(args && args.numCtx) || undefined,
      numPredict: Number(args && args.numPredict) || undefined,
      timeoutSec: Number(args && args.timeoutSec) || undefined,
      concurrency: Number(args && args.concurrency) || 1,
      start,
      end,
      duration: segDuration
    })
    // 记下本次请求的时间段，回执里要说明"只看了这一段"
    job.requestedRange = (start !== undefined || end !== undefined || segDuration !== undefined)
      ? { start: start ?? null, end: end ?? null, duration: segDuration ?? null }
      : null
    const finished = await waitForJob(job, waitSeconds * 1000)
    if (finished.status === 'done' || finished.status === 'error') {
      return finishedToolResult(finished, includeReport)
    }
    return runningToolResult(finished)
  }
}


// ---------------------------------------------------------------------------
// 片段截取：本地文件 / 直链 / B 站链接 → 截取指定起始与长度的片段
// ---------------------------------------------------------------------------

const CLIP_ROOT = process.env.XIYOUNG_CLIP_ROOT || path.join(TOOLBOX_HOME, 'clips')
const MAX_CLIP_SECONDS = 3600
const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.ts', '.m4v', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma'])

/** @type {Map<string, any>} */
const clips = new Map()

const FFPROBE = findCommand('ffprobe', [path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin')])

function normalizeSource(raw) {
  const text = String(raw || '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!text) return null
  if (/^file:\/\//i.test(text)) {
    try {
      return { kind: 'local', path: fileURLToPath(text) }
    } catch {
      return null
    }
  }
  if (text.startsWith('~')) return { kind: 'local', path: path.join(homedir(), text.slice(1)) }
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')) {
    return { kind: 'local', path: text }
  }
  if (/^BV[0-9A-Za-z]+$/.test(text)) return { kind: 'url', url: 'https://www.bilibili.com/video/' + text }
  try {
    const url = new URL(text)
    if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'url', url: url.toString() }
  } catch {
    /* not a URL */
  }
  try {
    const resolved = path.resolve(text)
    if (existsSync(resolved)) return { kind: 'local', path: resolved }
  } catch {
    /* unresolvable */
  }
  return null
}

function parseSeconds(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(':').map((piece) => piece.trim())
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((piece) => Number(piece))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  return parts.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1]
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return (hh > 0 ? pad(hh) + ':' : '') + pad(mm) + ':' + pad(ss)
}

/** 同步探测时长（毫秒级，用于参数校验）。探测失败返回 0。 */
function probeDurationSync(file) {
  if (!FFPROBE) return 0
  try {
    const res = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file], { timeout: 15000, windowsHide: true, encoding: 'utf8' })
    if (res.status !== 0) return 0
    const value = Number(String(res.stdout || '').trim())
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function probeMedia(file) {
  return new Promise((resolve) => {
    if (!FFPROBE) return resolve(null)
    let out = ''
    let child
    try {
      child = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
    } catch {
      return resolve(null)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      try {
        const data = JSON.parse(out || '{}')
        const streams = Array.isArray(data.streams) ? data.streams : []
        const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
        const audio = streams.find((s) => s.codec_type === 'audio')
        resolve({
          duration: Number(data.format && data.format.duration) || 0,
          size: Number(data.format && data.format.size) || 0,
          formatName: (data.format && data.format.format_name) || '',
          hasVideo: Boolean(video),
          hasAudio: Boolean(audio),
          width: video ? Number(video.width) || 0 : 0,
          height: video ? Number(video.height) || 0 : 0,
          videoCodec: video ? String(video.codec_name || '') : '',
          audioCodec: audio ? String(audio.codec_name || '') : ''
        })
      } catch {
        resolve(null)
      }
    })
  })
}

function runProcess(command, args, onLine, options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      // ⚠️ 必须显式传 env，否则子进程拿不到 PYTHONIOENCODING。
      // 踩过的坑（2026-11-26）：这里原来只传 windowsHide 和 cwd，
      // python 在 Windows 上就按默认的 GBK 写 stdout/stderr，
      // Node 端 setEncoding('utf8') 去解 GBK 字节 → 中文全成乱码。
      // 表现是「数字能读、文字全废」，因为数字是 ASCII 不受影响。
      //
      // 所有 python 任务（video/prosody/clip/batch/cluster/diarize/bench）
      // 都走 pythonEnv()，那里有 PYTHONIOENCODING=utf-8；只有 runProcess
      // 这条路径（speaker_compare 在用）漏了。现在补上。
      child = spawn(command, args, {
        windowsHide: true,
        cwd: options.cwd,
        env: options.env || pythonEnv(),
      })
    } catch (error) {
      resolve({ code: -1, error: String(error && error.message ? error.message : error) })
      return
    }
    if (options.onChild) options.onChild(child)
    let tail = ''
    const handle = (chunk) => {
      const text = String(chunk).replace(/\r/g, '')
      tail = (tail + text).slice(-4000)
      if (onLine) onLine(text)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('error', (error) => resolve({ code: -1, error: String(error && error.message ? error.message : error), tail }))
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, tail }))
  })
}

function appendClipLog(clip, chunk) {
  pumpLog(clip, chunk, {
    onLine(text) {
      if (text.startsWith('[clip]')) {
        const stage = text.replace(/^\[clip\]\s*/, '')
        if (stage) clip.stage = stage
      }
    },
  })
}

function publicClip(clip) {
  return {
    id: clip.id,
    kind: 'clip',
    source: clip.source,
    sourceKind: clip.sourceKind,
    status: clip.status,
    stage: clip.stage || null,
    createdAt: clip.createdAt,
    endedAt: clip.endedAt || null,
    error: clip.error || null,
    start: clip.start,
    duration: clip.duration,
    mode: clip.mode,
    outputPath: clip.outputPath || null,
    outputName: clip.outputName || null,
    outputBytes: clip.outputBytes || 0,
    media: clip.media || null,
    analyze: clip.analyze !== false,
    prosodyId: clip.prosodyId || null,
    log: clip.log.slice(-160)
  }
}

function writeClipMeta(clip) {
  try {
    writeFileSync(path.join(clip.outDir, 'clip.json'), JSON.stringify(publicClip(clip), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function activeClip() {
  return [...clips.values()].find((clip) => clip.status === 'running' || clip.status === 'queued')
}

function safeFileName(raw) {
  const base = String(raw || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '')
  return base.slice(0, 80)
}

function startClip(options) {
  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(CLIP_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  let logStream = null
  try {
    logStream = createWriteStream(path.join(outDir, 'clip.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const clip = {
    id,
    kind: 'clip',
    source: options.source,
    sourceKind: options.sourceKind,
    sourceUrl: options.sourceUrl || null,
    localPath: options.localPath || null,
    start: options.start,
    duration: options.duration,
    mode: options.mode,
    name: options.name || null,
    analyze: options.analyze !== false,
    prosodyId: null,
    outDir,
    status: 'queued',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    log: [],
    outputPath: null,
    outputName: null,
    outputBytes: 0,
    media: null,
    child: null,
    logStream,
    finalized: false
  }
  clips.set(id, clip)
  pruneMap(clips)
  writeClipMeta(clip)

  clip.status = 'running'
  void runClipJob(clip).catch((error) => {
    clip.error = String(error && error.message ? error.message : error)
    finishClip(clip)
  })
  return clip
}

async function runClipJob(clip) {
  appendClipLog(clip, '[clip] 准备素材')
  writeClipMeta(clip)

  let input = clip.localPath
  if (clip.sourceKind === 'url') {
    if (!YTDLP) throw new Error('找不到 yt-dlp，无法下载链接；可以改用本地文件路径')
    appendClipLog(clip, '[clip] 下载链接素材')
    const downloaded = await runProcess(YTDLP, [
      '-f', 'bv*+ba/b',
      '--no-playlist',
      '--no-warnings',
      '-o', path.join(clip.outDir, 'source.%(ext)s'),
      clip.sourceUrl
    ], (chunk) => appendClipLog(clip, chunk), { onChild: (child) => { clip.child = child } })
    if (downloaded.code !== 0) {
      throw new Error('下载失败：' + (downloaded.tail || '').split('\n').filter(Boolean).slice(-3).join(' '))
    }
    const produced = readdirSync(clip.outDir).filter((file) => file.startsWith('source.') && MEDIA_EXT.has(path.extname(file).toLowerCase()))
    if (!produced.length) throw new Error('下载完成但没找到媒体文件')
    input = path.join(clip.outDir, produced[0])
  }

  if (!input || !existsSync(input)) throw new Error('找不到源文件：' + String(clip.source))

  appendClipLog(clip, '[clip] 读取媒体信息')
  const media = await probeMedia(input)
  clip.media = media
  if (!media || (!media.hasVideo && !media.hasAudio)) {
    throw new Error('这个文件里没有可用的音频或视频轨')
  }
  const total = media.duration
  if (!total || total <= 0) throw new Error('读不出时长，可能不是完整的媒体文件')
  if (clip.start >= total) {
    throw new Error('起始时间 ' + formatClock(clip.start) + ' 超过了素材总长 ' + formatClock(total))
  }
  let duration = clip.duration
  if (duration === null || duration === undefined) duration = total - clip.start
  duration = Math.min(duration, total - clip.start, MAX_CLIP_SECONDS)
  if (!(duration > 0.05)) throw new Error('截取长度太短（至少 0.1 秒）')
  clip.duration = Number(duration.toFixed(3))

  const videoMode = media.hasVideo
  const ext = videoMode ? '.mp4' : '.mp3'
  const stem = safeFileName(clip.name) || ('clip_' + formatClock(clip.start).replace(/:/g, '') + '_' + Math.round(clip.duration) + 's')
  const outputName = stem.toLowerCase().endsWith(ext) ? stem : stem + ext
  const outputPath = path.join(clip.outDir, outputName)

  const args = ['-hide_banner', '-y', '-ss', String(clip.start), '-i', input, '-t', String(clip.duration)]
  if (videoMode && clip.mode === 'fast') {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  } else if (videoMode) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
    if (media.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k')
    else args.push('-an')
    args.push('-movflags', '+faststart')
  } else {
    args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k')
  }
  args.push(outputPath)

  appendClipLog(clip, '[clip] 截取 ' + formatClock(clip.start) + ' 起 ' + clip.duration.toFixed(2) + ' 秒（' + (clip.mode === 'fast' && videoMode ? '快速流复制' : '精确重编码') + '）')
  const result = await runProcess(FFMPEG, args, (chunk) => appendClipLog(clip, chunk), { onChild: (child) => { clip.child = child } })
  if (result.code !== 0 || !existsSync(outputPath)) {
    throw new Error('ffmpeg 截取失败：' + (result.tail || '').split('\n').filter(Boolean).slice(-3).join(' '))
  }

  clip.outputPath = outputPath
  clip.outputName = outputName
  try {
    clip.outputBytes = statSync(outputPath).size
  } catch {
    clip.outputBytes = 0
  }
  appendClipLog(clip, '[clip] 完成 ' + outputName + '（' + Math.max(1, Math.round(clip.outputBytes / 1024)) + ' KB）')
  finishClip(clip)

  // 截取完直接分析：一段截出来的音频，最有用的下一步就是看它的韵律。
  if (clip.analyze !== false && clip.status === 'done') {
    try {
      const job = startProsody(clip.outputPath, {})
      clip.prosodyId = job.id
      writeClipMeta(clip)
      appendClipLog(clip, '[clip] 已交给韵律分析：' + job.id)
    } catch (error) {
      appendClipLog(clip, '[clip] 自动分析没能启动：' + String(error && error.message ? error.message : error))
    }
  }
}

function finishClip(clip) {
  if (clip.finalized) return
  clip.finalized = true
  clip.endedAt = Date.now()
  if (clip.outputPath && existsSync(clip.outputPath)) {
    clip.status = 'done'
    clip.stage = '已完成'
  } else {
    clip.status = 'error'
    clip.stage = '失败'
    if (!clip.error) clip.error = '没有生成输出文件'
    appendClipLog(clip, '[clip] ' + clip.error)
  }
  if (clip.logStream) {
    try {
      clip.logStream.end()
    } catch {
      /* closed */
    }
    clip.logStream = null
  }
  writeClipMeta(clip)
}

function loadClips() {
  try {
    const entries = readdirSync(CLIP_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let mtime = 0
        try {
          mtime = statSync(path.join(CLIP_ROOT, entry.name)).mtimeMs
        } catch {
          mtime = 0
        }
        return { name: entry.name, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_JOBS())
    for (const entry of entries) {
      if (clips.has(entry.name)) continue
      const outDir = path.join(CLIP_ROOT, entry.name)
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(path.join(outDir, 'clip.json'), 'utf8'))
      } catch {
        meta = {}
      }
      const outputPath = meta.outputPath || null
      const ok = outputPath && existsSync(outputPath)
      clips.set(entry.name, {
        id: entry.name,
        kind: 'clip',
        source: meta.source || '',
        sourceKind: meta.sourceKind || 'local',
        start: meta.start || 0,
        duration: meta.duration || 0,
        mode: meta.mode || 'precise',
        outDir,
        status: ok ? 'done' : 'error',
        stage: ok ? '已完成' : '失败',
        createdAt: meta.createdAt || entry.mtime,
        endedAt: meta.endedAt || null,
        error: ok ? null : (meta.error || '上次运行被中断'),
        outputPath: ok ? outputPath : null,
        outputName: meta.outputName || (outputPath ? path.basename(outputPath) : null),
        outputBytes: meta.outputBytes || 0,
        media: meta.media || null,
        log: [],
        child: null,
        logStream: null,
        finalized: true
      })
    }
  } catch {
    /* history is best effort */
  }
}

async function waitForClip(clip, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (clip.status === 'done' || clip.status === 'error') return clip
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return clip
}

function clipToolResult(clip) {
  const done = clip.status === 'done'
  return {
    ok: done,
    clipId: clip.id,
    status: clip.status,
    stage: clip.stage || null,
    source: clip.source,
    start: clip.start,
    duration: clip.duration,
    mode: clip.mode,
    outputPath: done ? clip.outputPath : null,
    outputName: done ? clip.outputName : null,
    outputBytes: clip.outputBytes || 0,
    media: clip.media || null,
    error: clip.error || null,
    note: done ? null : '任务仍在后台运行；请调用 toolbox_job({ id }) 查询，不要重复提交。',
    log: clip.log.slice(-15)
  }
}

const mediaClipTool = {
  name: 'media_clip',
  description:
    '从一段视频或音频里截取指定起始与长度的片段。source 可以是本地文件路径（如 D:\\\\media\\\\a.mp4，或 file:///...）、直链，或 B 站链接/BV 号。'
    + 'start 必填，支持秒数或 mm:ss / hh:mm:ss；duration 或 end 二选一（都不给就截到结尾）。'
    + 'mode=precise（默认，重编码、帧级精确）或 fast（流复制、秒级但起点会对齐到关键帧）。'
    + '有视频轨输出 mp4，纯音频输出 mp3。默认最多等 300 秒；超时返回 status=running 和 clipId，用 toolbox_job({ id }) 查。',
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: '本地文件路径、http(s) 直链，或 B 站链接 / BV 号。'
      },
      start: {
        type: 'string',
        description: '起始时间：秒数（如 83.5）或 mm:ss / hh:mm:ss（如 01:23）。'
      },
      duration: {
        type: 'string',
        description: '截取长度：秒数或 mm:ss；与 end 二选一。'
      },
      end: {
        type: 'string',
        description: '结束时间：秒数或 mm:ss / hh:mm:ss；与 duration 二选一。'
      },
      mode: {
        type: 'string',
        enum: ['precise', 'fast'],
        description: 'precise=重编码帧级精确（默认）；fast=流复制，快但起点对齐关键帧。'
      },
      name: {
        type: 'string',
        description: '输出文件名（不含扩展名），默认按起始时间和长度自动命名。'
      },
      waitSeconds: {
        type: 'integer',
        minimum: 10,
        maximum: 1800,
        description: '本次调用最多等多少秒，默认 300。'
      }
    },
    required: ['source', 'start']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        clipId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        source: { type: 'string' },
        start: { type: 'number' },
        duration: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        mode: { type: 'string' },
        outputPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        outputName: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        outputBytes: { type: 'number' },
        media: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => [{
      type: 'text',
      text: value && value.ok
        ? ('已截取：' + value.outputName + '（' + Math.max(1, Math.round((value.outputBytes || 0) / 1024)) + ' KB）\n' + value.outputPath)
        : ('截取未完成（' + (value && value.status) + '）：' + String((value && (value.error || value.note)) || ''))
    }]
  },
  async execute(args) {
    const prepared = prepareClipRequest(args)
    if (prepared.error) throw new Error('media_clip: ' + prepared.error)
    const running = activeClip()
    if (running) throw new Error('media_clip: 已有截取任务在运行（' + running.id + '），请用 toolbox_job({ id }) 查询')
    const waitSeconds = Math.max(10, Math.min(1800, Number(args && args.waitSeconds) || 300))
    const clip = startClip(prepared.options)
    const finished = await waitForClip(clip, waitSeconds * 1000)
    return clipToolResult(finished)
  }
}

function prepareClipRequest(body) {
  const source = normalizeSource(body && body.source)
  if (!source) return { error: '需要一个本地文件路径、直链或 B 站链接' }
  const start = parseSeconds(body.start)
  if (start === null || start < 0) return { error: '起始时间无效，请写秒数或 mm:ss' }
  const mode = body.mode === 'fast' ? 'fast' : 'precise'
  let duration = parseSeconds(body.duration)
  const end = parseSeconds(body.end)
  if (duration === null && end !== null) {
    duration = end - start
    if (duration <= 0) return { error: '结束时间必须大于起始时间' }
  }
  if (duration !== null && !(duration > 0.05)) return { error: '截取长度太短（至少 0.1 秒）' }
  if (duration !== null && duration > MAX_CLIP_SECONDS) return { error: '单次最多截取 ' + (MAX_CLIP_SECONDS / 60) + ' 分钟' }
  if (source.kind === 'local' && !existsSync(source.path)) {
    return { error: '找不到本地文件：' + source.path }
  }
  // start 明显超过素材时提前拦下，别让它跑到 ffmpeg 才失败（那时只能报"截取失败"）
  if (source.kind === 'local' && start > 0) {
    const duration = probeDurationSync(source.path)
    if (duration && start >= duration) {
      return {
        error: '起始时间 ' + formatClock(start) + ' 超过了素材总长 ' + formatClock(duration)
      }
    }
  }
  return {
    options: {
      source: source.kind === 'url' ? source.url : source.path,
      sourceKind: source.kind,
      sourceUrl: source.kind === 'url' ? source.url : null,
      localPath: source.kind === 'local' ? source.path : null,
      start,
      duration,
      mode,
      name: body.name ? String(body.name) : null,
      analyze: body.analyze !== false
    }
  }
}


// ---------------------------------------------------------------------------
// 韵律分析（第二层）：响度 + 基频 + 微颤 + 清浊三分类，全部本机算
// ---------------------------------------------------------------------------

const PROSODY_ROOT = process.env.XIYOUNG_PROSODY_ROOT || path.join(TOOLBOX_HOME, 'prosody')
const PROSODY_SCRIPT = fileURLToPath(new URL('./lib/prosody.py', import.meta.url))

/** @type {Map<string, any>} */
const prosodies = new Map()

function activeProsody() {
  return [...prosodies.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function publicProsody(job) {
  return {
    id: job.id,
    kind: 'prosody',
    source: job.source,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    summary: job.summary || null,
    outDir: job.outDir,
    log: job.log.slice(-120)
  }
}

function writeProsodyMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify(publicProsody(job), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function appendProsodyLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      if (text.startsWith('[prosody]')) job.stage = text.replace(/^\[prosody\]\s*/, '')
    },
  })
}

function startProsody(source, options = {}) {
  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(PROSODY_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  let logStream = null
  try {
    logStream = createWriteStream(path.join(outDir, 'job.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const job = {
    id,
    kind: 'prosody',
    source,
    outDir,
    status: 'running',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    summary: null,
    log: [],
    child: null,
    logStream,
    finalized: false
  }
  prosodies.set(id, job)
  pruneMap(prosodies)
  writeProsodyMeta(job)

  const args = [PROSODY_SCRIPT, source, '--outdir', outDir]
  const start = Number(options.start)
  if (Number.isFinite(start) && start > 0) args.push('--start', String(start))
  const duration = Number(options.duration)
  if (Number.isFinite(duration) && duration > 0) args.push('--duration', String(duration))
  if (options.compare) args.push('--compare', String(options.compare))
  if (options.noSpeaker) args.push('--no-speaker')
  // 基频范围 / 转写语言 / hop：配置里有，但 agent 调用以前改不了。
  // prosody.py 本来就接受 --fmin / --fmax / --lang / --hop，这里只是补上传递。
  const fmin = Number(options.f0Min)
  if (Number.isFinite(fmin) && fmin > 0) args.push('--fmin', String(fmin))
  const fmax = Number(options.f0Max)
  if (Number.isFinite(fmax) && fmax > 0) args.push('--fmax', String(fmax))
  if (options.language) args.push('--lang', String(options.language))
  const hop = Number(options.hop)
  if (Number.isFinite(hop) && hop > 0) args.push('--hop', String(hop))
  if (options.baseline && existsSync(options.baseline)) {
    args.push('--baseline', options.baseline)
  }

  const child = spawn(PYTHON, args, {
    cwd: PROSODY_ROOT,
    env: pythonEnv(Object.assign({}, modelEnvOverrides(options), changesEnvOverrides(options))),
    windowsHide: true
  })
  job.child = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => appendProsodyLog(job, chunk))
  child.stderr.on('data', (chunk) => appendProsodyLog(job, chunk))
  child.on('error', (error) => {
    job.error = String(error && error.message ? error.message : error)
    finishProsody(job)
  })
  child.on('close', (code) => finishProsody(job, code === null ? 1 : code))
  return job
}

function finishProsody(job, code) {
  if (job.finalized) return
  job.finalized = true
  job.endedAt = Date.now()
  const jsonPath = path.join(job.outDir, 'prosody.json')
  try {
    if (existsSync(jsonPath)) {
      const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
      job.summary = data.summary || null
    }
  } catch {
    job.summary = null
  }
  if (job.summary) {
    job.status = 'done'
    job.stage = '已完成'
  } else {
    job.status = 'error'
    job.stage = '失败'
    if (!job.error) {
      const reason = pickErrorLine(job.outDir)
      const tail = tailLog(job.outDir, 2)
      job.error = '没有生成 prosody.json'
        + (reason ? '\n原因：' + reason : '')
        + (tail && tail !== reason ? '\n日志末尾：' + tail : '')
    }
    appendProsodyLog(job, '[prosody] ' + job.error)
  }
  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* closed */
    }
    job.logStream = null
  }
  writeProsodyMeta(job)
}

function loadProsodies() {
  try {
    const entries = readdirSync(PROSODY_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let mtime = 0
        try {
          mtime = statSync(path.join(PROSODY_ROOT, entry.name)).mtimeMs
        } catch {
          mtime = 0
        }
        return { name: entry.name, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_JOBS())
    for (const entry of entries) {
      if (prosodies.has(entry.name)) continue
      const outDir = path.join(PROSODY_ROOT, entry.name)
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(path.join(outDir, 'job.json'), 'utf8'))
      } catch {
        meta = {}
      }
      let summary = null
      try {
        const data = JSON.parse(readFileSync(path.join(outDir, 'prosody.json'), 'utf8'))
        summary = data.summary || null
      } catch {
        summary = null
      }
      prosodies.set(entry.name, {
        id: entry.name,
        kind: 'prosody',
        source: meta.source || '',
        outDir,
        status: summary ? 'done' : 'error',
        stage: summary ? '已完成' : '失败',
        createdAt: meta.createdAt || entry.mtime,
        endedAt: meta.endedAt || null,
        error: summary ? null : (meta.error || '上次运行被中断'),
        summary,
        log: [],
        child: null,
        logStream: null,
        finalized: true
      })
    }
  } catch {
    /* history is best effort */
  }
}

function loadBatches() {
  try {
    const entries = readdirSync(BATCH_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let mtime = 0
        try {
          mtime = statSync(path.join(BATCH_ROOT, entry.name)).mtimeMs
        } catch {
          mtime = 0
        }
        return { name: entry.name, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_JOBS())
    for (const entry of entries) {
      if (batches.has(entry.name)) continue
      const outDir = path.join(BATCH_ROOT, entry.name)
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(path.join(outDir, "job.json"), "utf8"))
      } catch {
        meta = {}
      }
      let payload = null
      try {
        payload = JSON.parse(readFileSync(path.join(outDir, "batch.json"), "utf8"))
      } catch {
        payload = null
      }
      batches.set(entry.name, {
        id: entry.name,
        kind: "batch",
        dir: meta.dir || "",
        labelFrom: meta.labelFrom || "auto",
        dataset: meta.dataset || "tone",
        outDir,
        status: payload ? "done" : "error",
        stage: payload ? "已完成" : "失败",
        createdAt: meta.createdAt || entry.mtime,
        endedAt: meta.endedAt || null,
        error: payload ? null : (meta.error || "上次运行被中断"),
        total: payload ? (payload.total || 0) : (meta.total || 0),
        analyzed: payload ? (payload.analyzed || 0) : (meta.analyzed || 0),
        byLabel: payload ? (payload.byLabel || {}) : (meta.byLabel || {}),
        log: [],
        child: null,
        logStream: null,
        finalized: true
      })
    }
  } catch {
    /* history is best effort */
  }
}

/**
 * 从磁盘恢复一站式分析任务。
 *
 * 之前 analyze 是唯一没有 load* 的家族：DSH 一重启，它的任务就从内存里消失，
 * 页面「最近任务」看不到，toolbox_job 只能靠磁盘分支按 id 猜到。
 * 判定和 loadHistory 一致：有产出才算 done，否则按"上次被中断"处理。
 */
function loadAnalyzes() {
  try {
    const entries = readdirSync(ANALYZE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let mtime = 0
        try {
          mtime = statSync(path.join(ANALYZE_ROOT, entry.name)).mtimeMs
        } catch {
          mtime = 0
        }
        return { name: entry.name, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_JOBS())
    for (const entry of entries) {
      if (analyzeJobs.has(entry.name)) continue
      const outDir = path.join(ANALYZE_ROOT, entry.name)
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(path.join(outDir, 'job.json'), 'utf8'))
      } catch {
        meta = {}
      }
      const ok = existsSync(path.join(outDir, 'audio', 'prosody.json'))
        || existsSync(path.join(outDir, 'video', 'report.md'))
      let log = []
      try {
        log = readFileSync(path.join(outDir, 'job.log'), 'utf8')
          .split(/\r?\n/).filter(Boolean).slice(-MAX_LOG())
      } catch {
        log = []
      }
      analyzeJobs.set(entry.name, {
        id: entry.name,
        kind: 'analyze',
        source: meta.source || '',
        outDir,
        status: ok ? 'done' : 'error',
        stage: ok ? '已完成' : '失败',
        createdAt: meta.createdAt || entry.mtime,
        endedAt: meta.endedAt || null,
        error: ok ? null : (meta.error || '上次运行被中断'),
        audioState: null,
        videoState: null,
        log,
        children: [],
        child: null,
        logStream: null,
        finalized: true,
      })
    }
  } catch {
    /* history is best effort */
  }
}

function readProsodyCurves(job) {
  try {
    return JSON.parse(readFileSync(path.join(job.outDir, 'prosody.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 逐帧曲线降采样。原数据 0.01 秒一帧，实测 10 分钟音频有 60000 帧、
 * 整个 curves 约 3.2 MB —— 全塞进工具回执会把模型上下文撑爆，而看趋势
 * 根本不需要 10ms 的分辨率。
 *
 * step=10 → 0.1 秒一帧，体积降到 1/10。整段还是逐帧看的话给 1。
 */
function downsampleCurves(curves, step) {
  const stride = Math.max(1, Math.floor(Number(step) || 1))
  if (stride === 1) return curves
  const pick = (arr) => (Array.isArray(arr) ? arr.filter((_, i) => i % stride === 0) : arr)
  const out = { hop: (Number(curves.hop) || 0.01) * stride, refHz: curves.refHz, stride }
  for (const key of ['times', 'f0', 'semitone', 'pitchOscillation',
    'pitchOscillationRate', 'db', 'state']) {
    if (curves[key] !== undefined) out[key] = pick(curves[key])
  }
  return out
}

/**
 * 说话人嵌入的默认呈现方式。
 *
 * 256 维浮点向量对调用方是噪音：模型读不懂，还白占上下文。
 * 默认给维度 + 范数（足以知道"算出来了没有"），原始向量留在 prosody.json。
 * 传 rawSpeaker: true 才原样返回——那是给需要自己做相似度计算的人用的。
 */
function summarizeSpeaker(speaker, wantRaw) {
  if (!speaker) return null
  if (wantRaw) return speaker
  const vec = Array.isArray(speaker) ? speaker : (Array.isArray(speaker.embedding) ? speaker.embedding : null)
  if (!vec) return speaker
  let sumsq = 0
  let finite = 0
  for (const v of vec) {
    if (Number.isFinite(v)) { sumsq += v * v; finite += 1 }
  }
  return {
    dim: vec.length,
    finiteValues: finite,
    norm: Math.sqrt(sumsq),
    note: '原始 256 维向量在 prosody.json 的 speaker 字段；需要时传 rawSpeaker: true'
  }
}

// ---------------------------------------------------------------------------
// 标注：给一段声音打上"催 / 试探 / 随口"之类的标签，攒成第三层的对照样本
// ---------------------------------------------------------------------------

const LABEL_ROOT = process.env.XIYOUNG_LABEL_ROOT || path.join(TOOLBOX_HOME, 'labels')
const LABELS_FILE = path.join(LABEL_ROOT, 'labels.json')

/**
 * 声音笔记（原「语气标注」）。
 *
 * 定位变了，数据不变：
 *
 * 以前这里是为了"攒语气标注 → 训练/对照出「抖」对应什么情绪"。那条路已经
 * 被实测否掉了（qwen3.5:4b 情绪分类 13.9% < 随机 16.7%，置换检验 A=B=C 100%
 * 相同）——不是特征问题，是模型没有韵律→语义的映射能力。所以继续逼用户
 * 选一个预设标签，是在为一个已证伪的目标收集数据。
 *
 * 但用户真正在做的事是有价值的：他记的是
 *   「男声哭腔 7.76 秒里断了 9 次，平均 0.86 秒一次」
 *   「雨声：停顿 0 段，响度标准差 2.01 dB」
 *   「冷得发抖：自相关 6.94 Hz」
 * 那是**对声音本身的观察**，只是当时被包装成了"训练标签"。
 *
 * 所以：
 *   - label 保留（兼容那 1212 条旧数据，也是快速分类的入口）
 *   - note 升为主角（自由文本，不限制必须从预设里选）
 *   - 旧记录的每个字段原样保留，读取时不做任何迁移或改写
 */
function readLabels() {
  try {
    const data = JSON.parse(readFileSync(LABELS_FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writeLabels(list) {
  mkdirSync(LABEL_ROOT, { recursive: true })
  // 写之前先留一份，笔记是不可再生数据
  try {
    if (existsSync(LABELS_FILE)) {
      const bak = LABELS_FILE.replace(/\.json$/, '') + '.bak.json'
      writeFileSync(bak, readFileSync(LABELS_FILE))
    }
  } catch {
    /* 备份失败不该阻止写入 */
  }
  writeFileSync(LABELS_FILE, JSON.stringify(list, null, 2), 'utf8')
}

function addLabel(entry) {
  const list = readLabels()
  // 标签是给人看的一两个词，5000 字一定是哪里传错了
  if (entry.label && String(entry.label).length > 64) {
    throw new BadRequestError('标签太长（上限 64 字），当前 ' + String(entry.label).length + ' 字')
  }
  const note = entry.note === undefined || entry.note === null ? '' : String(entry.note)
  if (note.length > 4000) {
    throw new BadRequestError('笔记太长（上限 4000 字），当前 ' + note.length + ' 字')
  }
  const record = {
    id: 'lb_' + Date.now().toString(36) + '_' + randomUUID().slice(0, 6),
    createdAt: Date.now(),
    dataset: entry.dataset || 'tone',
    ...entry
  }
  if (!record.dataset) record.dataset = 'tone'
  if (!record.label && note) {
    // 允许"只有笔记没有标签"——这才是主要用法
    record.label = ''
  }
  if (!record.label && !note) {
    throw new BadRequestError('至少要有标签或笔记之一')
  }
  list.push(record)
  writeLabels(list)
  return record
}

/** 按数据集过滤；不传就是全部。 */
function filterByDataset(list, dataset) {
  if (!dataset || dataset === 'all') return list
  return list.filter((item) => String(item.dataset || 'tone') === dataset)
}

/** 各数据集的条数。 */
function datasetTally(list) {
  const out = {}
  for (const item of list) {
    const key = String(item.dataset || 'tone')
    out[key] = (out[key] || 0) + 1
  }
  return out
}

/**
 * 把一条笔记按"有没有笔记正文"分类。
 *
 * 旧数据的 note 字段有些是说明性短句（"CASIA 语料，目录名即情绪标签"），
 * 那些不是用户自己的观察。判断依据：带 features 且 dataset=caisa/batch 的是语料，
 * 其余才算自己的笔记。
 */
function isOwnNote(record) {
  const ds = String(record.dataset || '')
  if (ds === 'caisa') return false
  if (record.features && ds && ds !== 'tone') return false
  return Boolean(String(record.note || '').trim() || String(record.label || '').trim())
}

async function waitForProsody(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return job
}

function prosodyToolResult(job, includeCurves, curveStep = 1, includeRawSpeaker = false) {
  const data = readProsodyCurves(job)
  const summary = (data && data.summary) || job.summary || null
  const rawCurves = includeCurves && data && data.curves ? data.curves : null
  const curves = rawCurves ? downsampleCurves(rawCurves, curveStep) : null

  // ---- 把交接书里"实测过的不可靠之处"变成回执里的字段 ----
  // 这些限制一直只活在文档里，调用方看不到，于是会把不可靠的数字当真。
  const duration = summary ? Number(summary.duration) || 0 : 0
  const caveats = []

  // 说话人：不足 1 秒区分力明显下降（交接书四·五）
  if (data && data.speaker && duration > 0 && duration < 1.0) {
    caveats.push('这段只有 ' + duration.toFixed(2) + ' 秒：说话人嵌入在不足 1 秒时区分力明显下降，'
      + '不要只凭 similarity 下"是不是同一个人"的结论。')
  }
  if (data && data.speakerCompare) {
    const cmp = data.speakerCompare
    if (typeof cmp.mfccDistance === 'number') {
      // 交接书四·五：MFCC 跨录音设备不可比
      caveats.push('mfccDistance 对录音设备敏感，换了设备就不具可比性；判同人请看 similarity。')
    }
    if (typeof cmp.similarity === 'number' && cmp.similarity >= 0.55 && cmp.similarity < 0.70) {
      caveats.push('similarity 落在 0.55–0.70 这个中间地带，实测同人/异人都可能落进来，说不准。')
    }
  }
  // 疑非人声：数字看着正经但可能是噪声
  if (summary && summary.suspectedNonSpeech) {
    caveats.push('这段疑似不是人声：下面的基频/微颤是跟踪器对噪声的读数，不能当人声数据用。')
  }
  // 是人声但不是说话（哭/笑/打哈欠/咳嗽）：基频数字是真实的，但没有语言内容
  const cc0 = summary && (summary.contentClass || null)
  if (cc0 && cc0.kind === 'nonverbal') {
    caveats.push('这段是人声但不是说话（哭/笑/打哈欠/咳嗽这类）：基频数字可信，'
      + '但没有语言内容，不能拿它当"说话的语气"来分析。')
  }

  return {
    ok: job.status === 'done',
    prosodyId: job.id,
    status: job.status,
    stage: job.stage || null,
    source: job.source,
    outDir: job.outDir,
    summary,
    // 已知不可靠之处，一句话一条；没有就是空数组
    caveats,
    // 疑似非人声：这类数据的数字看着正经但全是假的，必须显式告诉调用方
    suspectedNonSpeech: Boolean(summary && summary.suspectedNonSpeech),
    nonSpeechWarning: summary ? (summary.nonSpeechWarning || null) : null,
    nonSpeechReasons: summary ? (summary.nonSpeechReasons || []) : [],
    // 转写结果单独提出来：其他会话最常要的就是这段文字
    transcript: data ? (data.transcript || null) : null,
    segments: data && Array.isArray(data.segments) ? data.segments : [],
    // 统一裁决：解决 musicLike / suspectedNonSpeech 指方向相反时谁算数的问题
    contentClass: (data && (data.contentClass || (data.summary && data.summary.contentClass))) || null,
    // 转写状态：区分"模型跑了没出字"和"环境坏了"
    transcriptStatus: (data && (data.transcriptStatus || (data.summary && data.summary.transcriptStatus))) || null,
    // 音乐性 / 唱歌标记
    musicLike: (data && (data.musicLike || (data.summary && data.summary.musicLike))) || null,
    singingLike: (data && (data.singingLike || (data.summary && data.summary.singingLike))) || null,
    // 变化点：可验证的"这里变了没有"
    changes: data && Array.isArray(data.changes) ? data.changes : [],
    changeSummary: data ? (data.changeSummary || null) : null,
    // 人声 / 背景 的时间定位（不是分离，只回答"哪几秒是什么"）
    segmentsByKind: summary && Array.isArray(summary.segmentsByKind) ? summary.segmentsByKind : [],
    segmentSummary: summary ? (summary.segmentSummary || null) : null,
    // 相对基线（需要传 baseline 才有）
    relative: data ? (data.relative || null) : null,
    // 说话人嵌入：256 维浮点向量。原样塞进回执没有意义——模型读不懂 256 个
    // 小数，还白占上下文。默认只给维度摘要，原始向量留在 prosody.json 里；
    // 真要向量时传 rawSpeaker: true。
    speaker: summarizeSpeaker(data ? data.speaker : null, includeRawSpeaker),
    speakerError: data ? (data.speakerError || null) : null,
    speakerCompare: data ? (data.speakerCompare || null) : null,
    refHz: data ? data.refHz : null,
    hop: data ? data.hop : null,
    curves: curves ? {
      hop: curves.hop,
      refHz: curves.refHz,
      stride: curves.stride || 1,
      times: curves.times,
      f0: curves.f0,
      semitone: curves.semitone,
      pitchOscillation: curves.pitchOscillation,
      // 过零率是判据本身，前端也拿得到——藏起来就成黑箱了
      pitchOscillationRate: curves.pitchOscillationRate,
      db: curves.db,
      state: curves.state
    } : null,
    // 逐帧曲线被降采样时，原始数据的位置
    curvesHint: includeCurves
      ? (curves && curves.stride > 1
        ? '曲线已按每 ' + curves.stride + ' 帧取样（0.01s×' + curves.stride + '）。要原始逐帧数据读 ' + path.join(job.outDir, 'prosody.json')
        : null)
      : '未返回逐帧曲线；需要时传 includeCurves: true（可配 curveStep 降采样），或读 ' + path.join(job.outDir, 'prosody.json'),
    error: job.error || null,
    note: job.status === 'done' ? null : '任务仍在运行；用 toolbox_job({ id }) 查询。',
    log: job.log.slice(-12)
  }
}

const prosodyAnalyzeTool = {
  name: 'prosody_analyze',
  description:
    '在本机分析一段音频的韵律（第二层）：基频曲线（pyin）、相对说话人自己的半音走向、局部微颤、'
    + '响度，以及浊音/清音（气声）/静音三分类。全部本地计算，不上传。'
    + 'summary 里还有四维频谱特征：spectralCentroid（音色亮度）、spectralRolloff（高频边界）、'
    + 'spectralFlatness（噪声性，已取 log10）、hnrMedian/hnrP10（谐噪比，嗓音沙哑度）。'
    + '这四维对区分情绪比纯韵律更有用（CNEV 实测：5 维韵律 61.3% → 合并 10 维 64.7%，随机 20%）。'
    + '还有音强包络（dbRange/dbStd/dbSwing/dbJitter，音量怎么起伏）和语速（charsPerSec/speechDensity，需要转写）。'
    + '注意：这些数字够用来描述声音，但**不够用来判断情绪**——真实说话的 7 类情绪分类只有 34.3%（随机 14.3%），各类在特征空间里挤在一起。'
    + 'source 支持本地路径、http(s) 直链、B 站链接。返回汇总和逐帧曲线（0.01 秒一帧）。'
    + '同时用本机 SenseVoice 转写语音，返回 transcript（全文）和 segments（每句的起止时间 + 那段的基频/半音/微颤），'
    + '这样文本和"抖"能对上。没有 SenseVoice 模型时会跳过转写，不影响分析。'
    + '另外会算说话人嵌入（256 维，Resemblyzer）：传 compare 参数（另一段音频）就返回两者的余弦相似度，'
    + '用来判断是不是同一个人——同一人通常 > 0.70，不同人通常 < 0.55。'
    + '注意：韵律数字不给"这句话是催还是试探"的判断（那需要标注样本），也不给"谁是谁"的判断（那需要说话人模型）。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '本地文件路径、直链，或 B 站链接 / BV 号。' },
      start: { type: 'number', description: '从第几秒开始分析，默认从头。' },
      duration: { type: 'number', description: '分析多长，默认整段。' },
      includeCurves: { type: 'boolean', description: '是否返回逐帧曲线。默认 false——原数据 0.01 秒一帧，10 分钟音频约 3.2 MB，会撑爆上下文。需要看趋势时再开，并配 curveStep 降采样。' },
      curveStep: { type: 'integer', minimum: 1, maximum: 100, description: 'includeCurves 为 true 时，每隔几帧取一个点。默认 10（0.1 秒一帧）。' },
      rawSpeaker: { type: 'boolean', description: '是否返回完整 256 维说话人向量。默认 false，只给维度/norm 摘要。' },
      compare: { type: 'string', description: '另一段音频的路径。给了就返回两段的说话人相似度（0-1），用来判断是不是同一个人。' },
      f0Min: { type: 'number', minimum: 30, maximum: 300, description: '基频搜索下限 Hz，默认取配置（75）。男声偏低可以给 50-60。' },
      f0Max: { type: 'number', minimum: 100, maximum: 1200, description: '基频搜索上限 Hz，默认取配置（400）。女声/童声可以给 500-600。' },
      language: { type: 'string', description: '转写语言，默认取配置（zh）。SenseVoice 支持 zh/en/ja/ko/yue 等。' },
      hop: { type: 'number', minimum: 0.005, maximum: 0.1, description: '分析帧长（秒），默认 0.01。调小更细但更慢、文件更大。' },
      minPauseSec: { type: 'number', minimum: 0.05, maximum: 5, description: '算作"停顿"的最短静音秒数，默认取配置（0.4）。' },
      loudnessFloorDb: { type: 'number', minimum: 1, maximum: 60, description: '响度变化的下限 dB，默认取配置（12）。低于它不算变化点。' },
      loudnessCeilDb: { type: 'number', minimum: 2, maximum: 80, description: '响度变化的上限 dB，默认取配置（25）。' },
      minGapSec: { type: 'number', minimum: 0, maximum: 60, description: '同类变化点之间至少隔几秒才各算一条，默认取配置（0.35）。' },
      pitchJumpSemitone: { type: 'number', minimum: 1, maximum: 24, description: '判定"音高突变"的最小半音跳变，默认取配置（6.0）。调小更敏感。' },
      registerMaxSemitone: { type: 'number', minimum: 2, maximum: 36, description: '换腔判定的最大偏移半音，默认取配置（12.0）。' },
      noSpeaker: { type: 'boolean', description: '跳过说话人嵌入（默认装了 resemblyzer 就算）。' },
      baseline: { type: 'string', description: '基线文件路径（labels.json 或 batch.json）。给了就算相对量：z 分数和分位数，而不是绝对 Hz。' }
    },
    required: ['source']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        prosodyId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        source: { type: 'string' },
        outDir: { type: 'string' },
        summary: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        caveats: { type: 'array' },
        suspectedNonSpeech: { type: 'boolean' },
        nonSpeechWarning: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        nonSpeechReasons: { type: 'array' },
        transcript: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        segments: { type: 'array' },
        contentClass: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        transcriptStatus: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        musicLike: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        singingLike: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        changes: { type: 'array' },
        changeSummary: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        segmentsByKind: { type: 'array' },
        segmentSummary: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        relative: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        speaker: { oneOf: [{ type: 'array' }, { type: 'null' }] },
        speakerError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        speakerCompare: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        refHz: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        hop: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        curves: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => {
      const s = value && value.summary
      if (!s) return [{ type: 'text', text: '韵律分析未完成：' + String((value && (value.error || value.note)) || '') }]
      const lines = []
      // 疑似非人声时，警告必须在数字前面
      if (value.suspectedNonSpeech) {
        lines.push('⚠ 疑似非人声——下面的数字不可信')
        for (const r of value.nonSpeechReasons || []) lines.push('  · ' + r)
        lines.push('')
      }
      lines.push('韵律分析完成（' + value.prosodyId + '）：' + (s.duration || 0).toFixed(2) + ' 秒')
      lines.push('基频中位 ' + (s.f0Median || 0).toFixed(1) + ' Hz，音域 ' + (s.semitoneRange || 0).toFixed(1) + ' 半音')
      lines.push('浊音 ' + Math.round((s.voicedRatio || 0) * 100) + '% · 清音 ' + Math.round((s.unvoicedRatio || 0) * 100)
        + '% · 静音 ' + Math.round((s.silenceRatio || 0) * 100) + '%')
      // 2026-11-27：jitterPeaks 已删，改成时段 + 过零率。
      // 标签写成「音高振荡」，不写「抖」——数字给现象，判断留给读的人。
      if (s.pitchOscillationMedian !== undefined && s.pitchOscillationMedian !== null) {
        lines.push('音高振荡（3-12 Hz）中位 ' + Number(s.pitchOscillationMedian).toFixed(2) + ' 半音')
        const spans = s.pitchOscillationSpans || []
        for (const sp of spans.slice(0, 4)) {
          lines.push('  ' + sp.start + '–' + sp.end + 's 峰值 ' + sp.peak + ' 半音'
            + (sp.rate ? '（来回 ' + sp.rate + ' 次/秒）' : ''))
        }
      } else if (s.pitchOscillationNote) {
        lines.push('音高振荡：' + s.pitchOscillationNote)
      }
      // 滑音是独立轨道，可以和振荡重叠
      const glides = s.pitchGlides || []
      for (const g of glides.slice(0, 4)) {
        lines.push('音高滑移 ' + g.start + '–' + g.end + 's '
          + (g.direction === 'down' ? '↓' : '↑') + g.semitones + ' 半音 / '
          + g.seconds + ' 秒')
      }
      // 转写状态：让"没出字"和"环境坏了"可区分
      if (value.transcriptStatus && value.transcriptStatus !== 'ok') {
        const statusText = {
          empty: '模型跑完了但没出字（可能是纯音乐/噪声，也可能是唱歌时吐字不清）',
          punct: '只转出标点或单个语气词（没有可用的说话内容）',
          no_model: 'SenseVoice 模型不可用（环境问题，不是音频问题）',
          decode_fail: '音频解码失败',
          skipped: '按参数跳过了转写',
        }[value.transcriptStatus] || value.transcriptStatus
        lines.push('转写状态：' + statusText)
      }
      if (value.transcript) lines.push('文本：' + value.transcript)

      // 内容类型：一个明确结论，替代两个字段自己猜
      // nonSpeech 的情况上面已经有过详细警告了，这里不重复
      const cls = value.contentClass
      if (cls && cls.kind !== 'speech' && cls.kind !== 'nonSpeech') {
        lines.push('')
        const label = {
          music: '⚠ 更像音乐/旋律，不是说话',
          singing: '⚠ 是人声，但在唱',
          nonverbal: '⚠ 是人声，但不是说话（哭/笑/打哈欠/咳嗽这类）',
        }[cls.kind] || cls.kind
        lines.push(label)
        if (cls.note) lines.push('   ' + cls.note)
        if (cls.kind === 'music') {
          for (const r of ((value.musicLike || {}).reasons || []).slice(0, 3)) lines.push('  · ' + r)
        }
      }
      if (value.singingLike && !(cls && cls.kind === 'singing')) {
        lines.push('')
        lines.push('⚠ ' + value.singingLike.warning)
      }
      if (cls && cls.kind === 'singing' && value.transcriptStatus === 'empty') {
        lines.push('   注：转写没出字是因为在唱，不是因为没人在说话。')
      }

      // 人声 / 背景 的时间轴：这是"分清背景音"能落地的那一半
      if (value.segmentSummary && value.segmentSummary.count > 0) {
        lines.push('')
        lines.push('时间轴：' + value.segmentSummary.note)
        const label = { speech: '人声', background: '背景', mixed: '交织' }
        const segs = value.segmentsByKind || []
        for (const sg of segs.slice(0, 10)) {
          lines.push('  ' + sg.start.toFixed(2) + '–' + sg.end.toFixed(2) + 's  ' + (label[sg.kind] || sg.kind))
        }
        if (segs.length > 10) lines.push('  …还有 ' + (segs.length - 10) + ' 段')
        lines.push('  注：只做时间定位，没有分离出独立音轨')
      }

      // 变化点：可验证的"这里变了没有"，排在情绪类描述前面
      if (value.changeSummary && value.changeSummary.count > 0) {        lines.push('')
        lines.push('变化点：' + value.changeSummary.note)
        for (const c of (value.changes || []).slice(0, 8)) {
          lines.push('  ' + c.at.toFixed(2) + 's  ' + c.note)
        }
        if (value.changes && value.changes.length > 8) {
          lines.push('  …还有 ' + (value.changes.length - 8) + ' 处')
        }
      }

      // 相对基线（传了 baseline 才有）
      if (value.relative && value.relative.intensity) {
        lines.push('')
        lines.push('相对基线（' + (value.relative.baseline.kind || '') + '，n=' + (value.relative.baseline.n || 0) + '）：')
        lines.push('  ' + value.relative.intensity.note)
        for (const n of (value.relative.intensity.notable || []).slice(0, 3)) {
          lines.push('  - ' + n.note)
        }
      }

      // 说话人对比结果
      if (value.speakerCompare) {
        const sc = value.speakerCompare
        lines.push('')
        lines.push('说话人相似度：' + sc.similarity.toFixed(4) + '（' + sc.verdict + '）')
        lines.push('  对比对象：' + sc.source)
        lines.push('  参考：同一人通常 > 0.70，不同人通常 < 0.55')
      } else if (value.speakerError) {
        lines.push('')
        lines.push('说话人嵌入不可用：' + value.speakerError)
      } else if (value.speaker) {
        lines.push('')
        // speaker 现在默认是 {dim, finiteValues, norm} 摘要，也可能是原始数组（rawSpeaker: true）
        const dim = Array.isArray(value.speaker) ? value.speaker.length : value.speaker.dim
        lines.push('说话人嵌入：' + dim + ' 维（可用 compare 参数和另一段比对）')
      }

      // 已知不可靠之处：放在最后一段，但一定要出现——这些限制以前只写在文档里
      if (value.caveats && value.caveats.length) {
        lines.push('')
        lines.push('⚠ 读这些数字前先知道：')
        for (const c of value.caveats) lines.push('  · ' + c)
      }

      lines.push('输出：' + value.outDir)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const raw = String((args && args.source) || '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!raw) throw new Error('prosody_analyze: 需要一个本地路径、直链或 B 站链接')
    // 必须走 normalizeSource：裸 BV 号要转成完整链接，
    // 否则会被当成文件名丢给 ffmpeg（实测 BV1zu4y1S7nu 就是这样失败的）。
    const parsed = normalizeSource(raw)
    if (!parsed) throw new Error('prosody_analyze: 无法识别的来源：' + raw)
    if (parsed.kind === 'local' && !existsSync(parsed.path)) {
      throw new Error('prosody_analyze: 找不到本地文件 ' + parsed.path)
    }
    const running = activeProsody()
    if (running) throw new Error('prosody_analyze: 已有分析在运行（' + running.id + '），请用 toolbox_job({ id }) 查询')
    // compare 也要归一化：裸 BV 号 / 相对路径都可能传进来
    let comparePath = null
    if (args && args.compare) {
      const parsedCompare = normalizeSource(String(args.compare))
      if (parsedCompare && parsedCompare.kind === 'local') comparePath = parsedCompare.path
      else if (parsedCompare && parsedCompare.kind === 'url') comparePath = parsedCompare.url
    }
    const job = startProsody(parsed.kind === 'local' ? parsed.path : parsed.url, {
      start: args && args.start,
      duration: args && args.duration,
      compare: comparePath,
      noSpeaker: args && args.noSpeaker === true,
      f0Min: args && args.f0Min,
      f0Max: args && args.f0Max,
      language: args && args.language,
      hop: args && args.hop,
      minPauseSec: args && args.minPauseSec,
      loudnessFloorDb: args && args.loudnessFloorDb,
      loudnessCeilDb: args && args.loudnessCeilDb,
      minGapSec: args && args.minGapSec,
      pitchJumpSemitone: args && args.pitchJumpSemitone,
      registerMaxSemitone: args && args.registerMaxSemitone,
      baseline: args && args.baseline ? String(args.baseline).trim().replace(/^"(.*)"$/, '$1').trim() : null
    })
    const finished = await waitForProsody(job, 180000)
    return prosodyToolResult(
      finished,
      args && args.includeCurves === true,      // 默认不带曲线：3MB 的回执对模型没用
      Number(args && args.curveStep) || 10,     // 带的时候也默认降采样到 0.1 秒一帧
      args && args.rawSpeaker === true
    )
  }
}

const prosodyLabelTool = {
  name: 'prosody_label',
  description:
    '记一条声音笔记：你对某段音频的观察，可以带一个短标签。'
    + 'note 是正文（主要用法），label 可选。'
    + '例如 note:"7.76 秒里断了 9 次，平均 0.86 秒一次"，label:"哭腔"。'
    + '这个功能**不是**攒情绪训练样本——实测情绪分类 13.9% 低于随机 16.7%，那条路已证伪。'
    + '但"断几次""自相关多少 Hz""响度标准差多大"这类观察是可靠的，值得记下来回看。'
    + 'action=list 列出已有笔记，dataset 填 note 只看自己的，limit 限制条数。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list'],
        description: 'add（默认）记一条笔记；list 列出已有记录。'
      },
      note: { type: 'string', description: '笔记正文：你观察到什么。这是主要字段。' },
      label: { type: 'string', description: '短标签（可选）：哭腔 / 雨声 / 鼓点 ……' },
      dataset: { type: 'string', description: '属于哪个数据集，默认 tone；自己写的笔记用 note。' },
      prosodyId: { type: 'string', description: '关联到某个韵律分析结果。' },
      source: { type: 'string', description: '音频路径或来源（没有 prosodyId 时用）。' },
      start: { type: 'number', description: '这段从第几秒开始。' },
      end: { type: 'number', description: '这段到第几秒结束。' },
      text: { type: 'string', description: '这段说的是什么（可选）。' },
      limit: { type: 'integer', description: 'list 时最多列几条，默认 50。' }
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        label: { type: 'object' },
        labels: { type: 'array' },
        count: { type: 'number' },
        total: { type: 'number' },
        tally: { type: 'object' },
        datasets: { type: 'object' },
        file: { type: 'string' },
        note: { type: 'string' }
      }
    },
    render: (_args, value) => {
      if (value && Array.isArray(value.labels)) {
        // 用返回值里现成的 tally（按筛选后集合统计），不再自己数 labels——
        // labels 受 limit 截断，自己数会得出"只有 50 条"这种错结论。
        const tally = (value && value.tally) || {}
        const parts = Object.keys(tally).map((k) => k + ' ' + tally[k]).join(' · ')
        const shown = value.labels.length
        const hit = Number(value.count) || 0
        const tail = shown < hit ? '（列出最近 ' + shown + ' 条）' : ''
        return [{ type: 'text', text: '命中 ' + hit + ' 条' + tail + '：' + (parts || '（空）') }]
      }
      return [{ type: 'text', text: '已记下标签：' + String((value && value.label && value.label.label) || '') }]
    }
  },
  async execute(args) {
    const action = (args && args.action) || 'add'
    if (action === 'list') {
      // dataset / label 筛选是从 prosody_labels 合并过来的——
      // 那个工具只是本工具的 list 快捷方式，没必要占一个工具位。
      const datasetFilter = args && args.dataset ? String(args.dataset).trim() : null
      const labelFilter = args && args.label ? String(args.label).trim() : null
      const all = readLabels()
      // dataset 筛选用共用的 filterByDataset（和路由那边同一套逻辑），
      // 别在这里重写一份——0.18.0 之前那个 list 快捷工具和路由各写过一遍，
      // 两边对 "未标 dataset" 的处理不一样，是隐患。
      const scoped = filterByDataset(all, datasetFilter)
      const filtered = labelFilter
        ? scoped.filter((item) => String(item.label || '') === labelFilter)
        : scoped
      const limit = Math.max(1, Math.min(500, Number(args && args.limit) || 50))
      // count 是"筛选后命中多少条"（和返回的 labels 上限无关），
      // total 是"标注池一共多少条"——这两个以前分开在旧工具里，容易看混，
      // 现在都在同一个返回值里，并在 count 的描述里写清楚。
      return {
        ok: true,
        labels: filtered.slice(-limit),
        count: filtered.length,
        total: all.length,
        // tally 按筛选后的集合统计（不是全池），这样"只看 caisa"时看到的分布
        // 就是 caisa 内部的分布，不会混进 tone/note。
        tally: (() => {
          const t = {}
          for (const item of scoped) {
            const key = String(item.label || '未标')
            t[key] = (t[key] || 0) + 1
          }
          return t
        })(),
        datasets: datasetTally(all),
        file: LABELS_FILE
      }
    }
    const label = String((args && args.label) || '').trim()
    const note = String((args && args.note) || '').trim()
    // 笔记为主：只要有一边内容就能存
    if (!label && !note) throw new Error('prosody_label: 至少给 note（观察正文）或 label（短标签）')
    const record = addLabel({
      dataset: args && args.dataset ? String(args.dataset) : (note ? 'note' : 'tone'),
      label,
      note,
      prosodyId: args && args.prosodyId ? String(args.prosodyId) : null,
      source: args && args.source ? String(args.source) : null,
      start: Number.isFinite(Number(args && args.start)) ? Number(args.start) : null,
      end: Number.isFinite(Number(args && args.end)) ? Number(args.end) : null,
      text: args && args.text ? String(args.text) : null
    })
    return { ok: true, label: record, note: '已存到 ' + LABELS_FILE }
  }
}


// ---------------------------------------------------------------------------
// 缓存清理：报告生成后，中间产物（源视频、解码 wav、抽出的帧）就没用了
// ---------------------------------------------------------------------------

function dirSize(dir) {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) total += dirSize(full)
        else total += statSync(full).size
      } catch {
        /* skip */
      }
    }
  } catch {
    /* missing */
  }
  return total
}

/**
 * 删掉一个任务目录里指定的文件/子目录；保留清单里的东西。
 *
 * 两件事要小心：
 *  1. "明确要删"必须能盖过 keep 的通配（source.mp4 要盖过 /\.mp4$/）
 *  2. 规则可能指向子目录里的东西（batch 的 _work/decoded.wav、prosody 的 _cmp/），
 *     只扫顶层会漏掉。所以顶层没命中可删项、且该目录本身也不在 drop 里时，
 *     往下走一层。只走一层——再深就是数据而不是中间产物了。
 */
function pruneDir(dir, { keep, drop }, depth = 0) {
  const matches = (patterns, name) => patterns.some(
    (pattern) => (pattern instanceof RegExp ? pattern.test(name) : name === pattern)
  )
  let freed = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const isDrop = matches(drop, entry.name)
    const isKeep = matches(keep, entry.name)

    if (isDrop && !isKeep) {
      try {
        const size = entry.isDirectory() ? dirSize(full) : statSync(full).size
        rmSync(full, { recursive: true, force: true })
        freed += size
      } catch {
        /* locked or already gone */
      }
      continue
    }

    // 这个目录本身要留，但里面可能有可删的中间产物
    if (entry.isDirectory() && !isDrop && depth === 0) {
      freed += pruneDir(full, { keep, drop }, depth + 1)
    }
  }
  return freed
}

const CLEAN_KEEP = {
  // ⚠️ 这些文件名全部来自 python 源码里的实际产出，不是猜的。
  // 改任何 python 脚本的写盘名字，必须同步改这里，否则会漏删或误删。
  //
  //    video_watch.py   → report.md summary.md analysis.json sheets_manifest.json
  //                       sheets/sheet_NNN.jpg frames/frame_NNNNN.jpg video.mp4
  //    prosody.py       → prosody.json prosody.md decoded.wav _cmp/（--compare 临时）
  //    batch_import.py  → batch.json batch.md _work/decoded.wav
  //    speaker_cluster.py  → clusters.json clusters.md dec_<tag>.wav
  //    speaker_diarize.py  → diarization.json diarization.md input.wav
  //    benchmark.py     → benchmark.json benchmark.md b_<tag>.wav

  // 视频分析：报告、摘要、拼图、清单都留；源视频和抽出的帧删
  runs: {
    keep: [/\.md$/, /^job\.(json|log)$/, /^analysis\.json$/, /^sheets_manifest\.json$/, /^sheets$/],
    drop: [/^video\./, /^frames$/, /\.(mp4|mkv|webm|flv|ts)$/]
  },
  // 截取：成品片段 + 元数据留；下载的源素材删。
  // 注意成品和源素材都可能是 mp4，所以不能靠扩展名区分——keep 用 clip.* 和成品名，
  // drop 只认 source.* 前缀（pruneDir 里 drop 优先于 keep，这条才能生效）。
  clips: {
    keep: [/^clip\.(json|log)$/],
    drop: [/^source\./]
  },
  // 韵律：结果留；解码 wav 和 compare 临时目录删
  prosody: {
    keep: [/^prosody\.(json|md)$/, /^job\.(json|log)$/],
    drop: [/^decoded\.wav$/, /^source\./, /^_cmp$/]
  },
  // 一站式分析：audio/ 与 video/ 两个子目录，各自一套产物
  analyze: {
    keep: [/\.md$/, /^job\.(json|log)$/, /^sheets$/],
    drop: [/^source\./, /^decoded\.wav$/, /^_cmp$/, /^frames$/, /\.(mp4|mkv|webm)$/]
  },
  // 批量导入：batch.json / batch.md 留；_work 整目录删（里面是逐条 decoded.wav）
  batches: {
    keep: [/^batch\.(json|md)$/, /^job\.(json|log)$/],
    drop: [/^source\./, /^_work$/]
  },
  // 说话人聚类：clusters.json / clusters.md 留；抽出来的 dec_*.wav 删
  clusters: {
    keep: [/^clusters\.(json|md)$/, /^job\.(json|log)$/],
    drop: [/^source\./, /^dec_[^/]*\.wav$/]
  },
  // 说话人分离：diarization.json / diarization.md 留；解码的 input.wav 删
  diarize: {
    keep: [/^diarization\.(json|md)$/, /^job\.(json|log)$/],
    drop: [/^source\./, /^input\.wav$/]
  },
  // 特征评测：benchmark.json / benchmark.md 留；解码的 b_*.wav 删
  bench: {
    keep: [/^benchmark\.(json|md)$/, /^job\.(json|log)$/],
    drop: [/^source\./, /^b_[^/]*\.wav$/]
  }
}

/** kind → 根目录。labels 故意不在这里：标注是唯一不可再生数据，任何清理都不碰它。 */
// 下载缓存（0.21.0 新增）。结构和其他任务目录不同：
// 别的 root/ 下每个子目录是一次任务，这里 root/ 下直接是平铺的 mp4。
// 所以用单独的清理函数，不塞进 cleanKind。
const VIDEO_CACHE_ROOT = process.env.XIYOUNG_VIDEO_CACHE_DIR
  ? path.resolve(String(process.env.XIYOUNG_VIDEO_CACHE_DIR))
  : path.join(TOOLBOX_HOME, 'cache', 'video')

const CLEAN_ROOTS = {
  runs: () => WORK_ROOT,
  clips: () => CLIP_ROOT,
  prosody: () => PROSODY_ROOT,
  analyze: () => ANALYZE_ROOT,
  batches: () => BATCH_ROOT,
  clusters: () => CLUSTER_ROOT,
  diarize: () => DIARIZE_ROOT,
  bench: () => BENCH_ROOT
}

/**
 * 清下载缓存。和 cleanKind 的区别：这里是平铺文件，不是任务目录。
 *
 * 安全设计：
 *   - 不给 all 也不给 maxAgeDays 时，什么都不删（只报告大小）
 *   - maxAgeDays 按文件 mtime 判断，只删够老的
 *   - 只删 .mp4/.part/.ytdl，不碰其他东西
 */
function cleanCache(options = {}) {
  const maxAgeMs = Number(options.maxAgeDays) > 0
    ? Number(options.maxAgeDays) * 86400000
    : null
  const all = options.all === true
  const now = Date.now()
  let freed = 0
  let removed = 0
  let kept = 0

  let files = []
  try {
    files = readdirSync(VIDEO_CACHE_ROOT, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return { ok: true, kind: 'cache', freedBytes: 0, removed: 0, kept: 0 }
  }

  for (const name of files) {
    if (!/\.(mp4|part|ytdl)$/i.test(name)) continue
    const full = path.join(VIDEO_CACHE_ROOT, name)
    let mtime = 0
    let size = 0
    try {
      const st = statSync(full)
      mtime = st.mtimeMs
      size = st.size
    } catch {
      continue
    }
    const old = maxAgeMs !== null && (now - mtime) > maxAgeMs
    // 没给 all 也没给 maxAgeDays → 只统计不删
    if (!all && !old) {
      kept += 1
      continue
    }
    try {
      rmSync(full, { force: true })
      freed += size
      removed += 1
    } catch {
      /* locked */
    }
  }

  return { ok: true, kind: 'cache', freedBytes: freed, removed, kept }
}

function cleanKind(kind, options = {}) {
  // cache 的结构和任务目录不同，走自己的清理逻辑
  if (kind === 'cache') return cleanCache(options)
  const rootOf = CLEAN_ROOTS[kind]
  if (!rootOf) return { ok: false, error: '未知类型：' + kind }
  const root = rootOf()
  const rules = CLEAN_KEEP[kind] || { keep: [], drop: [] }
  const maxAgeMs = Number(options.maxAgeDays) > 0 ? Number(options.maxAgeDays) * 86400000 : null
  const all = options.all === true
  let freed = 0
  let touched = 0
  let removedJobs = 0
  const now = Date.now()

  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return { ok: true, kind, freedBytes: 0, touched: 0, removedJobs: 0 }
  }

  for (const entry of entries) {
    const dir = path.join(root, entry.name)
    let mtime = 0
    try {
      mtime = statSync(dir).mtimeMs
    } catch {
      mtime = 0
    }
    const old = maxAgeMs !== null && (now - mtime) > maxAgeMs
    // maxAgeDays 给了就只动够老的任务——不管 all 是不是 true。
    // 之前 all 分支无视 old 直接整目录删，于是「删 7 天前的」变成了「全删」。
    if (maxAgeMs !== null && !old) continue

    if (all) {
      // 整条任务连同中间产物一起删；但成品片段（clips 的 mp4/mp3）默认不动
      if (kind === 'clips' && !options.includeOutputs) {
        freed += pruneDir(dir, rules)
      } else {
        freed += dirSize(dir)
        try {
          rmSync(dir, { recursive: true, force: true })
          removedJobs += 1
        } catch {
          /* locked */
        }
      }
      touched += 1
    } else {
      const before = dirSize(dir)
      pruneDir(dir, rules)
      const after = dirSize(dir)
      const delta = before - after
      if (delta > 0) {
        freed += delta
        touched += 1
      }
      if (old) {
        freed += after
        try {
          rmSync(dir, { recursive: true, force: true })
          removedJobs += 1
        } catch {
          /* locked */
        }
      }
    }
  }

  // 内存里的任务记录也跟着清，避免点开一个已经没有文件的任务
  if (all || removedJobs > 0) {
    const drop = new Set(entries.map((e) => e.name))
    const mapOf = {
      runs: () => jobs,
      clips: () => clips,
      prosody: () => prosodies,
      analyze: () => analyzeJobs,
      batches: () => batches,
      clusters: () => clusterJobs,
      diarize: () => diarizeJobs,
      bench: () => benchJobs
    }
    const map = mapOf[kind] ? mapOf[kind]() : null
    if (map) {
      for (const id of [...map.keys()]) {
        if (drop.has(id) && !existsSync(path.join(root, id))) map.delete(id)
      }
    }
  }

  return { ok: true, kind, freedBytes: freed, touched, removedJobs }
}

function cleanAll(options = {}) {
  const parts = Object.keys(CLEAN_ROOTS).map((kind) => cleanKind(kind, options))
  return {
    ok: true,
    freedBytes: parts.reduce((sum, p) => sum + (p.freedBytes || 0), 0),
    touched: parts.reduce((sum, p) => sum + (p.touched || 0), 0),
    removedJobs: parts.reduce((sum, p) => sum + (p.removedJobs || 0), 0),
    parts
  }
}

function cacheStats() {
  const out = {}
  // 所有任务根目录都统计，否则页面上看不见的目录只增不减
  for (const [kind, rootOf] of Object.entries(CLEAN_ROOTS)) {
    const dir = rootOf()
    out[kind] = { dir, bytes: dirSize(dir), count: safeCount(dir) }
  }
  // 标注永远不清理，只统计
  out.labels = { dir: LABEL_ROOT, bytes: dirSize(LABEL_ROOT), count: readLabels().length }
  return out
}

function safeCount(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}


// ---------------------------------------------------------------------------
// 批量导入：一个文件夹的音频 → 逐条韵律分析 → 特征和标签攒成对照表
// ---------------------------------------------------------------------------

const BATCH_SCRIPT = fileURLToPath(new URL('./lib/batch_import.py', import.meta.url))
const BATCH_ROOT = process.env.XIYOUNG_BATCH_ROOT || path.join(TOOLBOX_HOME, 'batches')

/** @type {Map<string, any>} */
const batches = new Map()

function activeBatch() {
  return [...batches.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function publicBatch(job) {
  return {
    id: job.id,
    kind: 'batch',
    dir: job.dir,
    labelFrom: job.labelFrom,
    dataset: job.dataset || 'tone',
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    total: job.total || 0,
    analyzed: job.analyzed || 0,
    byLabel: job.byLabel || {},
    outDir: job.outDir,
    log: job.log.slice(-120)
  }
}

function writeBatchMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify(publicBatch(job), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function appendBatchLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      if (text.startsWith('[batch]')) {
        job.stage = text.replace(/^\[batch\]\s*/, '')
        const found = text.match(/找到\s*(\d+)\s*个音频/)
        if (found) job.total = Number(found[1])
        const done = text.match(/^\[batch\]\s*(\d+)\/(\d+)\s/)
        if (done) job.analyzed = Number(done[1])
      }
    },
  })
}

function startBatch(dir, options = {}) {
  // 空目录（或没有音频）提前拦下，别跑一遍 python 再报"没有生成 batch.json"
  const audioExt = /\.(wav|mp3|m4a|flac|ogg|opus|aac|wma|webm|mp4|mkv|mov|avi|flv|ts|m4v)$/i
  let audioCount = 0
  const countAudio = (d, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) countAudio(path.join(d, entry.name), depth + 1)
      else if (audioExt.test(entry.name)) audioCount += 1
    }
  }
  countAudio(dir)
  if (audioCount === 0) {
    throw new BadRequestError(
      '这个文件夹里没有音频文件（支持 wav/mp3/m4a/flac/ogg/mp4/mkv/mov 等）：' + dir
    )
  }

  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(BATCH_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  let logStream = null
  try {
    logStream = createWriteStream(path.join(outDir, 'job.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const job = {
    id,
    kind: 'batch',
    dir,
    labelFrom: options.labelFrom || 'auto',
    csv: options.csv || null,
    dataset: options.dataset || 'tone',
    outDir,
    status: 'running',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    total: 0,
    analyzed: 0,
    byLabel: {},
    log: [],
    child: null,
    logStream,
    finalized: false
  }
  batches.set(id, job)
  pruneMap(batches)
  writeBatchMeta(job)

  const args = [BATCH_SCRIPT, dir, '--outdir', outDir, '--label-from', job.labelFrom]
  if (job.csv) args.push('--csv', job.csv)

  const child = spawn(PYTHON, args, {
    cwd: BATCH_ROOT,
    env: pythonEnv(),
    windowsHide: true
  })
  job.child = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => appendBatchLog(job, chunk))
  child.stderr.on('data', (chunk) => appendBatchLog(job, chunk))
  child.on('error', (error) => {
    job.error = String(error && error.message ? error.message : error)
    finishBatch(job)
  })
  child.on('close', (code) => finishBatch(job, code === null ? 1 : code))
  return job
}

function finishBatch(job, code) {
  if (job.finalized) return
  job.finalized = true
  job.endedAt = Date.now()
  const jsonPath = path.join(job.outDir, 'batch.json')
  let payload = null
  try {
    if (existsSync(jsonPath)) payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    payload = null
  }
  if (payload) {
    job.status = 'done'
    job.stage = '已完成'
    job.total = payload.total || job.total
    job.analyzed = payload.analyzed || 0
    job.byLabel = payload.byLabel || {}
  } else {
    job.status = 'error'
    job.stage = '失败'
    if (!job.error) job.error = '没有生成 batch.json'
    appendBatchLog(job, '[batch] ' + job.error)
  }
  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* closed */
    }
    job.logStream = null
  }
  writeBatchMeta(job)
}

function readBatchPayload(job) {
  try {
    return JSON.parse(readFileSync(path.join(job.outDir, 'batch.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 把批量结果里的每条写进 labels.json，和手工标注同一个池子。 */
function importBatchLabels(job, payload, dataset) {
  if (!payload || !Array.isArray(payload.records)) return { added: 0 }
  const set = dataset || job.dataset || 'tone'

  // 三类样本不写进标注池：
  //   1) 疑似非人声（雨声、风声、纯噪声）——数字是追踪器猜的
  //   2) 疑似音乐/旋律——有分说明它不像说话，数字不能当语气特征
  //   3) 疑似唱歌——确实是人声，但拿它当「说话语气」标注会污染样本池
  // 之前只查了第 1 类。唱歌样本按设计 suspectedNonSpeech=false，
  // 于是一首歌丢进「语气样本」文件夹也会照样写进去。
  // 样本池本来就小（现在只有 3 条），被搅浑一次就很难洗回来。
  const skipped = []
  const usable = payload.records.filter((record) => {
    const s = record.summary || {}
    if (s.suspectedNonSpeech) {
      skipped.push({ file: record.file, label: record.label, kind: 'nonSpeech', reasons: s.nonSpeechReasons || [] })
      return false
    }
    const music = s.musicLike
    if (music && typeof music.score === 'number' && music.score >= 2) {
      skipped.push({ file: record.file, label: record.label, kind: 'music', reasons: music.reasons || [] })
      return false
    }
    if (s.singingLike) {
      skipped.push({ file: record.file, label: record.label, kind: 'singing', reasons: [s.singingLike.warning] })
      return false
    }
    return true
  })
  const existing = readLabels()
  const seen = new Set(existing.map((item) => String(item.source || '') + '|' + String(item.label || '')))
  let added = 0
  for (const record of usable) {
    const key = job.id + ':' + record.file + '|' + record.label
    if (seen.has(key)) continue
    const s = record.summary || {}
    existing.push({
      id: 'lb_' + Date.now().toString(36) + '_' + randomUUID().slice(0, 6),
      createdAt: Date.now(),
      dataset: set,
      label: record.label,
      prosodyId: job.id,
      source: job.id + ':' + record.file,
      start: 0,
      end: s.duration || null,
      text: s.transcript || null,
      note: null,
      features: {
        f0Median: s.f0Median ?? null,
        semitoneRange: s.semitoneRange ?? null,
        trendSemitone: s.trendSemitone ?? null,
        pitchOscillationMedian: s.pitchOscillationMedian ?? null,
        pitchOscillationP90: s.pitchOscillationP90 ?? null,
        pitchOscillationSpans: s.pitchOscillationSpans ?? [],
        pitchOscillationRateMedian: s.pitchOscillationRateMedian ?? null,
        pitchOscillationNote: s.pitchOscillationNote ?? null,
        // 滑音和振荡是两条独立轨道，可以重叠
        pitchGlides: s.pitchGlides ?? [],
        voicedRatio: s.voicedRatio ?? null,
        silenceRatio: s.silenceRatio ?? null,
        dbMedian: s.dbMedian ?? null,
        duration: s.duration ?? null,
        transcript: s.transcript ?? null
      }
    })
    seen.add(key)
    added += 1
  }
  if (added > 0) writeLabels(existing)
  return { added, skipped: skipped.length ? skipped : undefined }
}

async function waitForBatch(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  return job
}

function batchToolResult(job, options = {}) {
  const payload = readBatchPayload(job)
  const records = payload && Array.isArray(payload.records) ? payload.records : []
  const includeRecords = options.includeRecords !== false
  let imported = null
  if (job.status === 'done' && options.importLabels !== false) {
    try {
      imported = importBatchLabels(job, payload)
    } catch (error) {
      imported = { added: 0, error: String(error && error.message ? error.message : error) }
    }
  }
  return {
    ok: job.status === 'done',
    batchId: job.id,
    status: job.status,
    stage: job.stage || null,
    dir: job.dir,
    labelFrom: job.labelFrom,
    total: payload ? payload.total : job.total,
    analyzed: payload ? payload.analyzed : job.analyzed,
    byLabel: payload ? payload.byLabel : job.byLabel,
    skipped: payload ? payload.skipped : [],
    records: includeRecords ? records : records.length,
    importedLabels: imported,
    outDir: job.outDir,
    reportPath: path.join(job.outDir, 'batch.md'),
    error: job.error || null,
    note: job.status === 'done' ? null : '批量导入仍在运行；用 toolbox_job({ id }) 查询。',
    log: job.log.slice(-15)
  }
}

const prosodyBatchTool = {
  name: 'prosody_batch',
  description:
    '批量导入一个文件夹里的音频：逐条跑本机韵律分析，按目录名或文件名推出语气标签，攒成"数字 ↔ 标签"的对照表。'
    + '认三种摆法：<dir>/催/001.m4a（目录名）、<dir>/催-001.m4a（文件名前缀）、<dir>/labels.csv（两列：文件名,标签）。'
    + '完成后默认把每条写进标注池（用 prosody_label 传 action:list 能查到），features 字段带上该条的全部韵律数字。'
    + '返回每个标签的条数和汇总；includeRecords=false 只返回统计不返回逐条。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '要导入的文件夹（绝对路径）。' },
      labelFrom: {
        type: 'string',
        enum: ['auto', 'directory', 'filename', 'csv'],
        description: '标签从哪来，默认 auto（优先 csv，其次目录名，再文件名前缀）。'
      },
      csv: { type: 'string', description: '标签 CSV 路径（可选，默认找目录里的 labels.csv）。' },
      dataset: { type: 'string', description: '这批样本属于哪个数据集，默认 tone（你自己的语气录音）。CASIA 之类的公开语料用 caisa 之类区分开。' },
      includeRecords: { type: 'boolean', description: '是否返回逐条特征，默认 true。' },
      importLabels: { type: 'boolean', description: '是否写进标注池，默认 true。' },
      waitSeconds: { type: 'integer', minimum: 10, maximum: 3600, description: '本次最多等多少秒，默认 600。' }
    },
    required: ['dir']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        batchId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        dir: { type: 'string' },
        labelFrom: { type: 'string' },
        total: { type: 'number' },
        analyzed: { type: 'number' },
        byLabel: { type: 'object' },
        skipped: { type: 'array' },
        records: { oneOf: [{ type: 'array' }, { type: 'number' }] },
        importedLabels: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        outDir: { type: 'string' },
        reportPath: { type: 'string' },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => {
      if (!value || value.status !== 'done') {
        return [{ type: 'text', text: '批量导入未完成（' + String((value && value.status) || '') + '）：' + String((value && (value.error || value.note)) || '') }]
      }
      const labels = value.byLabel || {}
      const parts = Object.keys(labels).map((k) => k + ' ' + labels[k]).join(' · ')
      return [{
        type: 'text',
        text: '批量导入完成：' + value.analyzed + '/' + value.total + ' 条，' + Object.keys(labels).length + ' 个标签\n'
          + parts + '\n'
          + (value.importedLabels ? '写入标注池 ' + (value.importedLabels.added || 0) + ' 条\n' : '')
          + '报告：' + value.reportPath
      }]
    }
  },
  async execute(args) {
    const dir = String((args && args.dir) || '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!dir) throw new Error('prosody_batch: 需要一个文件夹路径')
    if (!existsSync(dir)) throw new Error('prosody_batch: 找不到文件夹 ' + dir)
    const running = activeBatch()
    if (running) throw new Error('prosody_batch: 已有批量任务在跑（' + running.id + '），请用 toolbox_job({ id }) 查询')
    const labelFrom = ['auto', 'directory', 'filename', 'csv'].includes(args && args.labelFrom) ? args.labelFrom : 'auto'
    const waitSeconds = Math.max(10, Math.min(3600, Number(args && args.waitSeconds) || 600))
    const job = startBatch(dir, { labelFrom, csv: args && args.csv ? String(args.csv) : null, dataset: args && args.dataset ? String(args.dataset) : 'tone' })
    const finished = await waitForBatch(job, waitSeconds * 1000)
    return batchToolResult(finished, {
      includeRecords: !(args && args.includeRecords === false),
      importLabels: !(args && args.importLabels === false)
    })
  }
}


// ---------------------------------------------------------------------------
// 说话人聚类：一批音频 → 嵌入 → 聚类 → "大致有几个人"
// ---------------------------------------------------------------------------

const CLUSTER_SCRIPT = fileURLToPath(new URL('./lib/speaker_cluster.py', import.meta.url))
const CLUSTER_ROOT = process.env.XIYOUNG_CLUSTER_ROOT || path.join(TOOLBOX_HOME, 'clusters')

/** @type {Map<string, any>} */
const clusterJobs = new Map()

function activeCluster() {
  return [...clusterJobs.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function publicCluster(job) {
  return {
    id: job.id,
    kind: 'cluster',
    dir: job.dir,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    total: job.total || 0,
    analyzed: job.analyzed || 0,
    clusterCount: job.clusterCount || 0,
    outDir: job.outDir,
    log: job.log.slice(-120)
  }
}

function writeClusterMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify(publicCluster(job), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function appendClusterLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      if (text.startsWith('[cluster]')) {
        job.stage = text.replace(/^\[cluster\]\s*/, '')
        const found = text.match(/找到\s*(\d+)\s*个音频/)
        if (found) job.total = Number(found[1])
        const done = text.match(/^\[cluster\]\s*(\d+)\/(\d+)\s/)
        if (done) job.analyzed = Number(done[1])
      }
    },
  })
}

function startCluster(dir, options = {}) {
  const audioExt = /\.(wav|mp3|m4a|flac|ogg|opus|aac|wma|webm|mp4|mkv|mov|avi|flv|ts|m4v)$/i
  let audioCount = 0
  const countAudio = (d, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) countAudio(path.join(d, entry.name), depth + 1)
      else if (audioExt.test(entry.name)) audioCount += 1
    }
  }
  countAudio(dir)
  if (audioCount === 0) {
    throw new BadRequestError('这个文件夹里没有音频文件：' + dir)
  }
  if (audioCount < 2) {
    throw new BadRequestError('聚类至少要 2 条音频，这个文件夹只有 ' + audioCount + ' 条')
  }

  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(CLUSTER_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  let logStream = null
  try {
    logStream = createWriteStream(path.join(outDir, 'job.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const job = {
    id,
    kind: 'cluster',
    dir,
    outDir,
    status: 'running',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    total: audioCount,
    analyzed: 0,
    clusterCount: 0,
    log: [],
    child: null,
    logStream,
    finalized: false
  }
  clusterJobs.set(id, job)
  pruneMap(clusterJobs)
  writeClusterMeta(job)

  const args = [CLUSTER_SCRIPT, dir, '--outdir', outDir]
  const seed = Number(options.seed)
  if (Number.isFinite(seed) && seed > 0) args.push('--seed', String(seed))
  const merge = Number(options.merge)
  if (Number.isFinite(merge) && merge > 0) args.push('--merge', String(merge))

  const child = spawn(PYTHON, args, {
    cwd: CLUSTER_ROOT,
    env: pythonEnv(),
    windowsHide: true
  })
  job.child = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => appendClusterLog(job, chunk))
  child.stderr.on('data', (chunk) => appendClusterLog(job, chunk))
  child.on('error', (error) => {
    job.error = String(error && error.message ? error.message : error)
    finishCluster(job)
  })
  child.on('close', (code) => finishCluster(job, code === null ? 1 : code))
  return job
}

function finishCluster(job, code) {
  if (job.finalized) return
  job.finalized = true
  job.endedAt = Date.now()
  const jsonPath = path.join(job.outDir, 'clusters.json')
  let payload = null
  try {
    if (existsSync(jsonPath)) payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    payload = null
  }
  if (payload) {
    job.status = 'done'
    job.stage = '已完成'
    job.analyzed = payload.analyzed || 0
    job.clusterCount = payload.clusterCount || 0
  } else {
    job.status = 'error'
    job.stage = '失败'
    if (!job.error) {
      const reason = pickErrorLine(job.outDir)
      job.error = '没有生成 clusters.json' + (reason ? '\n原因：' + reason : '')
    }
    appendClusterLog(job, '[cluster] ' + job.error)
  }
  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* closed */
    }
    job.logStream = null
  }
  writeClusterMeta(job)
}

function readClusterPayload(job) {
  try {
    return JSON.parse(readFileSync(path.join(job.outDir, 'clusters.json'), 'utf8'))
  } catch {
    return null
  }
}

async function waitForCluster(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  return job
}

function clusterToolResult(job) {
  const payload = readClusterPayload(job)
  return {
    ok: job.status === 'done',
    clusterId: job.id,
    status: job.status,
    stage: job.stage || null,
    dir: job.dir,
    total: payload ? payload.total : job.total,
    analyzed: payload ? payload.analyzed : job.analyzed,
    clusterCount: payload ? payload.clusterCount : job.clusterCount,
    groups: payload ? payload.groups : [],
    skipped: payload ? payload.skipped : [],
    outDir: job.outDir,
    reportPath: path.join(job.outDir, 'clusters.md'),
    error: job.error || null,
    note: job.status === 'done' ? null : '聚类仍在运行；用 toolbox_job({ id }) 查询。',
    log: job.log.slice(-15)
  }
}

const COMPARE_SCRIPT = fileURLToPath(new URL('./lib/speaker_compare.py', import.meta.url))

/**
 * 两段音频的声纹比对。
 *
 * 这是一个**同步**工具（不走任务队列）：两段音频算嵌入只要几秒，
 * 没有排队/轮询的必要，直接返回结果更好用。
 */
const speakerCompareTool = {
  name: 'speaker_compare',
  description:
    '比两段音频是不是同一个人：算说话人嵌入，给原始余弦和去中心化余弦。'
    + '支持两个后端（backend 参数，或配置 speaker.backend）：\n'
    + '  auto（默认）——有 CAM++ 模型就用它，没有就退回 resemblyzer\n'
    + '  campplus——3D-Speaker 中文模型，192 维。实测异人基准低得多（0.26 vs 0.52），'
    + '  同人/异人比值 2.02 vs 1.44，判「不像」时可靠得多。需要 .onnx 模型文件\n'
    + '  resemblyzer——256 维，装了就能用，但有各向异性（raw 普遍虚高）\n'
    + '⚠️ 两个后端的 raw 坐标系完全不同，不能混用阈值：campplus 异人通常 0.1~0.4、'
    + '同人 0.4~0.8；resemblyzer 异人可到 0.5+。跨后端比较会被拒绝。\n'
    + '传 extra 多带几条音频一起比较，会用这批数据的均值做去中心化，判据更稳（rel 排位）。'
    + '只回答「像不像」，不做身份识别；不做男女/年龄判断。',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'string', description: '第一段音频：本地路径、直链或 B 站链接。' },
      b: { type: 'string', description: '第二段音频。' },
      extra: {
        type: 'array',
        items: { type: 'string' },
        description: '额外加入比较的音频（可选）。给了就用这批数据做去中心化基准，判据更稳；建议至少凑够 3 条。'
      },
      start: { type: 'number', description: '只取 a/b 的这一段：起点秒（可选）。' },
      duration: { type: 'number', description: '只取 a/b 的这一段：长度秒（可选）。' },
      backend: {
        type: 'string',
        enum: ['auto', 'resemblyzer', 'campplus'],
        description: '说话人嵌入用哪个模型，默认跟随配置（auto）。'
          + 'campplus 更准但需要 .onnx 模型文件；resemblyzer 装了就能用。'
          + 'auto = 有 CAM++ 就用，没有退回 resemblyzer。'
      }
    },
    required: ['a', 'b']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        backend: { type: 'string' },
        raw: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        centered: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        rankPercentile: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        verdictRaw: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        verdictRelative: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        caveats: { type: 'array' },
        baseline: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] }
      }
    },
    render: (_args, value) => {
      if (!value || !value.ok) {
        return [{ type: 'text', text: '声纹比对失败：' + String((value && value.error) || '未知原因') }]
      }
      const lines = []
      lines.push('原始相似度：' + (value.raw == null ? '—' : value.raw.toFixed(4))
        + (value.verdictRaw ? '（' + value.verdictRaw + '）' : ''))
      if (value.centered != null) {
        lines.push('去中心化：' + value.centered.toFixed(4)
          + (value.rankPercentile != null ? '，本批次排位 ' + Math.round(value.rankPercentile * 100) + '%' : ''))
      }
      if (value.verdictRelative) lines.push('结论：' + value.verdictRelative)
      if (value.relativeNote) lines.push('注：' + value.relativeNote)
      if (value.baseline && value.baseline.n) {
        lines.push('基准：n=' + value.baseline.n
          + '，中位 ' + (value.baseline.centeredMedian == null ? '—' : value.baseline.centeredMedian.toFixed(4))
          + '，P90 ' + (value.baseline.centeredP90 == null ? '—' : value.baseline.centeredP90.toFixed(4)))
      }
      for (const c of (value.caveats || [])) lines.push('! ' + c)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const a = String((args && args.a) || '').trim()
    const b = String((args && args.b) || '').trim()
    if (!a || !b) throw new Error('speaker_compare: 需要 a 和 b 两段音频')
    if (!existsSync(COMPARE_SCRIPT)) throw new Error('speaker_compare: 找不到 speaker_compare.py')

    const resolveOne = (raw) => {
      const parsed = normalizeSource(raw)
      if (!parsed) throw new Error('speaker_compare: 无法识别的来源：' + raw)
      if (parsed.kind === 'local' && !existsSync(parsed.path)) {
        throw new Error('speaker_compare: 找不到文件 ' + parsed.path)
      }
      return parsed.kind === 'local' ? parsed.path : parsed.url
    }

    const extra = []
    const rawExtra = args && Array.isArray(args.extra) ? args.extra : []
    for (const x of rawExtra) {
      if (x && String(x).trim()) extra.push(resolveOne(String(x).trim()))
    }

    const cmdArgs = [COMPARE_SCRIPT, resolveOne(a), resolveOne(b), '--json-only']
    for (const x of extra) cmdArgs.push('--extra', x)
    if (Number.isFinite(Number(args && args.start)) && args.start) {
      cmdArgs.push('--start', String(Number(args.start)))
    }
    if (Number.isFinite(Number(args && args.duration)) && args.duration) {
      cmdArgs.push('--duration', String(Number(args.duration)))
    }
    // backend：只有明确指定且不是 auto 时才传，auto 交给 python 自己按配置决定
    // （python 那边会看 XIYOUNG_SPEAKER_BACKEND 和模型文件是否存在）。
    const backendArg = args && args.backend ? String(args.backend).trim() : ''
    if (backendArg && backendArg !== 'auto') {
      if (!['resemblyzer', 'campplus'].includes(backendArg)) {
        throw new Error('speaker_compare: backend 只能是 auto / resemblyzer / campplus')
      }
      cmdArgs.push('--backend', backendArg)
    }

    const res = await runProcess(PYTHON, cmdArgs, () => {}, {})
    const text = String(res.tail || '').trim()
    // python 会先打印 "Loaded the voice encoder..."，真正的 JSON 在最后一行
    const lastLine = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
    if (!lastLine) {
      throw new Error('speaker_compare: 没有拿到结果（退出码 ' + res.code + '）' + (text ? '\n' + text.slice(-500) : ''))
    }
    let payload
    try {
      payload = JSON.parse(lastLine)
    } catch (e) {
      throw new Error('speaker_compare: 输出不是 JSON：' + lastLine.slice(0, 200))
    }
    if (!payload.ok) {
      throw new Error('speaker_compare: ' + String(payload.error || '失败'))
    }
    return payload
  }
}

const speakerClusterTool = {
  name: 'speaker_cluster',
  description:
    '把一批音频按说话人聚类，回答「这里面大致有几个人、哪几条像」。'
    + '用 Resemblyzer 算 256 维说话人嵌入，再按「种子分组 + 质心合并」聚类。'
    + '注意：这不做身份识别——不说「这是谁」，只说「哪几条像」；'
    + '声音相近的人会被并到一起（实测 CASIA 里 liuchanhg 与 zhaoquanyin 之间就有 0.717）。'
    + '需要先装 resemblyzer（pip install resemblyzer webrtcvad-wheels）。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '音频文件夹路径（至少 2 条）。' },
      seed: { type: 'number', description: '种子分组阈值，默认 0.82。调高会让分组更碎。' },
      merge: { type: 'number', description: '质心合并阈值，默认 0.75。调高会让分组更碎。' },
      waitSeconds: { type: 'integer', minimum: 10, maximum: 1800, description: '最多等多少秒，默认 300。' }
    },
    required: ['dir']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        clusterId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        dir: { type: 'string' },
        total: { type: 'number' },
        analyzed: { type: 'number' },
        clusterCount: { type: 'number' },
        groups: { type: 'array' },
        skipped: { type: 'array' },
        outDir: { type: 'string' },
        reportPath: { type: 'string' },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => {
      if (!value || !value.ok) {
        return [{ type: 'text', text: '聚类未完成（' + String((value && value.status) || '') + '）：' + String((value && (value.error || value.note)) || '') }]
      }
      const lines = [
        '聚类完成：' + value.analyzed + ' 条音频，聚成 ' + value.clusterCount + ' 组',
        ''
      ]
      for (let i = 0; i < value.groups.length; i++) {
        const g = value.groups[i]
        const coh = g.cohesion !== null ? '组内相似度 ' + g.cohesion : '单条'
        lines.push('组 ' + (i + 1) + '（' + g.size + ' 条，' + coh + '）')
        for (const f of g.files) lines.push('  · ' + f)
      }
      lines.push('')
      lines.push('注意：这只是在说「哪几条像」，不是「这是谁」。')
      lines.push('报告：' + value.reportPath)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const dir = String((args && args.dir) || '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!dir) throw new Error('speaker_cluster: 需要一个文件夹路径')
    if (!existsSync(dir)) throw new Error('speaker_cluster: 找不到文件夹 ' + dir)
    const running = activeCluster()
    if (running) throw new Error('speaker_cluster: 已有聚类在跑（' + running.id + '），请用 toolbox_job({ id }) 查询')
    const waitSeconds = Math.max(10, Math.min(1800, Number(args && args.waitSeconds) || 300))
    const job = startCluster(dir, { seed: args && args.seed, merge: args && args.merge })
    const finished = await waitForCluster(job, waitSeconds * 1000)
    return clusterToolResult(finished)
  }
}


// ---------------------------------------------------------------------------
// 单条音频的说话人分离
// ---------------------------------------------------------------------------

const DIARIZE_SCRIPT = fileURLToPath(new URL('./lib/speaker_diarize.py', import.meta.url))
const DIARIZE_ROOT = process.env.XIYOUNG_DIARIZE_ROOT || path.join(TOOLBOX_HOME, 'diarize')

/** @type {Map<string, any>} */
const diarizeJobs = new Map()

function activeDiarize() {
  return [...diarizeJobs.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function publicDiarize(job) {
  return {
    id: job.id,
    kind: 'diarize',
    source: job.source,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    speakerCount: job.speakerCount || 0,
    outDir: job.outDir,
    log: job.log.slice(-120)
  }
}

function writeDiarizeMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify(publicDiarize(job), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function appendDiarizeLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      if (text.startsWith('[diar]')) job.stage = text.replace(/^\[diar\]\s*/, '')
      const sc = text.match(/聚类:\s*(\d+)\s*组/)
      if (sc) job.speakerCount = Number(sc[1])
    },
  })
}

function startDiarize(source, options = {}) {
  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(DIARIZE_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  let logStream = null
  try {
    logStream = createWriteStream(path.join(outDir, 'job.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const job = {
    id,
    kind: 'diarize',
    source,
    outDir,
    status: 'running',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    speakerCount: 0,
    log: [],
    child: null,
    logStream,
    finalized: false
  }
  diarizeJobs.set(id, job)
  pruneMap(diarizeJobs)
  writeDiarizeMeta(job)

  const args = [DIARIZE_SCRIPT, source, '--outdir', outDir]
  const window = Number(options.window)
  if (Number.isFinite(window) && window > 0) args.push('--window', String(window))

  const child = spawn(PYTHON, args, {
    cwd: DIARIZE_ROOT,
    env: pythonEnv(),
    windowsHide: true
  })
  job.child = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => appendDiarizeLog(job, chunk))
  child.stderr.on('data', (chunk) => appendDiarizeLog(job, chunk))
  child.on('error', (error) => {
    job.error = String(error && error.message ? error.message : error)
    finishDiarize(job)
  })
  child.on('close', (code) => finishDiarize(job, code === null ? 1 : code))
  return job
}

function finishDiarize(job, code) {
  if (job.finalized) return
  job.finalized = true
  job.endedAt = Date.now()
  const jsonPath = path.join(job.outDir, 'diarization.json')
  let payload = null
  try {
    if (existsSync(jsonPath)) payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    payload = null
  }
  if (payload) {
    job.status = 'done'
    job.stage = '已完成'
    job.speakerCount = payload.speakerCount || 0
  } else {
    job.status = 'error'
    job.stage = '失败'
    if (!job.error) {
      const reason = pickErrorLine(job.outDir)
      job.error = '没有生成 diarization.json' + (reason ? '\n原因：' + reason : '')
    }
    appendDiarizeLog(job, '[diar] ' + job.error)
  }
  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* closed */
    }
    job.logStream = null
  }
  writeDiarizeMeta(job)
}

function readDiarizePayload(job) {
  try {
    return JSON.parse(readFileSync(path.join(job.outDir, 'diarization.json'), 'utf8'))
  } catch {
    return null
  }
}

async function waitForDiarize(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  return job
}

function diarizeToolResult(job) {
  const payload = readDiarizePayload(job)
  return {
    ok: job.status === 'done',
    diarizeId: job.id,
    status: job.status,
    stage: job.stage || null,
    source: job.source,
    duration: payload ? payload.duration : null,
    speakerCount: payload ? payload.speakerCount : job.speakerCount,
    groups: payload ? payload.groups : [],
    segments: payload ? payload.segments : [],
    outDir: job.outDir,
    reportPath: path.join(job.outDir, 'diarization.md'),
    error: job.error || null,
    note: job.status === 'done' ? null : '分离仍在运行；用 toolbox_job({ id }) 查询。',
    log: job.log.slice(-15)
  }
}

const speakerDiarizeTool = {
  name: 'speaker_diarize',
  description:
    '把一条音频里的说话人分开，回答「这段录音里有几个人、各说了哪段」。'
    + '⚠️ 这个结果不可靠，用前先看 caveats：Resemblyzer 嵌入在短句/单声道低码率音频上区分力很差，'
    + '实测同人相似度 0.79、不同人 0.75，只差 0.04。真实 2 人对话会被判成 1 人，单人录音会被判成 2 人。'
    + '当 caveats 非空时，speakerCount 不能当作「有几个人」的答案。'
    + '用 Resemblyzer 按 2 秒非重叠窗算嵌入，再聚类，最后合并相邻同簇的窗成段。'
    + '局限：窗长 2 秒，说话人切换点有 ±1 秒误差；'
    + '音频短于 10 秒时窗太少，可能把相邻两段合并或把一段拆开；'
    + '这不做身份识别，只说「有几个人、哪几段」，不说「这是谁」。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '音频/视频路径、直链或 B 站链接。' },
      window: { type: 'number', description: '窗长秒数，默认 2.0。小于 1.5 嵌入会不稳（实测）。' },
      waitSeconds: { type: 'integer', minimum: 10, maximum: 1800, description: '最多等多少秒，默认 300。' }
    },
    required: ['source']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        diarizeId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        source: { type: 'string' },
        duration: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        speakerCount: { type: 'number' },
        groups: { type: 'array' },
        segments: { type: 'array' },
        outDir: { type: 'string' },
        reportPath: { type: 'string' },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => {
      if (!value || !value.ok) {
        return [{ type: 'text', text: '说话人分离未完成（' + String((value && value.status) || '') + '）：' + String((value && (value.error || value.note)) || '') }]
      }
      const lines = [
        '说话人分离完成：' + (value.duration || 0).toFixed(1) + ' 秒，分出 ' + value.speakerCount + ' 个声音',
        ''
      ]
      for (const seg of value.segments || []) {
        lines.push('  ' + seg.start.toFixed(2) + 's – ' + seg.end.toFixed(2) + 's  说话人 ' + (seg.speaker + 1))
      }
      lines.push('')
      lines.push('注意：窗长 2 秒，切换点有 ±1 秒误差；短音频可能合并或拆开。')
      lines.push('报告：' + value.reportPath)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const raw = String((args && args.source) || '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!raw) throw new Error('speaker_diarize: 需要一个音频路径、直链或 B 站链接')
    const parsed = normalizeSource(raw)
    if (!parsed) throw new Error('speaker_diarize: 无法识别的来源：' + raw)
    if (parsed.kind === 'local' && !existsSync(parsed.path)) {
      throw new Error('speaker_diarize: 找不到文件 ' + parsed.path)
    }
    const running = activeDiarize()
    if (running) throw new Error('speaker_diarize: 已有分离在跑（' + running.id + '），请用 toolbox_job({ id }) 查询')
    const waitSeconds = Math.max(10, Math.min(1800, Number(args && args.waitSeconds) || 300))
    const job = startDiarize(parsed.kind === 'local' ? parsed.path : parsed.url, { window: args && args.window })
    const finished = await waitForDiarize(job, waitSeconds * 1000)
    return diarizeToolResult(finished)
  }
}


// ---------------------------------------------------------------------------
// 特征判别力评测：这批数字到底能不能分开人/情绪
// ---------------------------------------------------------------------------

const BENCH_SCRIPT = fileURLToPath(new URL('./lib/benchmark.py', import.meta.url))
const BENCH_ROOT = process.env.XIYOUNG_BENCH_ROOT || path.join(TOOLBOX_HOME, 'bench')

/** @type {Map<string, any>} */
const benchJobs = new Map()

function activeBench() {
  return [...benchJobs.values()].find((job) => job.status === 'running' || job.status === 'queued')
}

function publicBench(job) {
  return {
    id: job.id,
    kind: 'bench',
    dir: job.dir,
    feature: job.feature,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    error: job.error || null,
    samples: job.samples || 0,
    outDir: job.outDir,
    log: job.log.slice(-120)
  }
}

function writeBenchMeta(job) {
  try {
    writeFileSync(path.join(job.outDir, 'job.json'), JSON.stringify(publicBench(job), null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

function appendBenchLog(job, chunk) {
  pumpLog(job, chunk, {
    onLine(text) {
      if (text.startsWith('[bench]')) {
        job.stage = text.replace(/^\[bench\]\s*/, '')
        const m = text.match(/采样\s*(\d+)\s*条/)
        if (m) job.samples = Number(m[1])
      }
    },
  })
}

function startBench(dir, options = {}) {
  const audioExt = /\.(wav|mp3|m4a|flac|ogg|opus|aac|wma|mp4|mkv|mov|avi)$/i
  let count = 0
  const walk = (d, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1)
      else if (audioExt.test(e.name)) count += 1
    }
  }
  walk(dir)
  if (count < 4) {
    throw new BadRequestError('评测至少要 4 条音频，这个文件夹有 ' + count + ' 条')
  }

  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
  const outDir = path.join(BENCH_ROOT, id)
  mkdirSync(outDir, { recursive: true })
  let logStream = null
  try {
    logStream = createWriteStream(path.join(outDir, 'job.log'), { flags: 'a' })
    logStream.on('error', () => {})
  } catch {
    logStream = null
  }

  const feature = ['all', 'rhythm', 'mfcc', 'embedding'].includes(options.feature) ? options.feature : 'all'
  const job = {
    id,
    kind: 'bench',
    dir,
    feature,
    outDir,
    status: 'running',
    stage: '准备中',
    createdAt: Date.now(),
    endedAt: null,
    error: null,
    samples: 0,
    log: [],
    child: null,
    logStream,
    finalized: false
  }
  benchJobs.set(id, job)
  pruneMap(benchJobs)
  writeBenchMeta(job)

  const args = [BENCH_SCRIPT, dir, '--outdir', outDir, '--feature', feature]
  const limit = Number(options.limitPerLabel)
  if (Number.isFinite(limit) && limit > 0) args.push('--limit-per-label', String(limit))

  const child = spawn(PYTHON, args, {
    cwd: BENCH_ROOT,
    env: pythonEnv(),
    windowsHide: true
  })
  job.child = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => appendBenchLog(job, chunk))
  child.stderr.on('data', (chunk) => appendBenchLog(job, chunk))
  child.on('error', (error) => {
    job.error = String(error && error.message ? error.message : error)
    finishBench(job)
  })
  child.on('close', (code) => finishBench(job, code === null ? 1 : code))
  return job
}

function finishBench(job, code) {
  if (job.finalized) return
  job.finalized = true
  job.endedAt = Date.now()
  const jsonPath = path.join(job.outDir, 'benchmark.json')
  let payload = null
  try {
    if (existsSync(jsonPath)) payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    payload = null
  }
  if (payload) {
    job.status = 'done'
    job.stage = '已完成'
    job.samples = payload.samples || job.samples
  } else {
    job.status = 'error'
    job.stage = '失败'
    if (!job.error) {
      const reason = pickErrorLine(job.outDir)
      job.error = '没有生成 benchmark.json' + (reason ? '\n原因：' + reason : '')
    }
    appendBenchLog(job, '[bench] ' + job.error)
  }
  if (job.logStream) {
    try {
      job.logStream.end()
    } catch {
      /* closed */
    }
    job.logStream = null
  }
  writeBenchMeta(job)
}

function readBenchPayload(job) {
  try {
    return JSON.parse(readFileSync(path.join(job.outDir, 'benchmark.json'), 'utf8'))
  } catch {
    return null
  }
}

async function waitForBench(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (job.status === 'done' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
  return job
}

function benchToolResult(job) {
  const payload = readBenchPayload(job)
  return {
    ok: job.status === 'done',
    benchId: job.id,
    status: job.status,
    stage: job.stage || null,
    dir: job.dir,
    samples: payload ? payload.samples : job.samples,
    labels: payload ? payload.labels : [],
    results: payload ? payload.results : {},
    outDir: job.outDir,
    reportPath: path.join(job.outDir, 'benchmark.md'),
    error: job.error || null,
    note: job.status === 'done' ? null : '评测仍在运行；用 toolbox_job({ id }) 查询。',
    log: job.log.slice(-15)
  }
}

const benchTool = {
  name: 'toolbox_benchmark',
  description:
    '评测特征判别力：这批数字到底能不能分开人/情绪？'
    + '给一个带标签的文件夹（子目录名 = 标签），跑三个任务：'
    + '分标签（N 选 1）、判同标签（2 选 1，用平衡准确率）、距离间隔。'
    + '对比三档特征：韵律 6 维 / MFCC 13 维 / 说话人嵌入 256 维。'
    + '每项都给随机基线——**分标签准确率接近基线就说明分不开**。'
    + '注意：判同标签必须看平衡准确率，总准确率会被类别不平衡骗到。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '带标签的文件夹（子目录名 = 标签）。' },
      feature: {
        type: 'string',
        enum: ['all', 'rhythm', 'mfcc', 'embedding'],
        description: '测哪档特征，默认 all（三档都测）。'
      },
      limitPerLabel: { type: 'integer', description: '每个标签最多取几条，默认 40。' },
      waitSeconds: { type: 'integer', minimum: 30, maximum: 3600, description: '最多等多少秒，默认 600。' }
    },
    required: ['dir']
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        benchId: { type: 'string' },
        status: { type: 'string' },
        stage: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        dir: { type: 'string' },
        samples: { type: 'number' },
        labels: { type: 'array' },
        results: { type: 'object' },
        outDir: { type: 'string' },
        reportPath: { type: 'string' },
        error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        log: { type: 'array' }
      }
    },
    render: (_args, value) => {
      if (!value || !value.ok) {
        return [{ type: 'text', text: '评测未完成（' + String((value && value.status) || '') + '）：' + String((value && (value.error || value.note)) || '') }]
      }
      const lines = [
        '评测完成：' + value.samples + ' 条，' + (value.labels || []).length + ' 个标签',
        '',
        '特征'.padEnd(22) + '分标签'.padEnd(10) + '随机'.padEnd(8) + '判同标签'.padEnd(10) + '距离差',
        ''
      ]
      const names = { rhythm: '韵律 6 维', mfcc: 'MFCC 13 维', embedding: '嵌入 256 维' }
      for (const key of ['rhythm', 'mfcc', 'embedding']) {
        const r = value.results[key]
        if (!r) continue
        lines.push(
          (names[key] || key).padEnd(20) +
          (r.labelAcc + '%').padEnd(10) +
          (r.labelBaseline + '%').padEnd(8) +
          (r.sameBalanced + '%').padEnd(10) +
          (r.gap !== null ? r.gap.toFixed(3) : '-')
        )
      }
      lines.push('')
      lines.push('判读：分标签准确率接近随机基线 → 分不开；判同标签接近 50% → 没判别力。')
      lines.push('报告：' + value.reportPath)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  },
  async execute(args) {
    const dir = String((args && args.dir) || '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!dir) throw new Error('toolbox_benchmark: 需要一个文件夹路径')
    if (!existsSync(dir)) throw new Error('toolbox_benchmark: 找不到文件夹 ' + dir)
    const running = activeBench()
    if (running) throw new Error('toolbox_benchmark: 已有评测在跑（' + running.id + '），请用 toolbox_job({ id }) 查询')
    const waitSeconds = Math.max(30, Math.min(3600, Number(args && args.waitSeconds) || 600))
    const job = startBench(dir, {
      feature: args && args.feature,
      limitPerLabel: args && args.limitPerLabel
    })
    const finished = await waitForBench(job, waitSeconds * 1000)
    return benchToolResult(finished)
  }
}

function loadHistory() {
  try {
    const entries = readdirSync(WORK_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let mtime = 0
        try {
          mtime = statSync(path.join(WORK_ROOT, entry.name)).mtimeMs
        } catch {
          mtime = 0
        }
        return { name: entry.name, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_JOBS())

    for (const entry of entries.reverse()) {
      if (jobs.has(entry.name)) continue
      const outDir = path.join(WORK_ROOT, entry.name)
      const metaPath = path.join(outDir, 'job.json')
      let meta = {}
      try {
        if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      } catch {
        meta = {}
      }

      const result = buildJobResult({ outDir })
      const reportExists = existsSync(result.reportPath)
      let status = meta.status || (reportExists ? 'done' : 'error')
      if ((status === 'running' || status === 'queued') && reportExists) status = 'done'
      if ((status === 'running' || status === 'queued') && !reportExists) {
        status = 'error'
        if (!meta.error) meta.error = '上次运行被中断'
      }
      if (status === 'done' && !reportExists) status = 'error'
      if (status === 'error' && !meta.error) meta.error = '上次运行未生成报告'

      const logPath = path.join(outDir, 'job.log')
      let log = []
      try {
        if (existsSync(logPath)) log = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_LOG())
      } catch {
        log = []
      }

      const job = {
        id: entry.name,
        url: meta.url || '',
        model: meta.model || null,
        summary: meta.summary !== false,
        outDir,
        status,
        stage: status === 'done' ? '已完成' : '失败',
        createdAt: meta.createdAt || entry.mtime,
        startedAt: meta.startedAt || null,
        endedAt: meta.endedAt || null,
        error: meta.error || null,
        log,
        done: result.analyzed,
        total: result.total,
        seen: new Set(),
        result,
        finalized: true,
        child: null,
        logStream: null
      }
      jobs.set(entry.name, job)
    }
  } catch {
    /* history is best effort */
  }
}

/**
 * 探测 python 侧的关键依赖能不能 import。
 *
 * 为什么必须真探测：PATH 里可能有多个 python，系统那个往往没装 librosa。
 * 光看"python 不存在"不够，光看"python 存在"也不够——得实际 import 一次。
 *
 * 结果缓存 60 秒：doctor 可能被连续调用，每次起 python 要 1-2 秒。
 */
let _pyDepsCache = { at: 0, value: null }

function probePythonDeps() {
  const now = Date.now()
  if (_pyDepsCache.value && now - _pyDepsCache.at < 60000) {
    return _pyDepsCache.value
  }
  const value = {}
  for (const mod of ['numpy', 'librosa', 'soundfile', 'scipy']) {
    try {
      const r = spawnSync(PYTHON, ['-c', 'import ' + mod], {
        timeout: 20000,
        windowsHide: true,
        encoding: 'utf8',
      })
      value[mod] = { ok: r.status === 0, err: r.status === 0 ? null : String(r.stderr || '').slice(0, 120) }
    } catch (e) {
      value[mod] = { ok: false, err: String(e && e.message ? e.message : e).slice(0, 120) }
    }
  }
  _pyDepsCache = { at: now, value }
  return value
}

/**
 * 探测环境：依赖在不在、模型可不可用、各部分占多少磁盘。
 *
 * health 端点和 toolbox_doctor 共用这一份，避免两套逻辑漂移。
 * （之前页面底部显示的和工具能查到的如果不一样，排查会互相矛盾。）
 */
async function collectHealth() {
  let models = []
  let slowModels = []
  let ollamaOK = false
  // 并发建议：靠"模型有多少进了显存"判断。
  // 全进显存 → 并发有意义；GPU/CPU 混合 → 并发会互相争抢。
  let gpuFit = null
  const currentModel = String(resolveModel())
  try {
    const psRes = await fetch(OLLAMA() + '/api/ps', { signal: AbortSignal.timeout(2500) })
    const psData = await psRes.json()
    const loaded = (psData.models || []).find((m) => m.name === currentModel)
    if (loaded && loaded.size > 0) {
      const ratio = (loaded.size_vram || 0) / loaded.size
      gpuFit = {
        model: loaded.name,
        sizeGB: Math.round((loaded.size / 1e9) * 100) / 100,
        vramGB: Math.round(((loaded.size_vram || 0) / 1e9) * 100) / 100,
        vramRatio: Math.round(ratio * 100),
        suggestedConcurrency: ratio >= 0.9 ? 3 : 1,
        note: ratio >= 0.9
          ? '模型基本全在显存里，可以试 2-3 并发'
          : '模型只有部分进显存（GPU/CPU 混合），并发可能反而变慢，建议保持 1',
      }
    }
  } catch {
    gpuFit = null
  }
  try {
    const response = await fetch(OLLAMA() + '/api/tags', { signal: AbortSignal.timeout(2500) })
    const data = await response.json()
    const visionModels = (data.models || [])
      .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes('vision'))
      .map((model) => model.name)
    slowModels = visionModels.filter((name) => SLOW_MODELS().has(name))
    models = visionModels
      .filter((name) => !SLOW_MODELS().has(name))
      .sort((a, b) => (b === 'qwen3.5:4b') - (a === 'qwen3.5:4b'))
    ollamaOK = true
  } catch {
    ollamaOK = false
  }
  return {
    ok: true,
    python: PYTHON,
    pythonExists: PYTHON.includes('/') || PYTHON.includes('\\') ? existsSync(PYTHON) : true,
    script: SCRIPT,
    scriptExists: existsSync(SCRIPT),
    ffmpeg: FFMPEG,
    ffmpegExists: Boolean(FFMPEG),
    ytdlp: YTDLP,
    ytdlpExists: Boolean(YTDLP),
    dshHome: DSH_HOME,
    toolboxHome: TOOLBOX_HOME,
    workRoot: WORK_ROOT,
    clipRoot: CLIP_ROOT,
    ffprobe: FFPROBE,
    ffprobeExists: Boolean(FFPROBE),
    clipFormats: ['mp4', 'mp3'],
    prosodyRoot: PROSODY_ROOT,
    prosodyScript: PROSODY_SCRIPT,
    prosodyScriptExists: existsSync(PROSODY_SCRIPT),
    labelFile: LABELS_FILE,
    batchRoot: BATCH_ROOT,
    batchScript: BATCH_SCRIPT,
    batchScriptExists: existsSync(BATCH_SCRIPT),
    clusterRoot: CLUSTER_ROOT,
    clusterScript: CLUSTER_SCRIPT,
    clusterScriptExists: existsSync(CLUSTER_SCRIPT),
    diarizeRoot: DIARIZE_ROOT,
    diarizeScript: DIARIZE_SCRIPT,
    diarizeScriptExists: existsSync(DIARIZE_SCRIPT),
    benchRoot: BENCH_ROOT,
    benchScript: BENCH_SCRIPT,
    benchScriptExists: existsSync(BENCH_SCRIPT),
    speakerModelAvailable: probeResemblyzer(),
    model: currentModel,
    ollama: OLLAMA(),
    ollamaOK,
    gpuFit,
    models,
    slowModels
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn('xiyoungtools: this DSH has no webServer service; the toolbox routes stay unmounted')
    return
  }

  migrateLegacyHome()
  fixLegacyPathsInRecords()

  try {
    mkdirSync(WORK_ROOT, { recursive: true })
  } catch (error) {
    console.warn('xiyoungtools: could not create the runs directory', error)
  }
  try {
    mkdirSync(CLIP_ROOT, { recursive: true })
  } catch (error) {
    console.warn('xiyoungtools: could not create the clips directory', error)
  }
  try {
    mkdirSync(PROSODY_ROOT, { recursive: true })
    mkdirSync(LABEL_ROOT, { recursive: true })
    mkdirSync(BATCH_ROOT, { recursive: true })
    mkdirSync(CLUSTER_ROOT, { recursive: true })
    mkdirSync(DIARIZE_ROOT, { recursive: true })
    mkdirSync(BENCH_ROOT, { recursive: true })
    mkdirSync(ANALYZE_ROOT, { recursive: true })
  } catch (error) {
    console.warn('xiyoungtools: could not create the prosody directory', error)
  }
  loadHistory()
  loadClips()
  loadProsodies()
  loadBatches()
  loadAnalyzes()

  const register = (routePath, handler, label) => {
    const dispose = webServer.register({ kind: 'exact', path: routePath, handler })
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, label)
  }



  // 扫描模型后端有哪些可用模型。给配置界面做下拉框用。
  register('/xiyoungtools/models', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const script = fileURLToPath(new URL('./lib/list_models.py', import.meta.url))
      if (!existsSync(script)) {
        return sendJson(res, 500, { error: 'list_models.py 不存在' })
      }
      const run = () => {
        const out = spawnSync(PYTHON, [script], {
          cwd: TOOLBOX_HOME,
          env: pythonEnv(),
          timeout: 20000,
          windowsHide: true,
          encoding: 'utf8',
        })
        if (out.error) return { ok: false, models: [], error: String(out.error.message || out.error) }
        const stdout = String(out.stdout || '').trim()
        if (!stdout) {
          return { ok: false, models: [], error: '扫描没有输出' + (out.stderr ? '：' + String(out.stderr).slice(0, 300) : '') }
        }
        try {
          return JSON.parse(stdout.split('\n').pop())
        } catch {
          return { ok: false, models: [], error: '返回不是 JSON：' + stdout.slice(0, 200) }
        }
      }
      const result = run()
      return sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, models: [], error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/config', async (req, res) => {
    if (req.method === 'GET') {
      const current = getConfig(true)
      const file = readConfigFile()
      return sendJson(res, 200, {
        config: current,
        // 只回用户显式设过的值，别把默认值全吐出来
        userOverrides: file.data || {},
        configPath: CONFIG_PATH,
        configExists: file.exists,
        configError: file.error || null,
        presets: Object.keys(PRESETS).map((k) => ({
          key: k,
          label: PRESETS[k].label,
          note: PRESETS[k].note,
        })),
      })
    }
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        if (body.reset) {
          // 重置：删掉配置文件
          try {
            if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH)
          } catch (err) {
            return sendJson(res, 500, { error: '删除配置失败：' + String(err && err.message ? err.message : err) })
          }
          configCache = null
          return sendJson(res, 200, { ok: true, reset: true, config: getConfig(true) })
        }
        if (body.preset !== undefined) {
          const name = body.preset === null ? null : String(body.preset)
          if (name && !PRESETS[name]) {
            return sendJson(res, 400, { error: '没有这个预设：' + name + '（可选：' + Object.keys(PRESETS).join(' / ') + '）' })
          }
          saveConfig({ preset: name })
          const fileAfter = readConfigFile()
          const shadowed = name ? findPresetShadowed(name, fileAfter.data || {}) : []
          return sendJson(res, 200, {
            ok: true,
            config: getConfig(true),
            shadowed,
            note: shadowed.length
              ? '预设已应用，但这 ' + shadowed.length + ' 项被你之前的手动设置覆盖了：'
                + shadowed.map((s) => s.path + '=' + s.userValue).join(', ')
                + '。想让预设完全生效，先重置或把这些项改回预设值。'
              : null,
          })
        }
        if (body.patch && typeof body.patch === 'object') {
          // 校验分组 **和字段**：只查分组的话，写错字段名（maxSheet 少个 s）会
          // 顺利写进文件、返回 200、然后无声失效——正是这段注释想防的事。
          for (const [group, values] of Object.entries(body.patch)) {
            const defaults = BUILTIN_DEFAULTS[group]
            if (!defaults) {
              return sendJson(res, 400, { error: '未知配置分组：' + group + '（可选：' + Object.keys(BUILTIN_DEFAULTS).join(' / ') + '）' })
            }
            if (!values || typeof values !== 'object' || Array.isArray(values)) {
              return sendJson(res, 400, { error: '配置分组 ' + group + ' 的值必须是对象' })
            }
            const knownFields = Object.keys(defaults)
            for (const field of Object.keys(values)) {
              if (!knownFields.includes(field)) {
                return sendJson(res, 400, {
                  error: '未知配置项：' + group + '.' + field + '（' + group + ' 可用：' + knownFields.join(' / ') + '）'
                })
              }
            }
          }
          saveConfig(body.patch)
          return sendJson(res, 200, { ok: true, config: getConfig(true) })
        }
        return sendJson(res, 400, { error: '需要 patch / preset / reset 之一' })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    sendJson(res, 405, { error: 'method not allowed' })
  })

  register('/xiyoungtools/health', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    sendJson(res, 200, await collectHealth())
  })

  register('/xiyoungtools/video-watch', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const input = normalizeInput(body.url)
      if (!input) return sendJson(res, 400, { error: '请输入 B 站视频链接或 BV 号' })
      if (!isAllowedHost(input)) return sendJson(res, 400, { error: '目前只支持 bilibili.com / b23.tv 的链接' })
      const running = activeJob()
      if (running) return sendJson(res, 409, { error: '已有任务在跑，请等它结束', jobId: running.id })
      // 时间段先做一次浅校验，避免明显错误的任务白跑一趟下载
      const start = body.start !== undefined && String(body.start).trim() !== '' ? String(body.start).trim() : null
      const end = body.end !== undefined && String(body.end).trim() !== '' ? String(body.end).trim() : null
      if (start && end) {
        const s = timeToSeconds(start)
        const e = timeToSeconds(end)
        if (s !== null && e !== null && e <= s) {
          return sendJson(res, 400, { error: '结束时间必须晚于起始时间', code: 'bad_range' })
        }
      }
      const job = startJob(input, {
        model: body.model,
        summary: body.summary,
        interval: body.interval,
        maxSheets: body.maxSheets,
        height: body.height,
        start: start || undefined,
        end: end || undefined,
        duration: body.duration
      })
      sendJson(res, 200, { jobId: job.id })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/cancel', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const job = jobs.get(body.id || '')
      if (!job) return sendJson(res, 404, { error: 'job not found' })
      if (job.status !== 'running' && job.status !== 'queued') {
        return sendJson(res, 400, { error: '这个任务已经结束' })
      }
      job.error = '已取消'
      job.stage = '取消中'
      appendLog(job, '[toolbox] 用户取消任务')
      try {
        if (job.child && typeof job.child.kill === 'function') job.child.kill()
      } catch {
        /* best effort */
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/job', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = jobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'job not found' })
    sendJson(res, 200, publicJob(job))
  })

  register('/xiyoungtools/jobs', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...jobs.values()].map(publicJob).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { jobs: list })
  })

  register('/xiyoungtools/report', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = jobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'job not found' })
    try {
      sendJson(res, 200, readJobReport(job))
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/sheet', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = jobs.get(url.searchParams.get('id') || '')
    const file = url.searchParams.get('file') || ''
    if (!job) return sendJson(res, 404, { error: 'job not found' })
    if (!/^sheet_\d+\.jpg$/.test(file)) return sendJson(res, 400, { error: 'bad file name' })
    const sheetPath = path.join(job.outDir, 'sheets', file)
    if (!existsSync(sheetPath)) return sendJson(res, 404, { error: 'sheet not found' })
    try {
      const bytes = readFileSync(sheetPath)
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
      res.end(bytes)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/file', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = jobs.get(url.searchParams.get('id') || '')
    const file = url.searchParams.get('name') || ''
    if (!job) return sendJson(res, 404, { error: 'job not found' })
    if (file !== 'report.md' && file !== 'summary.md') return sendJson(res, 400, { error: 'bad file name' })
    const filePath = path.join(job.outDir, file)
    if (!existsSync(filePath)) return sendJson(res, 404, { error: 'file not found' })
    try {
      const text = readFileSync(filePath, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="' + file + '"',
        'cache-control': 'no-store'
      })
      res.end(text)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })


  register('/xiyoungtools/clip', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const prepared = prepareClipRequest(body)
        if (prepared.error) return sendJson(res, 400, { error: prepared.error })
        const clip = startClip(prepared.options)
        return sendJson(res, 200, { clipId: clip.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const clip = clips.get(url.searchParams.get('id') || '')
    if (!clip) return sendJson(res, 404, { error: 'clip not found' })
    sendJson(res, 200, publicClip(clip))
  })

  register('/xiyoungtools/clips', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...clips.values()].map(publicClip).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { clips: list })
  })

  register('/xiyoungtools/clip-cancel', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const clip = clips.get(body.id || '')
      if (!clip) return sendJson(res, 404, { error: 'clip not found' })
      if (clip.status !== 'running' && clip.status !== 'queued') {
        return sendJson(res, 400, { error: '这个任务已经结束' })
      }
      clip.error = '已取消'
      clip.stage = '取消中'
      appendClipLog(clip, '[clip] 用户取消任务')
      try {
        if (clip.child && typeof clip.child.kill === 'function') clip.child.kill()
      } catch {
        /* best effort */
      }
      finishClip(clip)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/clip-file', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const clip = clips.get(url.searchParams.get('id') || '')
    if (!clip) return sendJson(res, 404, { error: 'clip not found' })
    if (!clip.outputPath || !existsSync(clip.outputPath)) return sendJson(res, 404, { error: 'file not found' })
    const name = clip.outputName || path.basename(clip.outputPath)
    const type = path.extname(name).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'video/mp4'
    try {
      const bytes = readFileSync(clip.outputPath)
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(bytes.length),
        'content-disposition': 'attachment; filename="' + name.replace(/"/g, '') + '"',
        'cache-control': 'no-store'
      })
      res.end(bytes)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/clip-preview', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const clip = clips.get(url.searchParams.get('id') || '')
    if (!clip) return sendJson(res, 404, { error: 'clip not found' })
    if (!clip.outputPath || !existsSync(clip.outputPath)) return sendJson(res, 404, { error: 'file not found' })
    try {
      const bytes = readFileSync(clip.outputPath)
      const type = path.extname(clip.outputPath).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'video/mp4'
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(bytes.length),
        'accept-ranges': 'none',
        'cache-control': 'no-store'
      })
      res.end(bytes)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })


  register('/xiyoungtools/prosody', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const raw = String(body.source || '').trim().replace(/^"(.*)"$/, '$1').trim()
        if (!raw) return sendJson(res, 400, { error: '请填写本地文件路径、直链或 B 站链接' })
        const parsed = normalizeSource(raw)
        if (!parsed) return sendJson(res, 400, { error: '无法识别的来源：' + raw })
        if (parsed.kind === 'local' && !existsSync(parsed.path)) {
          return sendJson(res, 400, { error: '找不到本地文件：' + parsed.path })
        }
        const running = activeProsody()
        if (running) return sendJson(res, 409, { error: '已有分析在跑，请等它结束', prosodyId: running.id })
        const job = startProsody(parsed.kind === 'local' ? parsed.path : parsed.url, {
          start: body.start,
          duration: body.duration
        })
        return sendJson(res, 200, { prosodyId: job.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = prosodies.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'prosody not found' })
    sendJson(res, 200, publicProsody(job))
  })

  register('/xiyoungtools/prosodies', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...prosodies.values()].map(publicProsody).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { prosodies: list })
  })

  register('/xiyoungtools/prosody-curves', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = prosodies.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'prosody not found' })
    const data = readProsodyCurves(job)
    if (!data) return sendJson(res, 404, { error: '还没有分析结果' })
    sendJson(res, 200, data)
  })

  register('/xiyoungtools/prosody-cancel', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const job = prosodies.get(body.id || '')
      if (!job) return sendJson(res, 404, { error: 'prosody not found' })
      if (job.status !== 'running' && job.status !== 'queued') return sendJson(res, 400, { error: '已经结束' })
      job.error = '已取消'
      try {
        if (job.child && typeof job.child.kill === 'function') job.child.kill()
      } catch {
        /* best effort */
      }
      finishProsody(job)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/labels', async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const want = url.searchParams.get('label')
      const dataset = url.searchParams.get('dataset')
      const onlyMine = url.searchParams.get('mine') === '1'
      const all = readLabels()
      let scoped = filterByDataset(all, dataset)
      // mine=1 只看自己的观察笔记（排除 CASIA 那类评测语料）
      if (onlyMine) scoped = scoped.filter(isOwnNote)
      const tally = {}
      for (const item of scoped) {
        const key = String(item.label || '未标')
        tally[key] = (tally[key] || 0) + 1
      }
      const labels = want ? scoped.filter((item) => String(item.label) === want) : scoped
      // 按时间倒序：笔记按"最近写的"看最有用
      const sorted = labels.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return sendJson(res, 200, {
        labels: sorted,
        count: scoped.length,
        total: all.length,
        ownCount: all.filter(isOwnNote).length,
        tally,
        datasets: datasetTally(all),
        file: LABELS_FILE
      })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const label = String(body.label || '').trim()
      const note = String(body.note || '').trim()
      // 笔记为主：只要有一边内容就能存
      if (!label && !note) {
        return sendJson(res, 400, { error: '至少写点东西：笔记正文或一个标签' })
      }
      const record = addLabel({
        dataset: body.dataset ? String(body.dataset) : 'tone',
        label,
        note,
        prosodyId: body.prosodyId ? String(body.prosodyId) : null,
        source: body.source ? String(body.source) : null,
        start: Number.isFinite(Number(body.start)) ? Number(body.start) : null,
        end: Number.isFinite(Number(body.end)) ? Number(body.end) : null,
        text: body.text ? String(body.text) : null
      })
      sendJson(res, 200, { ok: true, label: record })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  /**
   * 页面用的声纹比对入口。逻辑和 speaker_compare 工具同一份 python，
   * 只是走 HTTP 而不是工具调用——页面没法调工具。
   */
  register('/xiyoungtools/speaker-compare', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const resolveOne = (raw) => {
        const parsed = normalizeSource(String(raw || '').trim())
        if (!parsed) throw new BadRequestError('无法识别的来源：' + raw)
        if (parsed.kind === 'local' && !existsSync(parsed.path)) {
          throw new BadRequestError('找不到文件 ' + parsed.path)
        }
        return parsed.kind === 'local' ? parsed.path : parsed.url
      }
      const a = resolveOne(body.a)
      const b = resolveOne(body.b)
      const cmdArgs = [COMPARE_SCRIPT, a, b, '--json-only']
      const extras = Array.isArray(body.extra) ? body.extra : []
      for (const x of extras) {
        if (x && String(x).trim()) cmdArgs.push('--extra', resolveOne(x))
      }
      if (Number.isFinite(Number(body.start)) && body.start) {
        cmdArgs.push('--start', String(Number(body.start)))
      }
      if (Number.isFinite(Number(body.duration)) && body.duration) {
        cmdArgs.push('--duration', String(Number(body.duration)))
      }
      const r = await runProcess(PYTHON, cmdArgs, () => {}, {})
      const text = String(r.tail || '').trim()
      const lastLine = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
      if (!lastLine) {
        return sendJson(res, 500, {
          ok: false,
          error: '没拿到结果（退出码 ' + r.code + '）' + (text ? '：' + text.slice(-300) : '')
        })
      }
      let payload
      try {
        payload = JSON.parse(lastLine)
      } catch {
        return sendJson(res, 500, { ok: false, error: '输出不是 JSON' })
      }
      return sendJson(res, payload.ok ? 200 : 500, payload)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  })

  /** 页面用：在已有笔记里找和某次分析相似的几条。 */
  register('/xiyoungtools/label-find-similar', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const id = String(body.prosodyId || '').trim()
      if (!id) return sendJson(res, 400, { error: '需要 prosodyId' })
      const job = prosodies.get(id)
      if (!job) return sendJson(res, 404, { error: '找不到韵律分析 ' + id })
      const data = readProsodyCurves(job)
      const target = data && Array.isArray(data.speaker) ? data.speaker : null
      if (!target) return sendJson(res, 400, { error: '这次分析没有说话人嵌入（可能没装 resemblyzer 或用了 noSpeaker）' })

      const limit = Math.max(1, Math.min(50, Number(body.limit) || 10))
      const all = readLabels().filter((x) => Array.isArray(x.speaker) && x.speaker.length === target.length)
      // 目标本身也在池子里的话跳过，别自己跟自己比出 1.0
      const pool = all.filter((x) => x.prosodyId !== id)

      const cos = (a, b) => {
        let dot = 0, na = 0, nb = 0
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
        }
        if (na <= 0 || nb <= 0) return null
        return dot / (Math.sqrt(na) * Math.sqrt(nb))
      }

      const scored = []
      for (const rec of pool) {
        const s = cos(target, rec.speaker)
        if (s === null) continue
        scored.push({
          id: rec.id,
          similarity: Math.round(s * 10000) / 10000,
          label: rec.label || '',
          note: String(rec.note || '').slice(0, 200),
          dataset: rec.dataset || null,
          prosodyId: rec.prosodyId || null,
          source: rec.source || null,
          createdAt: rec.createdAt || null,
        })
      }
      scored.sort((a, b) => b.similarity - a.similarity)

      // 本池子的分布，用来给"像不像"一个相对位置
      const vals = scored.map((x) => x.similarity)
      const median = vals.length ? vals[Math.floor(vals.length / 2)] : null

      return sendJson(res, 200, {
        ok: true,
        total: scored.length,
        median,
        hits: scored.slice(0, limit),
        caveats: [
          '相似度是原始余弦，resemblyzer 嵌入有各向异性，绝对值普遍偏高',
          '只看相对排序更可靠：排最前的那几条才值得深究',
          '跨录音设备 / 跨来源的比较要谨慎；同一批录音之间更可信',
        ],
      })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })
  register('/xiyoungtools/label-from-prosody', async (req, res) => {
    // 从一次韵律分析里"摘一段"存成笔记。
    // 分析完看着某段曲线觉得有意思，一键把那段连同数字和你的话一起存下来，
    // 比手抄数字有用。顺带存下 256 维嵌入，以后能回查"哪两条像"。
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const id = String(body.prosodyId || '').trim()
      if (!id) return sendJson(res, 400, { error: '需要 prosodyId' })
      const job = prosodies.get(id)
      if (!job) return sendJson(res, 404, { error: '找不到韵律分析 ' + id })

      const start = Number(body.start) || 0
      const end = Number(body.end) || 0
      if (end > 0 && end <= start) {
        return sendJson(res, 400, { error: '结束时间必须晚于起始时间' })
      }

      // 从 prosody.json 里摘这一段的数字，附在笔记上，以后回看得懂
      const data = readProsodyCurves(job)
      const summary = (data && data.summary) || null
      const features = {}
      if (summary) {
        for (const k of ['f0Median', 'semitoneRange', 'trendSemitone',
          'pitchOscillationMedian', 'pitchOscillationP90',
          'voicedRatio', 'silenceRatio', 'dbMedian']) {
          if (summary[k] !== undefined && summary[k] !== null) features[k] = summary[k]
        }
        if (summary.duration) features.duration = summary.duration
      }
      // 段落内的逐句文本（如果时间范围落在某些句子里）
      let segText = ''
      if (data && Array.isArray(data.segments)) {
        const hits = data.segments.filter((sg) => {
          const a = Number(sg.start) || 0
          const b = Number(sg.end) || 0
          return b > start && (end === 0 || a < end)
        })
        segText = hits.map((sg) => String(sg.text || '').trim()).filter(Boolean).join(' ')
      }

      // 说话人指纹：把 256 维嵌入也存进笔记，以后能回查「这些笔记里哪两条像」
      // 只存不展示——256 个小数对人没意义，但能让 speaker_compare 免去重算
      let speaker = null
      if (data && Array.isArray(data.speaker) && data.speaker.length === 256) {
        speaker = data.speaker
      }

      const record = addLabel({
        dataset: 'note',
        label: String(body.label || '').trim(),
        note: String(body.note || '').trim(),
        prosodyId: id,
        source: job.source || null,
        start,
        end: end || null,
        text: segText || null,
        features: Object.keys(features).length ? features : undefined,
        speaker: speaker || undefined
      })
      sendJson(res, 200, { ok: true, label: record })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/label-delete', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const id = String(body.id || '')
      const list = readLabels()
      const next = list.filter((item) => item.id !== id)
      if (next.length === list.length) return sendJson(res, 404, { error: '找不到这条标签' })
      writeLabels(next)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/prosody-audio', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = prosodies.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'prosody not found' })
    const file = path.join(job.outDir, 'decoded.wav')
    if (!existsSync(file)) return sendJson(res, 404, { error: 'audio not ready' })
    try {
      const bytes = readFileSync(file)
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(bytes.length),
        'cache-control': 'no-store'
      })
      res.end(bytes)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })


  register('/xiyoungtools/cache', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      sendJson(res, 200, { ok: true, stats: cacheStats() })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/cache-clean', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const options = {
        all: body.all === true,
        includeOutputs: body.includeOutputs === true,
        maxAgeDays: Number(body.maxAgeDays) || 0
      }
      const kind = String(body.kind || 'all')
      const result = kind === 'all' ? cleanAll(options) : cleanKind(kind, options)
      sendJson(res, 200, result)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })


  register('/xiyoungtools/batch', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const dir = String(body.dir || '').trim().replace(/^"(.*)"$/, '$1').trim()
        if (!dir) return sendJson(res, 400, { error: '请填写文件夹路径' })
        if (!existsSync(dir)) return sendJson(res, 400, { error: '找不到文件夹：' + dir })
        const running = activeBatch()
        if (running) return sendJson(res, 409, { error: '已有批量任务在跑', batchId: running.id })
        const job = startBatch(dir, {
          labelFrom: ['auto', 'directory', 'filename', 'csv'].includes(body.labelFrom) ? body.labelFrom : 'auto',
          csv: body.csv ? String(body.csv) : null,
          dataset: body.dataset ? String(body.dataset) : 'tone'
        })
        return sendJson(res, 200, { batchId: job.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = batches.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'batch not found' })
    sendJson(res, 200, publicBatch(job))
  })

  register('/xiyoungtools/batches', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...batches.values()].map(publicBatch).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { batches: list })
  })

  register('/xiyoungtools/batch-result', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = batches.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'batch not found' })
    const payload = readBatchPayload(job)
    if (!payload) return sendJson(res, 404, { error: '还没有结果' })
    sendJson(res, 200, payload)
  })

  register('/xiyoungtools/batch-import', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const job = batches.get(body.id || '')
      if (!job) return sendJson(res, 404, { error: 'batch not found' })
      if (job.status !== 'done') return sendJson(res, 400, { error: '任务还没完成' })
      const payload = readBatchPayload(job)
      if (!payload) return sendJson(res, 400, { error: '没有结果可导入' })
      const result = importBatchLabels(job, payload, body.dataset ? String(body.dataset) : undefined)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/batch-cancel', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      const body = await readBody(req)
      const job = batches.get(body.id || '')
      if (!job) return sendJson(res, 404, { error: 'batch not found' })
      if (job.status !== 'running' && job.status !== 'queued') return sendJson(res, 400, { error: '已经结束' })
      job.error = '已取消'
      try {
        if (job.child && typeof job.child.kill === 'function') job.child.kill()
      } catch {
        /* best effort */
      }
      finishBatch(job)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })

  register('/xiyoungtools/batch-report', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = batches.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'batch not found' })
    const file = path.join(job.outDir, 'batch.md')
    if (!existsSync(file)) return sendJson(res, 404, { error: 'report not ready' })
    try {
      const text = readFileSync(file, 'utf8')
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    } catch (error) {
      const status = error instanceof BadRequestError ? 400 : 500
      sendJson(res, status, { error: String(error && error.message ? error.message : error) })
    }
  })


  register('/xiyoungtools/cluster', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const dir = String(body.dir || '').trim().replace(/^"(.*)"$/, '$1').trim()
        if (!dir) return sendJson(res, 400, { error: '请填写文件夹路径' })
        if (!existsSync(dir)) return sendJson(res, 400, { error: '找不到文件夹：' + dir })
        const running = activeCluster()
        if (running) return sendJson(res, 409, { error: '已有聚类在跑', clusterId: running.id })
        const job = startCluster(dir, { seed: body.seed, merge: body.merge })
        return sendJson(res, 200, { clusterId: job.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = clusterJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'cluster not found' })
    sendJson(res, 200, publicCluster(job))
  })

  register('/xiyoungtools/clusters', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...clusterJobs.values()].map(publicCluster).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { clusters: list })
  })

  register('/xiyoungtools/cluster-result', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = clusterJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'cluster not found' })
    const payload = readClusterPayload(job)
    if (!payload) return sendJson(res, 404, { error: '还没有结果' })
    sendJson(res, 200, payload)
  })


  register('/xiyoungtools/diarize', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const raw = String(body.source || '').trim().replace(/^"(.*)"$/, '$1').trim()
        if (!raw) return sendJson(res, 400, { error: '请填写音频路径或链接' })
        const parsed = normalizeSource(raw)
        if (!parsed) return sendJson(res, 400, { error: '无法识别的来源：' + raw })
        if (parsed.kind === 'local' && !existsSync(parsed.path)) {
          return sendJson(res, 400, { error: '找不到文件：' + parsed.path })
        }
        const running = activeDiarize()
        if (running) return sendJson(res, 409, { error: '已有分离在跑', diarizeId: running.id })
        const job = startDiarize(parsed.kind === 'local' ? parsed.path : parsed.url, { window: body.window })
        return sendJson(res, 200, { diarizeId: job.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = diarizeJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'diarize not found' })
    sendJson(res, 200, publicDiarize(job))
  })

  register('/xiyoungtools/diarizes', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...diarizeJobs.values()].map(publicDiarize).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { diarizes: list })
  })

  register('/xiyoungtools/diarize-result', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = diarizeJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'diarize not found' })
    const payload = readDiarizePayload(job)
    if (!payload) return sendJson(res, 404, { error: '还没有结果' })
    sendJson(res, 200, payload)
  })



  register('/xiyoungtools/analyze', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const raw = String(body.source || '').trim().replace(/^"(.*)"$/, '$1').trim()
        if (!raw) return sendJson(res, 400, { error: '请填写视频/音频文件路径' })
        const parsed = normalizeSource(raw)
        if (!parsed) return sendJson(res, 400, { error: '无法识别的来源：' + raw })
        if (parsed.kind === 'local' && !existsSync(parsed.path)) {
          return sendJson(res, 400, { error: '找不到文件：' + parsed.path })
        }
        const running = activeAnalyze()
        if (running) return sendJson(res, 409, { error: '已有分析在跑', analyzeId: running.id })
        const only = String(body.only || 'both')
        const job = startAnalyze(parsed.kind === 'local' ? parsed.path : parsed.url, {
          video: only !== 'audio',
          audio: only !== 'video',
          model: body.model,
          summary: body.summary,
          start: body.start,
          end: body.end,
          duration: body.duration,
          maxSheets: body.maxSheets,
          concurrency: body.concurrency,
        })
        return sendJson(res, 200, { analyzeId: job.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = analyzeJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'analyze not found' })
    sendJson(res, 200, publicAnalyze(job))
  })

  register('/xiyoungtools/analyze-result', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = analyzeJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'analyze not found' })
    sendJson(res, 200, analyzeToolResult(job))
  })

  register('/xiyoungtools/analyzes', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const list = [...analyzeJobs.values()].map(publicAnalyze).sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { analyzes: list })
  })

  register('/xiyoungtools/bench', async (req, res) => {
    if (req.method === 'POST') {
      if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })
      if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
      try {
        const body = await readBody(req)
        const dir = String(body.dir || '').trim().replace(/^"(.*)"$/, '$1').trim()
        if (!dir) return sendJson(res, 400, { error: '请填写文件夹路径' })
        if (!existsSync(dir)) return sendJson(res, 400, { error: '找不到文件夹：' + dir })
        const running = activeBench()
        if (running) return sendJson(res, 409, { error: '已有评测在跑', benchId: running.id })
        const job = startBench(dir, { feature: body.feature, limitPerLabel: body.limitPerLabel })
        return sendJson(res, 200, { benchId: job.id })
      } catch (error) {
        const status = error instanceof BadRequestError ? 400 : 500
        return sendJson(res, status, { error: String(error && error.message ? error.message : error) })
      }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = benchJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'bench not found' })
    sendJson(res, 200, publicBench(job))
  })

  register('/xiyoungtools/bench-result', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://localhost')
    const job = benchJobs.get(url.searchParams.get('id') || '')
    if (!job) return sendJson(res, 404, { error: 'bench not found' })
    const payload = readBenchPayload(job)
    if (!payload) return sendJson(res, 404, { error: '还没有结果' })
    sendJson(res, 200, payload)
  })

  let toolRegistry = ctx.tools
  if (!toolRegistry && typeof ctx.get === 'function') {
    try {
      toolRegistry = ctx.get('tools')
    } catch {
      toolRegistry = undefined
    }
  }
  if (toolRegistry && typeof toolRegistry.register === 'function') {
    // 精简后的工具表：8 个入口，不再有 7 个重复的 _status。
    // 查任务统一用 toolbox_job({ id })，它按 id 自动判断类型。
    for (const definition of [
      videoSummaryTool,
      mediaClipTool,
      prosodyAnalyzeTool, prosodyLabelTool,
      prosodyBatchTool,
      speakerCompareTool,
      speakerClusterTool,
      speakerDiarizeTool,
      benchTool,
      analyzeTool, toolboxJobTool,
      cacheCleanTool,
      toolboxDoctorTool
    ]) {
      try {
        const dispose = toolRegistry.register(definition)
        if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
          ctx.effect(() => dispose, 'xiyoungtools: ' + definition.name)
        }
      } catch (error) {
        console.error('xiyoungtools: could not register ' + definition.name, error)
      }
    }
  } else {
    console.warn('xiyoungtools: this DSH has no tools service; video_summary stays unmounted')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const job of jobs.values()) {
        try {
          if (job.child && typeof job.child.kill === 'function') job.child.kill()
        } catch {
          /* best effort */
        }
        try {
          if (job.logStream) job.logStream.end()
        } catch {
          /* already closed */
        }
      }
      for (const clip of clips.values()) {
        try {
          if (clip.child && typeof clip.child.kill === 'function') clip.child.kill()
        } catch {
          /* best effort */
        }
        try {
          if (clip.logStream) clip.logStream.end()
        } catch {
          /* already closed */
        }
      }
      for (const job of prosodies.values()) {
        try {
          if (job.child && typeof job.child.kill === 'function') job.child.kill()
        } catch {
          /* best effort */
        }
        try {
          if (job.logStream) job.logStream.end()
        } catch {
          /* already closed */
        }
      }
      for (const job of batches.values()) {
        try {
          if (job.child && typeof job.child.kill === 'function') job.child.kill()
        } catch {
          /* best effort */
        }
        try {
          if (job.logStream) job.logStream.end()
        } catch {
          /* already closed */
        }
      }
    }, 'xiyoungtools: stop running jobs')
  }
}
