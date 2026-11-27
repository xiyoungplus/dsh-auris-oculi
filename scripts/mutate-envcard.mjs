#!/usr/bin/env node
/**
 * EnvCard 变异测试：故意改坏，看测试会不会红。
 *
 * 按 dsh-plugin-notes.md 第十一节：
 *   「写完后故意改坏代码，确认测试会红
 *     断言执行不到 = 没有测试」
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = path.join(ROOT, 'client.js')
const IDX = path.join(ROOT, 'index.js')
const TEST = path.join(HERE, 'test-envcard.mjs')

const MUTATIONS = [
  {
    name: '宽松判断 res.ok（去掉 === true）',
    file: CLIENT,
    from: 'if (res && res.ok === true) {',
    to: 'if (res && res.ok) {',
  },
  {
    name: '删掉防重复点击',
    file: CLIENT,
    from: '    if (busy) return\n',
    to: '',
  },
  {
    name: '删掉 health 为 null 的守护',
    file: CLIENT,
    from: '  if (!health) {',
    to: '  if (false) {',
  },
  {
    name: '直接访问 health.pythonDeps（不判空）',
    file: CLIENT,
    from: 'const py = (health && health.pythonDeps) || {}',
    to: 'const py = health.pythonDeps',
  },
  {
    name: 'health 不返回 pythonDeps',
    file: IDX,
    from: 'pythonDeps: probePythonDeps(),',
    to: '',
  },
  {
    name: '装完不清依赖缓存',
    file: IDX,
    from: '      _pyDepsCache = { at: 0, value: null }\n',
    to: '',
  },
  {
    name: 'install-deps 不校验 origin',
    file: IDX,
    from: "    if (!originOK(req)) return sendJson(res, 403, { error: 'origin not allowed' })\n    if (!contentTypeOK(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })\n    try {\n      const body = await readBody(req)\n      const want = Array.isArray(body.packages)",
    to: "    try {\n      const body = await readBody(req)\n      const want = Array.isArray(body.packages)",
  },
]

const backups = {}
for (const f of [CLIENT, IDX]) {
  backups[f] = readFileSync(f, 'utf8')
}

const restore = () => {
  for (const [f, c] of Object.entries(backups)) writeFileSync(f, c, 'utf8')
}

let caught = 0
console.log('='.repeat(70))
console.log('变异测试：改坏了测试会红吗')
console.log('='.repeat(70))

try {
  for (const m of MUTATIONS) {
    const src = readFileSync(m.file, 'utf8')
    if (!src.includes(m.from)) {
      console.log()
      console.log('  [跳过] ' + m.name + '（找不到锚点）')
      continue
    }
    writeFileSync(m.file, src.replace(m.from, m.to), 'utf8')

    let red = false
    let detail = ''
    try {
      execFileSync(process.execPath, [TEST], { stdio: 'pipe', timeout: 60000 })
    } catch (e) {
      red = true
      const out = String(e.stdout || '')
      const fails = out.split('\n').filter((l) => l.includes('✗'))
      detail = fails.length ? fails[0].trim() : '退出码非零'
    }
    // 也检查语法错误（改坏后可能直接跑不起来）
    if (!red) {
      try {
        execFileSync(process.execPath, ['--check', m.file], { stdio: 'pipe' })
      } catch {
        red = true
        detail = '语法错误（也算被抓住）'
      }
    }
    if (red) caught += 1
    console.log()
    console.log('  ' + (red ? '✓ 抓住' : '✗ 没抓住') + '  ' + m.name)
    if (red && detail) console.log('        ' + detail.slice(0, 78))

    restore()
  }
} finally {
  restore()
}

console.log()
console.log('='.repeat(70))
console.log('抓住 ' + caught + ' / ' + MUTATIONS.length)
console.log('='.repeat(70))
if (caught < MUTATIONS.length) {
  console.log()
  console.log('没抓住的说明对应测试不够严。')
  process.exit(1)
}
