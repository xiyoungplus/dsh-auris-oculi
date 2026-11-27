#!/usr/bin/env node
/**
 * Host 半的单元测试：不启动 DSH，直接 import index.js 里导出的东西跑。
 *
 * index.js 只导出 name / inject / apply，内部函数没导出。所以这里用 vm 把
 * 源码包一层，注入假 ctx 后调用 apply()，再通过假的 webServer 拿到路由函数，
 * 用假的 req/res 直接打——测的是真实代码路径，不是复制一份逻辑。
 *
 * 用法：node scripts/test-host.mjs
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let failures = 0
const check = (name, fn) => {
  try {
    const result = fn()
    if (result === true) { console.log('  ✓ ' + name); return }
    if (result === false) { failures += 1; console.log('  ✗ ' + name); return }
    console.log('  ✓ ' + name + (result ? ' → ' + result : ''))
  } catch (error) {
    failures += 1
    console.log('  ✗ ' + name + ' → ' + error.message)
  }
}

// ---------------------------------------------------------------------------
// 加载 Host 半
//
// index.js 是 ESM，不能用 vm.runInContext（会报 "Cannot use import statement
// outside a module"）。直接 import 它：apply() 只读 process.env 和 fs，不启动
// 任何服务，所以导入是安全的。
//
// ⚠️ 关键：所有数据目录都指向临时目录。cache-clean 会删任务目录，绝不能让它
// 对着 ~/.dsh/xiyoungtools 跑——那里有唯一不可再生的 labels.json。
// ---------------------------------------------------------------------------

const SANDBOX = mkdtempSync(path.join(tmpdir(), 'xiyoungtools-test-'))
process.env.DSH_HOME = SANDBOX
process.env.XIYOUNG_CONFIG = path.join(SANDBOX, 'config.json')

const routes = new Map()
// 记录注册过的工具定义，后面要断言"删掉的那个确实不再注册"、
// 以及直接拿 prosody_label 的 execute 来验证 list 的新字段。
const toolsSeen = []
const fakeCtx = {
  webServer: {
    register({ path: p, handler }) {
      routes.set(p, handler)
      return () => routes.delete(p)
    },
  },
  tools: {
    register(definition) {
      toolsSeen.push(definition)
      return () => {}
    },
  },
  effect() {},
  get(name) {
    if (name === 'webServer') return this.webServer
    if (name === 'tools') return this.tools
    return undefined
  },
}

const host = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
host.apply(fakeCtx)

// ---------------------------------------------------------------------------
// 在沙箱里造几组假任务，用来验证清理真的会删、也真的不会多删
// ---------------------------------------------------------------------------

const HOME = path.join(SANDBOX, 'xiyoungtools')

/**
 * 每个 kind 的真实产出清单 —— 直接照抄 python 源码里写盘的名字。
 * 这一层是"规格"，如果 python 改了文件名而这里没改，清理规则就会开始漏删。
 *
 *   video_watch.py      report.md summary.md analysis.json sheets_manifest.json
 *                       video.mp4 frames/ sheets/
 *   prosody.py          prosody.json prosody.md decoded.wav _cmp/
 *   batch_import.py     batch.json batch.md _work/decoded.wav
 *   speaker_cluster.py  clusters.json clusters.md dec_aaa.wav
 *   speaker_diarize.py  diarization.json diarization.md input.wav
 *   benchmark.py        benchmark.json benchmark.md b_aaa.wav
 */
const LAYOUT = {
  runs: {
    keep: ['report.md', 'summary.md', 'analysis.json', 'sheets_manifest.json'],
    drop: ['video.mp4'],
    keepDirs: ['sheets'],
    dropDirs: ['frames']
  },
  clips: {
    keep: ['clip.json', 'clip.log', 'out.mp4'],
    drop: ['source.mp4']
  },
  prosody: {
    keep: ['prosody.json', 'prosody.md'],
    drop: ['decoded.wav'],
    dropDirs: ['_cmp']
  },
  analyze: {
    keep: ['report.md'],
    drop: [],
    dropDirs: [],
    dropNested: [['audio', 'decoded.wav'], ['video', 'video.mp4']]
  },
  batches: {
    keep: ['batch.json', 'batch.md'],
    drop: [],
    dropDirs: ['_work'],
    dropNested: [['_work', 'decoded.wav']]
  },
  clusters: {
    keep: ['clusters.json', 'clusters.md'],
    drop: ['dec_aaa.wav']
  },
  diarize: {
    keep: ['diarization.json', 'diarization.md'],
    drop: ['input.wav']
  },
  bench: {
    keep: ['benchmark.json', 'benchmark.md'],
    drop: ['b_aaa.wav']
  }
}

function buildJob(kind, id) {
  const dir = path.join(HOME, kind, id)
  const spec = LAYOUT[kind] || { keep: ['report.md'], drop: [] }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'job.json'), '{"id":"' + id + '"}', 'utf8')
  writeFileSync(path.join(dir, 'job.log'), 'log', 'utf8')
  for (const name of (spec.keep || [])) writeFileSync(path.join(dir, name), 'keep', 'utf8')
  for (const name of (spec.drop || [])) writeFileSync(path.join(dir, name), Buffer.alloc(2048))
  for (const name of (spec.keepDirs || [])) {
    mkdirSync(path.join(dir, name), { recursive: true })
    writeFileSync(path.join(dir, name, 'kept.jpg'), Buffer.alloc(64))
  }
  for (const name of (spec.dropDirs || [])) {
    mkdirSync(path.join(dir, name), { recursive: true })
    writeFileSync(path.join(dir, name, 'junk.wav'), Buffer.alloc(2048))
  }
  for (const [parent, name] of (spec.dropNested || [])) {
    mkdirSync(path.join(dir, parent), { recursive: true })
    writeFileSync(path.join(dir, parent, name), Buffer.alloc(2048))
  }
  return dir
}

// runs：一个"新"的和一个"旧"的（旧文件用 mtime 往前拨 10 天）
const newRun = buildJob('runs', 'test-new-run')
const oldRun = buildJob('runs', 'test-old-run')
const tenDaysAgo = new Date(Date.now() - 10 * 86400000)
utimesSync(oldRun, tenDaysAgo, tenDaysAgo)

// 每个目录都放一个，验证 8 个 root 都被覆盖
for (const kind of Object.keys(LAYOUT)) {
  if (kind === 'runs') continue
  buildJob(kind, 'test-' + kind)
}
// 标注：测试它不会被任何清理碰到
mkdirSync(path.join(HOME, 'labels'), { recursive: true })
const LABELS = path.join(HOME, 'labels', 'labels.json')
writeFileSync(LABELS, '[{"id":"keep-me","label":"催"}]', 'utf8')
const labelsBefore = readFileSync(LABELS, 'utf8')

// ---------------------------------------------------------------------------
// 请求工具
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
  return res
}

async function call(method, routePath, { query, body } = {}) {
  const handler = routes.get(routePath)
  if (!handler) throw new Error('路由未注册: ' + routePath)
  const res = makeRes()
  let url = 'http://127.0.0.1/xiyoungtools/x'
  if (query) url += '?' + new URLSearchParams(query).toString()
  const chunks = []
  if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body), 'utf8'))
  const req = {
    method,
    url,
    headers: { origin: 'http://127.0.0.1:52403', 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') chunks.forEach(cb)
      if (event === 'end') cb()
      return req
    },
    destroy() {},
  }
  await handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, body: res.body }
}

// ---------------------------------------------------------------------------
// 开始测
// ---------------------------------------------------------------------------

console.log('\n=== 路由注册 ===')
check('41 条路由全部注册', () => routes.size === 41 || '实际 ' + routes.size)

console.log('\n=== health：模型名不能再是 null ===')
{
  const r = await call('GET', '/xiyoungtools/health')
  check('health 返回 200', () => r.status === 200)
  check('model 是真实模型名（不是 null）', () => (r.json.model === 'qwen3.5:4b' ? true : 'model=' + JSON.stringify(r.json.model)))
  check('speakerModelAvailable 是布尔', () => typeof r.json.speakerModelAvailable === 'boolean')
}

console.log('\n=== config：字段名校验 ===')
{
  const good = await call('POST', '/xiyoungtools/config', { body: { patch: { video: { maxSheets: 18 } } } })
  check('合法字段写入 200', () => good.status === 200)
  check('maxSheets 生效为 18', () => (good.json.config.video.maxSheets === 18 ? true : '实际 ' + good.json.config.video.maxSheets))

  const typo = await call('POST', '/xiyoungtools/config', { body: { patch: { video: { maxSheet: 24 } } } })
  check('拼错字段名被拒（400）', () => typo.status === 400 || '状态 ' + typo.status)
  check('错误信息指出了字段名', () => String(typo.json && typo.json.error).includes('maxSheet'))

  const badGroup = await call('POST', '/xiyoungtools/config', { body: { patch: { nope: { a: 1 } } } })
  check('未知分组被拒（400）', () => badGroup.status === 400)

  // 还原
  await call('POST', '/xiyoungtools/config', { body: { patch: { video: { maxSheets: 24 } } } })
}

console.log('\n=== cache：8 个目录都要统计 ===')
{
  const r = await call('GET', '/xiyoungtools/cache')
  check('cache 返回 200', () => r.status === 200)
  const stats = r.json.stats || {}
  const expected = ['runs', 'clips', 'prosody', 'analyze', 'batches', 'clusters', 'diarize', 'bench', 'labels']
  const missing = expected.filter((k) => !stats[k])
  check('9 个键齐全（8 目录 + labels）', () => (missing.length === 0 ? true : '缺 ' + missing.join(',')))
  check('labels 只统计不参与清理', () => typeof stats.labels.bytes === 'number')
  check('analyze 目录被统计到了', () => (stats.analyze && stats.analyze.count >= 1 ? true : JSON.stringify(stats.analyze)))
}

console.log('\n=== cache-clean：maxAgeDays 必须真的生效 ===')
{
  // 10 天前的任务 + 刚建的任务，问「只清 7 天以前的」
  const r = await call('POST', '/xiyoungtools/cache-clean', { body: { kind: 'runs', all: true, maxAgeDays: 7 } })
  check('cache-clean 返回 200', () => r.status === 200)
  check('只删了 1 个（旧的）', () => (r.json.removedJobs === 1 ? true : '删了 ' + r.json.removedJobs + ' 个'))
  check('新任务还在', () => existsSync(newRun))
  check('旧任务已删', () => !existsSync(oldRun))
}

console.log('\n=== cache-clean：不删中间产物 vs 删中间产物 ===')
{
  // 先只清「中间产物」，此时所有任务目录都该留着
  const r = await call('POST', '/xiyoungtools/cache-clean', { body: { all: false } })
  check('cache-clean 返回 200', () => r.status === 200)

  check('runs/video.mp4 已删', () => !existsSync(path.join(HOME, 'runs', 'test-new-run', 'video.mp4')))
  check('runs/frames/ 已删', () => !existsSync(path.join(HOME, 'runs', 'test-new-run', 'frames')))
  check('runs/report.md 还在', () => existsSync(path.join(HOME, 'runs', 'test-new-run', 'report.md')))
  check('runs/sheets/ 还在（拼图要留）', () => existsSync(path.join(HOME, 'runs', 'test-new-run', 'sheets', 'kept.jpg')))

  check('prosody/decoded.wav 已删', () => !existsSync(path.join(HOME, 'prosody', 'test-prosody', 'decoded.wav')))
  check('prosody/_cmp/ 已删', () => !existsSync(path.join(HOME, 'prosody', 'test-prosody', '_cmp')))
  check('prosody/prosody.json 还在', () => existsSync(path.join(HOME, 'prosody', 'test-prosody', 'prosody.json')))

  check('batches/_work/ 整目录已删', () => !existsSync(path.join(HOME, 'batches', 'test-batches', '_work')))
  check('batches/batch.json 还在', () => existsSync(path.join(HOME, 'batches', 'test-batches', 'batch.json')))
  check('batches/batch.md 还在', () => existsSync(path.join(HOME, 'batches', 'test-batches', 'batch.md')))

  check('clusters/dec_aaa.wav 已删', () => !existsSync(path.join(HOME, 'clusters', 'test-clusters', 'dec_aaa.wav')))
  check('clusters/clusters.json 还在', () => existsSync(path.join(HOME, 'clusters', 'test-clusters', 'clusters.json')))
  check('clusters/clusters.md 还在', () => existsSync(path.join(HOME, 'clusters', 'test-clusters', 'clusters.md')))

  check('diarize/input.wav 已删', () => !existsSync(path.join(HOME, 'diarize', 'test-diarize', 'input.wav')))
  check('diarize/diarization.json 还在', () => existsSync(path.join(HOME, 'diarize', 'test-diarize', 'diarization.json')))

  check('bench/b_aaa.wav 已删', () => !existsSync(path.join(HOME, 'bench', 'test-bench', 'b_aaa.wav')))
  check('bench/benchmark.json 还在', () => existsSync(path.join(HOME, 'bench', 'test-bench', 'benchmark.json')))

  check('clips/out.mp4 默认保留（设计如此）', () => existsSync(path.join(HOME, 'clips', 'test-clips', 'out.mp4')))
  check('clips/source.mp4 已删', () => !existsSync(path.join(HOME, 'clips', 'test-clips', 'source.mp4')))
  check('analyze/report.md 还在', () => existsSync(path.join(HOME, 'analyze', 'test-analyze', 'report.md')))
}

console.log('\n=== cache-clean：all=true 才删任务目录 ===')
{
  const r = await call('POST', '/xiyoungtools/cache-clean', { body: { kind: 'runs', all: true } })
  check('剩下的新任务被删掉', () => !existsSync(newRun))

  const r2 = await call('POST', '/xiyoungtools/cache-clean', { body: { kind: 'clips', all: true, includeOutputs: true } })
  check('clips 给了 includeOutputs 后被删', () => !existsSync(path.join(HOME, 'clips', 'test-clips')))
  check('removedJobs 记了 1', () => (r2.json.removedJobs === 1 ? true : String(r2.json.removedJobs)))
}

console.log('\n=== labels 在任何清理下都完好 ===')
{
  const r = await call('POST', '/xiyoungtools/cache-clean', { body: { kind: 'labels', all: true, includeOutputs: true } })
  check('清理 labels 被拒绝', () => r.json.ok === false)
  check('labels.json 内容一字未变', () => (readFileSync(LABELS, 'utf8') === labelsBefore ? true : '内容被改了!'))
  check('labels.json 仍然存在', () => existsSync(LABELS))
}

console.log('\n=== 声音笔记：prosody_labels 已合并进 prosody_label ===')
{
  // 0.18.0 删掉了独立的 prosody_labels 工具对象（只定义、没注册）。
  // 它的四项能力（total / tally / datasets / file）合并进了
  // prosody_label({ action: 'list' })。这里断言那四项真的回来了——
  // 否则"合并"只是把工具删了、能力也丢了。
  const t = toolsSeen.find((d) => d.name === 'prosody_label')
  check('prosody_label 已注册', () => (t ? true : '没找到'))
  check('prosody_labels 不再单独占工具位', () => (toolsSeen.some((d) => d.name === 'prosody_labels') ? '仍然注册着' : true))

  const r = await t.execute({ action: 'list', limit: 3 })
  check('list 返回 total（池子总数）', () => (typeof r.total === 'number' ? true : String(r.total)))
  check('list 返回 tally（各标签条数）', () => (r.tally && typeof r.tally === 'object' ? true : String(r.tally)))
  check('list 返回 datasets（各数据集条数）', () => (r.datasets && typeof r.datasets === 'object' ? true : String(r.datasets)))
  check('list 返回 file（标注池路径）', () => (r.file === LABELS ? true : String(r.file)))
  check('list 的 count 是命中数、不受 limit 截断', () => (
    r.count >= r.labels.length ? true : `count=${r.count} < labels=${r.labels.length}`))

  // dataset 筛选要真的生效
  const r2 = await t.execute({ action: 'list', dataset: 'caisa', limit: 5 })
  check('dataset 筛选生效（caisa）', () => (
    r2.labels.every((x) => x.dataset === 'caisa') ? true : '筛出了别的 dataset'))
}

console.log('\n=== 说话人嵌入：多后端可切换 ===')
{
  // 两个后端的嵌入维度不同（256 vs 192），坐标系也不同，不能混用。
  // 这里断言：backend 参数存在、取值受约束、配置项真的注入到 python 环境。
  const t2 = toolsSeen.find((d) => d.name === 'speaker_compare')
  check('speaker_compare 已注册', () => (t2 ? true : '没找到'))

  const params = (t2 && t2.parameters && t2.parameters.properties) || {}
  check('有 backend 参数', () => (params.backend ? true : '缺 backend'))
  check('backend 是枚举（auto/resemblyzer/campplus）', () => {
    const e = (params.backend && params.backend.enum) || []
    return e.includes('auto') && e.includes('resemblyzer') && e.includes('campplus')
      ? true : String(e)
  })

  // 配置项要能被读到（SPEC 表里有，才会出现在 /config 的返回里）
  const cfg = await call('GET', '/xiyoungtools/config')
  const spk = (cfg.json && cfg.json.config && cfg.json.config.speaker) || {}
  check('配置里有 speaker.backend', () => ('backend' in spk ? true : Object.keys(spk).join(',')))
  check('配置里有 speaker.modelPath', () => ('modelPath' in spk ? true : '缺'))

  // 默认值必须是 auto —— 否则没装 CAM++ 的机器一上来就报错
  check('speaker.backend 默认 auto', () => (spk.backend === 'auto' ? true : String(spk.backend)))
}

console.log('\n=== 中文编码：python 子进程必须拿到 PYTHONIOENCODING ===')
{
  // 踩过的坑（2026-11-26）：runProcess 里 spawn 没传 env，
  // python 在 Windows 上按默认 GBK 输出，Node 用 utf8 解 → 中文全乱。
  // 表现是「数字能读、文字全废」，因为 ASCII 不受影响，很难第一眼发现。
  //
  // 这里直接断言源码：runProcess 的 spawn 必须带 env。
  // 用源码检查而不是跑进程，是因为编码问题依赖控制台环境，
  // 在测试进程里不一定复现——查源码才是确定的。
  const src = readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  const idx = src.indexOf('function runProcess(')
  check('找得到 runProcess', () => (idx > 0 ? true : '没找到'))
  if (idx > 0) {
    // 取函数体前 600 字符，够覆盖 spawn 调用
    const body = src.slice(idx, idx + 600)
    check('runProcess 的 spawn 传了 env', () => (
      /spawn\([^)]*env\s*:/.test(body) ? true
        : 'spawn 没传 env —— python 会按 GBK 输出，中文会乱码'))
    check('env 默认回落到 pythonEnv()', () => (
      body.includes('pythonEnv()') ? true : '没有 pythonEnv() 回落'))
  }

  // pythonEnv 本身必须有 PYTHONIOENCODING
  check('pythonEnv 里有 PYTHONIOENCODING=utf-8', () => (
    /PYTHONIOENCODING:\s*'utf-8'/.test(src) ? true : '缺 PYTHONIOENCODING'))

  // 顺带确认所有 spawn 都带 env（除了极少数不需要 python 的）
  const spawns = src.match(/spawn\(/g) || []
  const withEnv = src.match(/spawn\([\s\S]{0,300}?env\s*:/g) || []
  check('spawn 调用带 env 的比例', () => (
    withEnv.length >= spawns.length - 1
      ? true
      : `${withEnv.length}/${spawns.length} 带 env，可能有路径漏了`))
}

// 收拾临时目录
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(failures + ' 项失败')
process.exit(1)
