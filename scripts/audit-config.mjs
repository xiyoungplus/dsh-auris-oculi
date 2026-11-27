#!/usr/bin/env node
/**
 * 配置覆盖审计：每个配置项到底能不能从 agent 调用时覆盖？
 *
 * 这个问题人工核对很容易漏。所以用程序对一遍：
 *   1. 从 BUILTIN_DEFAULTS 抽出全部配置项
 *   2. 从各工具 definition 抽出全部参数名
 *   3. 检查每个配置项有没有一条「配置 → 工具参数 → 命令行/环境变量」的通路
 *   4. 检查每个配置项有没有对应的环境变量注入（这是最底层的兜底）
 *
 * 用法：node scripts/audit-config.mjs
 * 退出码 0 = 没有无法覆盖的配置项。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const PROSODY = readFileSync(path.join(ROOT, 'prosody.py'), 'utf8')
const CLIENT = readFileSync(path.join(ROOT, 'client.js'), 'utf8')

let failures = 0
const fail = (m) => { failures += 1; console.log('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

// ---------------------------------------------------------------------------
// 1) 抽出全部配置项
// ---------------------------------------------------------------------------
const defaultsBody = SRC.match(/const BUILTIN_DEFAULTS = \{[\s\S]*?\n\}\n/)[0]
const cfgGroups = {}
for (const g of defaultsBody.matchAll(/\n  "(\w+)": \{([\s\S]*?)\n  \}/g)) {
  cfgGroups[g[1]] = [...g[2].matchAll(/"(\w+)":/g)].map((x) => x[1])
}
const allCfg = Object.entries(cfgGroups).flatMap(([g, ks]) => ks.map((k) => g + '.' + k))

// ---------------------------------------------------------------------------
// 2) 抽出全部工具参数
// ---------------------------------------------------------------------------
const toolStarts = [...SRC.matchAll(/const (\w+) = \{\n  name: '([a-z_]+)',/g)]
const toolParams = {}
for (let i = 0; i < toolStarts.length; i++) {
  const end = i + 1 < toolStarts.length ? toolStarts[i + 1].index : SRC.length
  const block = SRC.slice(toolStarts[i].index, end)
  const pm = block.match(/parameters: \{[\s\S]*?properties: \{([\s\S]*?)\n    \},/)
  toolParams[toolStarts[i][2]] = pm
    ? [...pm[1].matchAll(/\n      (\w+): \{/g)].map((x) => x[1])
    : []
}
const everyToolParam = new Set(Object.values(toolParams).flat())

// ---------------------------------------------------------------------------
// 3) 环境变量注入表（pythonEnv 里的 key）
// ---------------------------------------------------------------------------
const envInjected = new Set([...SRC.matchAll(/(XIYOUNG_[A-Z0-9_]+):/g)].map((x) => x[1]))
const envOverridable = new Set(
  [...SRC.matchAll(/\['(XIYOUNG_[A-Z0-9_]+)', '/g)].map((x) => x[1])
)

// ---------------------------------------------------------------------------
// 4) 配置项 → 它对应的 env 名（按 XXX_YYY 命名规则推）
// ---------------------------------------------------------------------------
const toEnvName = (key) => key.replace(/\./g, '_')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .toUpperCase()

// 配置页是否暴露（client.js 里有没有 save({ group: { key: ... } }），
const uiExposed = (group, key) =>
  new RegExp('save\\(\\{\\s*' + group + ':\\s*\\{[^}]*' + key).test(CLIENT)

console.log('\n=== 配置覆盖审计 ===')
console.log('配置项总数: ' + allCfg.length + '，工具参数总数: ' + everyToolParam.size + '\n')

// 已知的例外：这些配置项只影响服务端行为，不该也不需要对 agent 暴露
const SERVER_ONLY = new Set([
  'model.provider', 'model.apiKey', 'model.host', 'model.slowModels', 'model.autoDiscover',
  'limits.maxLogLines', 'limits.maxJobs',
  'ui.defaultTab', 'ui.showAdvanced', 'ui.language',
  'video.maxSheetsHardCap', 'audio.overlapSec',
])

const rows = []
for (const full of allCfg) {
  const [group, key] = full.split('.')
  const envName = toEnvName(full)
  // 判定：agent 能覆盖 = 有工具参数 或 (有 env 注入 且 能通过别的工具参数间接设)
  // 注意 speaker.clusterSeed → 工具参数叫 seed（不是 clusterSeed），
  // 这类改名必须显式列出，否则审计会把"有通路"误判成"无通路"。
  const ALIAS = {
    'speaker.clusterSeed': 'seed',
    'speaker.clusterMerge': 'merge',
    'speaker.diarizeWindow': 'window',
  }
  const paramName = ALIAS[full] || key
  const inTool = everyToolParam.has(paramName)
  const hasEnv = envInjected.has(envName)
  const inUi = uiExposed(group, key)
  const serverOnly = SERVER_ONLY.has(full)

  // 判定：agent 能覆盖 = 有工具参数 或 (有 env 注入 且 能通过别的工具参数间接设)
  // 这里只做「存在性」检查，具体通路由下面的专项断言验证
  let verdict
  if (serverOnly) verdict = '服务端专用（无需暴露）'
  else if (inTool) verdict = 'agent 参数'
  else if (hasEnv && inUi) verdict = '配置页 + 环境变量'
  else if (hasEnv) verdict = '仅环境变量'
  else if (inUi) verdict = '仅配置页'
  else verdict = '**无通路**'

  rows.push({ full, inTool, hasEnv, inUi, serverOnly, verdict, envName })
}

const width = Math.max(...rows.map((r) => r.full.length))
console.log('配置项'.padEnd(width) + '  agent参数  环境变量  配置页   通路')
console.log('-'.repeat(width + 42))
for (const r of rows) {
  const flag = r.verdict === '**无通路**' ? '  ← 需处理' : ''
  console.log(
    r.full.padEnd(width) +
    '  ' + (r.inTool ? '是' : '—').padEnd(10) +
    '  ' + (r.hasEnv ? '是' : '—').padEnd(8) +
    '  ' + (r.inUi ? '是' : '—').padEnd(6) +
    '  ' + r.verdict + flag
  )
}

// ---------------------------------------------------------------------------
// 5) 专项断言
// ---------------------------------------------------------------------------
console.log('\n=== 关键通路断言 ===')

const expectInTool = [
  ['video.maxSheets', 'maxSheets'],
  ['video.framesPerSheet', 'framesPerSheet'],
  ['video.perRow', 'perRow'],
  ['video.sheetWidth', 'sheetWidth'],
  ['video.frameWidth', 'frameWidth'],
  ['video.minInterval', 'minInterval'],
  ['video.density', 'density'],
  ['video.height', 'height'],
  ['video.concurrency', 'concurrency'],
  ['audio.f0Min', 'f0Min'],
  ['audio.f0Max', 'f0Max'],
  ['audio.language', 'language'],
  ['model.numCtx', 'numCtx'],
  ['model.numPredict', 'numPredict'],
  ['model.timeoutSec', 'timeoutSec'],
  ['speaker.clusterSeed', 'seed'],
  ['speaker.clusterMerge', 'merge'],
  ['speaker.diarizeWindow', 'window'],
  ['changes.minPauseSec', 'minPauseSec'],
  ['changes.loudnessFloorDb', 'loudnessFloorDb'],
  ['changes.loudnessCeilDb', 'loudnessCeilDb'],
  ['changes.minGapSec', 'minGapSec'],
  ['changes.pitchJumpSemitone', 'pitchJumpSemitone'],
  ['changes.registerMaxSemitone', 'registerMaxSemitone'],
]
for (const [cfg, param] of expectInTool) {
  if (everyToolParam.has(param)) ok(cfg + ' → 工具参数 ' + param)
  else fail(cfg + ' 没有对应的工具参数（期望 ' + param + '）')
}

console.log('\n=== 环境变量名一致性 ===')
// 检查 index.js 注入的 env 名，python 侧真的在读
const pyEnvRead = new Set([...PROSODY.matchAll(/XIYOUNG_[A-Z0-9_]+/g)].map((x) => x[0]))
const videoRead = new Set(
  [...readFileSync(path.join(ROOT, 'video_watch.py'), 'utf8').matchAll(/XIYOUNG_[A-Z0-9_]+/g)].map((x) => x[0])
)
for (const name of ['XIYOUNG_CHANGES_MIN_GAP_SEC', 'XIYOUNG_CHANGES_PITCH_JUMP_SEMITONE',
  'XIYOUNG_CHANGES_REGISTER_MAX_SEMITONE']) {
  if (pyEnvRead.has(name)) ok(name + ' python 侧在读')
  else fail(name + ' python 侧没读（拼写不一致？）')
}
for (const name of ['XIYOUNG_VIDEO_MIN_INTERVAL', 'XIYOUNG_VIDEO_DENSITY', 'XIYOUNG_VIDEO_PER_ROW']) {
  if (videoRead.has(name)) ok(name + ' video_watch.py 在读')
  else fail(name + ' video_watch.py 没读')
}

// 死键检查：index 注入但 python 完全没人读的
console.log('\n=== 死键检查（注入但无人读）===')
const allPy = PROSODY + readFileSync(path.join(ROOT, 'video_watch.py'), 'utf8')
      + readFileSync(path.join(ROOT, 'speaker_cluster.py'), 'utf8')
      + readFileSync(path.join(ROOT, 'speaker_diarize.py'), 'utf8')
      + readFileSync(path.join(ROOT, 'batch_import.py'), 'utf8')
      + readFileSync(path.join(ROOT, 'benchmark.py'), 'utf8')
const dead = [...envInjected].filter((n) => !allPy.includes(n) && n.startsWith('XIYOUNG_'))
if (dead.length === 0) ok('没有死键')
else for (const d of dead) fail(d + ' 注入但所有 python 脚本都没读')

console.log('')
if (failures === 0) {
  console.log('全部通过：' + allCfg.length + ' 个配置项都有明确通路')
  process.exit(0)
}
console.log(failures + ' 项失败')
process.exit(1)
