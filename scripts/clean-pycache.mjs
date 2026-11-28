#!/usr/bin/env node
/**
 * 发布前清掉 __pycache__。
 *
 * 为什么需要物理清理，不能靠 .npmignore：
 *   package.json 的 `files` 白名单包含 `lib/` 整个目录。
 *   npm 的既有行为是「白名单命中的内容不受 .npmignore 排除」，
 *   所以 .npmignore 里写了 __pycache__/ 也没用。
 *
 * 实际后果：2026-11-28 发布 0.23.1 时，local 有一份测试生成的
 * lib/__pycache__（243 KB），它被打进了 npm 包（包体 872 KB → 应为 748 KB）。
 *
 * 这个脚本挂在 prepublishOnly 上，每次 npm publish 前自动跑。
 */
import { readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let removed = 0
let freed = 0

function dirSize(p) {
  let total = 0
  try {
    for (const name of readdirSync(p)) {
      const full = path.join(p, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) total += dirSize(full)
        else total += st.size
      } catch { /* 跳过 */ }
    }
  } catch { /* 跳过 */ }
  return total
}

function walk(dir) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    // 不进入 node_modules 和 .git
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = path.join(dir, e.name)
    if (e.name === '__pycache__') {
      freed += dirSize(full)
      try {
        rmSync(full, { recursive: true, force: true })
        removed += 1
        console.log('  删除 ' + path.relative(ROOT, full))
      } catch (err) {
        console.log('  删除失败 ' + path.relative(ROOT, full) + '：' + err.message)
      }
      continue
    }
    walk(full)
  }
}

walk(ROOT)

if (removed === 0) {
  console.log('  __pycache__ 已清理（没有需要删的）')
} else {
  console.log('  清理了 ' + removed + ' 个 __pycache__，释放 ' +
    Math.round(freed / 1024) + ' KB')
}
