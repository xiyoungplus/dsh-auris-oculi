#!/usr/bin/env node
/**
 * 冒烟测试：把 client.js 真跑一遍，逐个 tab / 子标签渲染。
 *
 * 为什么不是静态正则：0.10.0→0.10.1 的「打开音频页就崩溃」是三个组件各缺一个
 * state 造成的，静态检查误报太多（处理不了解构、箭头函数参数、模板字符串）。
 * 真渲染一次能直接点名"哪个组件缺哪个变量"。
 *
 * 用法：node scripts/smoke.mjs
 * 退出码 0 = 全部通过。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = path.join(ROOT, 'client.js')

let failures = 0
const fail = (message) => { failures += 1; console.log('  ✗ ' + message) }
const ok = (message) => console.log('  ✓ ' + message)

// ---------------------------------------------------------------------------
// 一个最小的 React 替身：只要够 client.js 的 h()/useState/useEffect/useRef 跑起来
// ---------------------------------------------------------------------------

/**
 * 一个最小的 React 替身。
 *
 * 关键点：hook 状态必须**按组件实例隔离**。早先的写法用全局游标、每个组件渲染前
 * 重置，结果父组件和子组件共享同一段槽位，读出 null 还以为是 client.js 的 bug。
 * 这里按「组件名」维护一份状态，测试里每个组件只挂载一次，够用。
 */
function createRuntime() {
  const store = new Map() // componentName -> { hooks: [], cursor: 0 }
  let current = null

  const slotFor = (name) => {
    if (!store.has(name)) store.set(name, { hooks: [], cursor: 0 })
    return store.get(name)
  }

  const useStateHook = (initial) => {
    const slot = current()
    const index = slot.cursor++
    if (index >= slot.hooks.length) {
      slot.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const set = (next) => {
      slot.hooks[index].value = typeof next === 'function' ? next(slot.hooks[index].value) : next
    }
    return [slot.hooks[index].value, set]
  }

  const useEffectHook = () => {
    const slot = current()
    slot.cursor++ // 副作用不执行：全是 fetch / 定时器，跑起来只会引入噪声
  }

  const useRefHook = (initial) => {
    const slot = current()
    const index = slot.cursor++
    if (index >= slot.hooks.length) slot.hooks[index] = { value: { current: initial } }
    return slot.hooks[index].value
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState: useStateHook,
    useEffect: useEffectHook,
    useRef: useRefHook,
  }

  return {
    React,
    /** 进入某个组件的渲染上下文。 */
    enter(name) {
      const slot = slotFor(name)
      slot.cursor = 0
      current = () => slot
    },
    leave() { current = null },
    reset() { store.clear() },
  }
}

// ---------------------------------------------------------------------------
// 用假 DOM 包住渲染，把运行期异常抓出来
// ---------------------------------------------------------------------------

function renderNode(node, rt, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, rt, depth)
    return
  }
  if (typeof node.type === 'function') {
    const name = node.type.name || '匿名'
    rt.enter(name)
    let out
    try {
      out = node.type(node.props)
    } catch (error) {
      rt.leave()
      throw new Error('组件 ' + name + ' 渲染崩溃: ' + error.message)
    }
    rt.leave()
    renderNode(out, rt, depth + 1)
    return
  }
  // 宿主元素：继续渲染子节点
  renderNode(node.children, rt, depth)
}

// ---------------------------------------------------------------------------
// 加载 client.js
// ---------------------------------------------------------------------------

const source = readFileSync(CLIENT, 'utf8')

let factory = null
const loader = {
  load({ id, factory: f }) {
    if (id !== 'xiyoungtools') throw new Error('意外的插件 id: ' + id)
    factory = f
  },
}

const rt = createRuntime()
const sandbox = {
  window: { __ModuleLoader__: loader, localStorage: null },
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async () => { throw new Error('smoke 测试不发真实请求') },
  URL,
  encodeURIComponent,
  decodeURIComponent,
  JSON,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Error,
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
try {
  vm.runInContext(source, sandbox, { filename: 'client.js' })
} catch (error) {
  console.log('\n✗ client.js 无法执行: ' + error.message)
  process.exit(1)
}

if (!factory) {
  console.log('\n✗ client.js 没有调用 window.__ModuleLoader__.load()')
  process.exit(1)
}

const requireStub = (name) => {
  if (name === 'react') return rt.React
  throw new Error('client.js 请求了未知模块: ' + name)
}

let plugin
try {
  plugin = factory(requireStub)
} catch (error) {
  console.log('\n✗ factory 执行失败: ' + error.message)
  process.exit(1)
}

console.log('\n=== client.js 模块 ===')
if (plugin && plugin.name === 'xiyoungtools') ok('模块导出 name = xiyoungtools')
else fail('模块导出 name 不是 xiyoungtools')

if (!plugin || typeof plugin.apply !== 'function') {
  fail('模块没有 apply(ctx)')
  process.exit(1)
}
ok('模块有 apply(ctx)')

// ---------------------------------------------------------------------------
// 收集 slot 注册，拿到 ToolboxPage 和图标组件
// ---------------------------------------------------------------------------

const slots = []
let layoutSelected = null
const ctx = {
  slots: {
    inject(_parent, fn) { return fn() },
    register(slot, component) {
      slots.push({ slot, component })
      return () => {}
    },
  },
  layout: { selectPanel: (v) => { layoutSelected = v } },
}

try {
  plugin.apply(ctx)
} catch (error) {
  console.log('\n✗ apply(ctx) 抛错: ' + error.message)
  process.exit(1)
}

console.log('\n=== slot 注册 ===')
const mainSlot = slots.find((s) => s.slot.name === 'main')
const iconSlot = slots.find((s) => s.slot.name === 'sidebar.panellist')
if (mainSlot) ok('main slot 已注册（' + (mainSlot.component.name || '匿名') + '）')
else fail('main slot 未注册')
if (iconSlot) ok('sidebar.panellist slot 已注册（' + (iconSlot.component.name || '匿名') + '）')
else fail('sidebar.panellist slot 未注册')

if (!mainSlot) {
  console.log('\n' + failures + ' 项失败')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 逐个 tab 真渲染
// ---------------------------------------------------------------------------

const ToolboxPage = mainSlot.component

/** 渲染 ToolboxPage 本身（不递归子组件），拿到它的输出树。 */
function renderPageWith(props) {
  rt.enter('ToolboxPage')
  let tree
  try {
    tree = ToolboxPage(props || {})
  } finally {
    rt.leave()
  }
  return tree
}

/** 在渲染树里找按钮，按文案点击它（触发 setState），再重新渲染。 */
function findButtonByText(node, text) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButtonByText(child, text)
      if (hit) return hit
    }
    return null
  }
  const isButton = node.type === 'button' && node.props && node.props.onClick
  if (isButton && collectText(node).includes(text)) return node
  return findButtonByText(node.children, text)
}

function collectText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  return collectText(node.children)
}

/**
 * 按路径点击一组按钮并重新渲染，返回最终渲染树。
 * 因为 hook 状态保存在 runtime 的数组里，setState 之后重新调用组件就是新的一次渲染。
 */
function clickPath(labels, props) {
  let tree = renderPageWith(props)
  for (const label of labels) {
    const button = findButtonByText(tree, label)
    if (!button) throw new Error('找不到按钮「' + label + '」')
    button.props.onClick()
    tree = renderPageWith(props)
  }
  return tree
}

console.log('\n=== 主 tab 渲染（逐个点击）===')
const mainTabs = [
  { label: '分析', name: 'analyze' },
  { label: '截取与韵律', name: 'audio' },
  { label: '配置', name: 'config' },
]
for (const tab of mainTabs) {
  try {
    const tree = clickPath([tab.label], {})
    renderNode(tree, rt)
    ok('tab=' + tab.name + ' 渲染通过')
  } catch (error) {
    fail('tab=' + tab.name + ' 渲染崩溃: ' + error.message)
  }
}

console.log('\n=== 音频子标签渲染 ===')
const audioSubTabs = [
  { labels: ['截取与韵律', '截取'], name: 'clip' },
  { labels: ['截取与韵律', '韵律与转写'], name: 'prosody' },
  { labels: ['截取与韵律', '声纹'], name: 'voice' },
  { labels: ['截取与韵律', '批量分析'], name: 'batch' },
  { labels: ['截取与韵律', '笔记'], name: 'label' },
]
for (const sub of audioSubTabs) {
  try {
    const tree = clickPath(sub.labels, {})
    renderNode(tree, rt)
    ok('sub=' + sub.name + ' 渲染通过')
  } catch (error) {
    fail('sub=' + sub.name + ' 渲染崩溃: ' + error.message)
  }
}

console.log('\n=== 批量页两种模式 ===')
for (const mode of ['import', 'cluster']) {
  try {
    const tree = clickPath(['截取与韵律', '批量分析'], {})
    // select 不是 button：直接改它的 onChange 再重新渲染
    const select = findSelectByValue(tree, mode)
    if (!select) throw new Error('找不到模式下拉框')
    select.props.onChange({ target: { value: mode } })
    renderNode(renderPageWith({}), rt)
    ok('batch mode=' + mode + ' 渲染通过')
  } catch (error) {
    fail('batch mode=' + mode + ' 渲染崩溃: ' + error.message)
  }
}

function findSelectByValue(node, value) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findSelectByValue(child, value)
      if (hit) return hit
    }
    return null
  }
  if (node.type === 'select' && node.props) {
    const hasOption = collectText(node.children).length > 0
    if (hasOption) return node
  }
  return findSelectByValue(node.children, value)
}

// 图标组件
console.log('\n=== 侧栏图标 ===')
if (iconSlot) {
  try {
    rt.enter('ToolboxIcon')
    let icon
    try {
      icon = iconSlot.component({ size: 18, active: false })
    } finally {
      rt.leave()
    }
    renderNode(icon, rt)
    ok('图标渲染通过')
  } catch (error) {
    fail('图标渲染崩溃: ' + error.message)
  }
}

console.log('')
if (failures === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(failures + ' 项失败')
process.exit(1)
