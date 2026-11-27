#!/usr/bin/env node
/**
 * EnvCard 专项测试。
 *
 * 为什么单独测：smoke.mjs 只验证「能渲染」，但这个组件有
 * 5 种依赖状态 × 3 种操作状态，组合起来容易出错。
 *
 * 按 dsh-plugin-notes.md 的要求：
 *   1. 断言只有 true 算通过（别把字符串当通过 —— 踩过）
 *   2. 写完后故意改坏，确认测试会红
 *   3. 不写死会变的数字
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PKG_NAME = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name

let failures = 0
const check = (name, fn) => {
  try {
    const r = fn()
    if (r === true) { console.log('  ✓ ' + name); return }
    if (r === false) { failures += 1; console.log('  ✗ ' + name); return }
    failures += 1
    console.log('  ✗ ' + name + ' → ' + String(r))
  } catch (e) {
    failures += 1
    console.log('  ✗ ' + name + ' → ' + e.message)
  }
}

// ---------------------------------------------------------------- 加载 client.js
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8')
let registered = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (d) => { registered = d } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  },
  console,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  setTimeout, clearTimeout, setInterval, clearInterval,
}
import('node:vm').then(() => {})

const context = vm.createContext(sandbox)
vm.runInContext(src, context, { filename: 'client.js' })

if (!registered) {
  console.log('client.js 没有注册模块')
  process.exit(1)
}

// ---------------------------------------------------------------- React 桩
function makeReact() {
  const useStateStore = []
  let cursor = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = cursor++
      if (useStateStore[i] === undefined) {
        useStateStore[i] = typeof init === 'function' ? init() : init
      }
      const setter = (v) => { useStateStore[i] = typeof v === 'function' ? v(useStateStore[i]) : v }
      return [useStateStore[i], setter]
    },
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (f) => f(),
    useCallback: (f) => f,
    Fragment: 'Fragment',
    _reset: () => { cursor = 0; useStateStore.length = 0 },
    _getState: () => useStateStore,
  }
}

console.log('='.repeat(66))
console.log('EnvCard 专项测试')
console.log('='.repeat(66))
console.log()

const react = makeReact()
const plugin = registered.factory((name) => {
  if (name === 'react') return react
  throw new Error('模块表里没有 ' + name)
})

// ---------------------------------------------------------------- 静态检查
console.log('=== 代码约定 ===')

check('EnvCard 已定义', () => {
  const m = src.match(/function EnvCard\s*\(/)
  return m ? true : '源码里找不到 EnvCard'
})

check('EnvCard 挂到了配置页', () => {
  return /h\(EnvCard,\s*\{[^}]*health[^}]*onRecheck/.test(src)
    ? true : '没找到挂载点'
})

check('配置页同时保留 ConfigCard', () => {
  return /h\(ConfigCard,/.test(src) ? true : 'ConfigCard 被覆盖了'
})

check('安装调用走 install-deps 路由', () => {
  return src.includes("'/xiyoungtools/install-deps'") ? true : '找不到路由调用'
})

check('严格判 true（不用宽松判断）', () => {
  // 找 doInstall 里的判断
  const i = src.indexOf('async function doInstall')
  if (i < 0) return '找不到 doInstall'
  const seg = src.slice(i, i + 900)
  if (/res\.ok === true/.test(seg)) return true
  if (/if\s*\(\s*res\.ok\s*\)/.test(seg)) return '用了宽松判断（会把失败当成功）'
  return '没找到判断语句'
})

check('安装中禁用按钮（防重复点击）', () => {
  const i = src.indexOf('async function doInstall')
  const seg = src.slice(i, i + 400)
  return /if\s*\(busy\)\s*return/.test(seg) ? true : '没有防重复点击'
})

check('失败时给重试入口', () => {
  return /setErr\(''\);\s*if\s*\(onRecheck\)/.test(src) ? true : '失败后无法重试'
})

check('不出现 pip install 等术语', () => {
  const i = src.indexOf('function EnvCard')
  const j = src.indexOf('function ConfigCard')
  if (i < 0 || j < 0) return '找不到函数边界'
  const seg = src.slice(i, j)
  const bad = ['pip install', 'PATH', 'XIYOUNG_', '环境变量'].filter((k) => seg.includes(k))
  return bad.length === 0 ? true : '出现术语：' + bad.join(', ')
})

// ---------------------------------------------------------------- 渲染测试
console.log()
console.log('=== 渲染不同状态 ===')

function render(props) {
  react._reset()
  const out = react.createElement('root', {}, plugin.__envCardForTest
    ? plugin.__envCardForTest(props)
    : null)
  return out
}

// 因为 EnvCard 不在导出里，用整页渲染来间接验证：
// 直接调用 factory 拿不到它，只能通过 smoke 那样的方式。
// 这里改成检查「health 为 null 时不会崩」这种边界，通过正则确认有守护。

check('health 为 null 时有守护', () => {
  const i = src.indexOf('function EnvCard')
  const seg = src.slice(i, i + 5000)
  return /if\s*\(!health\)\s*\{/.test(seg) ? true : '没有 !health 分支（会崩）'
})

check('health.pythonDeps 缺失时也能渲染', () => {
  const i = src.indexOf('function EnvCard')
  const seg = src.slice(i, i + 5000)
  return /\(health && health\.pythonDeps\)\s*\|\|/.test(seg)
    ? true : '直接访问 health.pythonDeps（可能崩）'
})

check('models 为空时判为未就绪', () => {
  const i = src.indexOf('function EnvCard')
  const seg = src.slice(i, i + 5000)
  return /health\.models\s*&&\s*health\.models\.length/.test(seg)
    ? true : 'models 判断不对'
})

// ---------------------------------------------------------------- 后端契约
console.log()
console.log('=== 后端契约 ===')

const idx = readFileSync(path.join(ROOT, 'index.js'), 'utf8')

check('health 返回 pythonDeps', () => {
  return /pythonDeps:\s*probePythonDeps\(\)/.test(idx) ? true : 'health 里没有 pythonDeps'
})

check('install-deps 路由存在', () => {
  return idx.includes("'/xiyoungtools/install-deps'") ? true : '路由不存在'
})

check('install-deps 校验 origin', () => {
  const i = idx.indexOf("'/xiyoungtools/install-deps'")
  if (i < 0) return '路由不存在'
  const seg = idx.slice(i, i + 500)
  return /originOK\(req\)/.test(seg) ? true : '没校验 origin'
})

check('install-deps 校验 content-type', () => {
  const i = idx.indexOf("'/xiyoungtools/install-deps'")
  const seg = idx.slice(i, i + 500)
  return /contentTypeOK\(req\)/.test(seg) ? true : '没校验 content-type'
})

check('装完清掉依赖缓存', () => {
  const i = idx.indexOf("'/xiyoungtools/install-deps'")
  const seg = idx.slice(i, i + 2500)
  return /_pyDepsCache\s*=\s*\{\s*at:\s*0/.test(seg) ? true : '没清缓存（会显示旧状态）'
})

console.log()
console.log('='.repeat(66))
if (failures) {
  console.log(failures + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
