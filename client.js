// Auris Oculi 感知工具箱 — browser half.
//
// Plain hand-written client bundle, no build step and no JSX. It registers:
//   - one rail entry in the left sidebar (sidebar.panellist), and
//   - the full main page behind it (main, keyed by the same id).
// Job state lives on the Host; this page restores the latest job when it is
// re-entered, including the log, so switching to the conversation and back
// does not lose the running task.

window.__ModuleLoader__.load({
  id: 'xiyoungtools',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const PANEL_ID = 'xiyoungtools'
    const URL_KEY = 'xiyoungtools:url'
    const MODEL_KEY = 'xiyoungtools:model'

    const C = {
      bg: 'var(--dsw-alias-bg-base, #101014)',
      card: 'var(--dsw-alias-card-fill, rgba(255,255,255,0.045))',
      border: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.12))',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.035))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.065))',
      text: 'var(--dsw-alias-label-primary, #ececf1)',
      muted: 'var(--dsw-alias-label-secondary, #a0a0aa)',
      faint: 'var(--dsw-alias-label-tertiary, #6f6f7a)',
      accent: 'var(--dsw-alias-brand-primary, #4f7cff)',
      onAccent: 'var(--dsw-alias-label-on-color, #ffffff)',
      error: 'var(--dsw-alias-label-error, #ff6b6b)',
      warn: 'var(--dsw-alias-label-warning, #e0a33e)',
      success: 'var(--dsw-alias-label-success, #3ecf8e)',
      mono: 'var(--dsh-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)'
    }

    const S = {
      page: {
        height: '100%',
        overflowY: 'auto',
        background: C.bg,
        color: C.text,
        boxSizing: 'border-box',
        padding: 'calc(var(--dsh-frame-top-clearance, 48px) + 20px) 28px 48px'
      },
      inner: { maxWidth: 980, margin: '0 auto' },
      header: { display: 'flex', alignItems: 'center', gap: 14 },
      brand: {
        width: 44,
        height: 44,
        borderRadius: 13,
        background: 'rgba(79,124,255,0.14)',
        color: C.accent,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto'
      },
      title: { margin: 0, fontSize: 24, lineHeight: 1.2, fontWeight: 650, letterSpacing: '-0.02em' },
      subtitle: { margin: '4px 0 0', fontSize: 13, color: C.muted },
      back: {
        marginLeft: 'auto',
        height: 34,
        padding: '0 12px',
        borderRadius: 9,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.muted,
        fontSize: 12.5,
        cursor: 'pointer'
      },
      card: {
        background: C.card,
        border: '1px solid ' + C.border,
        borderRadius: 16,
        padding: 20,
        marginTop: 18
      },
      h2: { margin: 0, fontSize: 16, fontWeight: 620 },
      cardDesc: { margin: '5px 0 0', fontSize: 12.5, lineHeight: 1.6, color: C.muted, wordBreak: 'break-word' },
      tag: {
        flex: '0 0 auto',
        fontSize: 11,
        color: C.accent,
        background: 'rgba(79,124,255,0.12)',
        border: '1px solid rgba(79,124,255,0.28)',
        padding: '3px 9px',
        borderRadius: 999
      },
      row: { display: 'flex', gap: 10, marginTop: 14 },
      input: {
        flex: 1,
        minWidth: 0,
        height: 40,
        borderRadius: 10,
        border: '1px solid ' + C.border,
        background: C.layer1,
        color: C.text,
        padding: '0 12px',
        fontSize: 13.5,
        outline: 'none'
      },
      button: {
        height: 40,
        padding: '0 18px',
        borderRadius: 10,
        border: 'none',
        background: C.accent,
        color: C.onAccent,
        fontSize: 13.5,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      },
      buttonDisabled: { opacity: 0.55, cursor: 'default' },
      options: {
        display: 'flex',
        gap: 18,
        alignItems: 'center',
        marginTop: 12,
        fontSize: 12.5,
        color: C.muted,
        flexWrap: 'wrap'
      },
      select: {
        height: 32,
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: C.layer1,
        color: C.text,
        padding: '0 8px',
        fontSize: 12.5
      },
      error: {
        marginTop: 12,
        padding: '9px 12px',
        borderRadius: 9,
        border: '1px solid rgba(255,107,107,0.35)',
        background: 'rgba(255,107,107,0.08)',
        color: C.error,
        fontSize: 12.5,
        lineHeight: 1.5,
        wordBreak: 'break-word'
      },
      status: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 12.5, color: C.muted },
      dot: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' },
      bar: { height: 6, borderRadius: 999, background: C.layer2, overflow: 'hidden', marginTop: 10 },
      barFill: { height: '100%', borderRadius: 999, background: C.accent, transition: 'width .3s ease' },
      log: {
        marginTop: 12,
        background: C.layer1,
        border: '1px solid ' + C.border,
        borderRadius: 10,
        padding: '10px 12px',
        maxHeight: 200,
        overflow: 'auto',
        fontFamily: C.mono,
        fontSize: 11.5,
        lineHeight: 1.65,
        color: C.muted,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      secondary: {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.text,
        fontSize: 12.5,
        cursor: 'pointer'
      },
      secondarySmall: {
        height: 26,
        padding: '0 9px',
        borderRadius: 7,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.muted,
        fontSize: 11.5,
        cursor: 'pointer'
      },
      secondaryLink: {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.text,
        fontSize: 12.5,
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center'
      },
      thumbs: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 14 },
      thumb: { width: '100%', borderRadius: 8, border: '1px solid ' + C.border, display: 'block' },
      report: {
        marginTop: 14,
        background: C.layer1,
        border: '1px solid ' + C.border,
        borderRadius: 12,
        padding: 16,
        maxHeight: 440,
        overflow: 'auto',
        fontSize: 12.5,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: C.text,
        fontFamily: 'var(--dsh-font-family-text, inherit)'
      },
      historyRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: C.layer1,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        padding: '7px 10px',
        color: C.text,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit'
      },
      more: {
        border: '1px dashed ' + C.border,
        borderRadius: 14,
        padding: '18px 20px',
        marginTop: 16,
        color: C.faint,
        fontSize: 12.5,
        lineHeight: 1.6
      },
      footer: { marginTop: 18, fontSize: 11.5, lineHeight: 1.7, color: C.faint, wordBreak: 'break-word' },
      tabs: {
        display: 'flex',
        gap: 4,
        marginTop: 20,
        padding: 4,
        background: C.layer1,
        border: '1px solid ' + C.border,
        borderRadius: 12,
        overflowX: 'auto'
      },
      tab: {
        flex: '0 0 auto',
        height: 34,
        padding: '0 14px',
        borderRadius: 9,
        border: 'none',
        background: 'transparent',
        color: C.muted,
        fontSize: 12.5,
        fontWeight: 550,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      },
      tabActive: {
        background: C.accent,
        color: C.onAccent,
        fontWeight: 620
      }
    }

    function readStorage(key, fallback) {
      try {
        return window.localStorage.getItem(key) || fallback
      } catch {
        return fallback
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* storage is optional */
      }
    }

    function shortUrl(url) {
      return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 64)
    }

    function statusColor(status) {
      if (status === 'done') return C.success
      if (status === 'error') return C.error
      if (status === 'running' || status === 'queued') return C.accent
      return C.faint
    }

    function statusLabel(status) {
      if (status === 'done') return '完成'
      if (status === 'error') return '失败'
      if (status === 'running') return '进行中'
      if (status === 'queued') return '排队'
      return ''
    }

    function timeLabel(ts) {
      try {
        return new Date(ts).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        })
      } catch {
        return ''
      }
    }

    async function api(pathname, options) {
      const response = await fetch(pathname, options)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(data.error || ('HTTP ' + response.status))
        error.jobId = data.jobId
        error.status = response.status
        throw error
      }
      return data
    }

    function ToolboxIcon(props) {
      const size = props && props.size ? props.size : 18
      const active = !!(props && props.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { opacity: active ? 1 : 0.82 },
        'aria-hidden': true
      },
        h('rect', { x: 3, y: 7, width: 18, height: 13, rx: 2.5 }),
        h('path', { d: 'M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7' }),
        h('path', { d: 'M3 11h18' }),
        h('path', { d: 'M10 13.5h4' })
      )
    }


    function formatBytes(bytes) {
      const size = Number(bytes) || 0
      if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      if (size >= 1024) return Math.round(size / 1024) + ' KB'
      return size + ' B'
    }

    function formatClock(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const hh = Math.floor(total / 3600)
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      const pad = (n) => String(n).padStart(2, '0')
      return (hh > 0 ? pad(hh) + ':' : '') + pad(mm) + ':' + pad(ss)
    }

    const CLIP_SOURCE_KEY = 'xiyoungtools:clip-source'
    const CLIP_START_KEY = 'xiyoungtools:clip-start'
    const CLIP_LEN_KEY = 'xiyoungtools:clip-length'

    function ClipCard(props) {
      const [busy, setBusy] = useState(false)
      const [source, setSource] = useState(() => readStorage(CLIP_SOURCE_KEY, ''))
      const [start, setStart] = useState(() => readStorage(CLIP_START_KEY, '00:00'))
      const [length, setLength] = useState(() => readStorage(CLIP_LEN_KEY, '00:30'))
      const [mode, setMode] = useState('precise')
      const [clip, setClip] = useState(null)
      const [history, setHistory] = useState([])
      const [error, setError] = useState('')
      const alive = useRef(true)
      const timer = useRef(null)
      const activeId = useRef(null)

      const refreshHistory = async () => {
        try {
          const data = await api('/xiyoungtools/clips')
          if (alive.current) setHistory(data.clips || [])
        } catch {
          /* history is a convenience */
        }
      }

      const poll = async (id) => {
        try {
          const next = await api('/xiyoungtools/clip?id=' + encodeURIComponent(id))
          if (!alive.current || activeId.current !== id) return
          setClip(next)
          if (next.status === 'running' || next.status === 'queued') {
            setBusy(true)
            timer.current = setTimeout(() => { poll(id) }, 900)
            return
          }
          setBusy(false)
          await refreshHistory()
          if (next.status === 'error') setError(next.error || '截取失败')
        } catch (err) {
          if (!alive.current) return
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      useEffect(() => {
        alive.current = true
        ;(async () => {
          try {
            const data = await api('/xiyoungtools/clips')
            if (!alive.current) return
            const list = data.clips || []
            setHistory(list)
            const latest = list.find((entry) => entry.status === 'running' || entry.status === 'queued') || list[0]
            if (latest) {
              activeId.current = latest.id
              setClip(latest)
              if (latest.status === 'running' || latest.status === 'queued') poll(latest.id)
            }
          } catch {
            /* no clips yet */
          }
        })()
        return () => {
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const startClip = async () => {
        const text = String(source || '').trim()
        if (!text) {
          setError('请填写本地文件路径、直链或 B 站链接')
          return
        }
        if (!String(start || '').trim()) {
          setError('请填写起始时间')
          return
        }
        writeStorage(CLIP_SOURCE_KEY, text)
        writeStorage(CLIP_START_KEY, start)
        writeStorage(CLIP_LEN_KEY, length)
        setError('')
        setBusy(true)
        setClip(null)
        try {
          const result = await api('/xiyoungtools/clip', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: text, start: start, duration: length, mode: mode })
          })
          await refreshHistory()
          activeId.current = result.clipId
          await poll(result.clipId)
        } catch (err) {
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      const cancel = async () => {
        if (!clip) return
        try {
          await api('/xiyoungtools/clip-cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: clip.id })
          })
          setClip(Object.assign({}, clip, { stage: '取消中' }))
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      const attach = async (id) => {
        activeId.current = id
        setError('')
        await poll(id)
      }

      const statusText = !clip ? ''
        : (clip.stage || (clip.status === 'done' ? '已完成' : clip.status === 'error' ? '失败' : '处理中'))
      const isAudio = clip && clip.outputName ? clip.outputName.toLowerCase().endsWith('.mp3') : false

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
          h('div', {},
            h('h2', { style: S.h2 }, '视频 / 音频截取'),
            h('p', { style: S.cardDesc }, '本地文件、直链或 B 站链接 → 按起始时间与长度截一段；有画面出 mp4，纯音频出 mp3')
          ),
          h('span', { style: S.tag }, '新')
        ),

        h('div', { style: S.row },
          h('input', {
            style: S.input,
            value: source,
            placeholder: 'D:\\media\\a.mp4 或 https://... 或 BV 号',
            onChange: (event) => { setSource(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter' && !busy) startClip() }
          })
        ),

        h('div', { style: S.options },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            '起始',
            h('input', {
              style: Object.assign({}, S.select, { width: 88, fontFamily: C.mono }),
              value: start,
              placeholder: '00:30',
              onChange: (event) => { setStart(event.target.value) }
            })
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            '长度',
            h('input', {
              style: Object.assign({}, S.select, { width: 88, fontFamily: C.mono }),
              value: length,
              placeholder: '00:30',
              onChange: (event) => { setLength(event.target.value) }
            })
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            '模式',
            h('select', {
              style: S.select,
              value: mode,
              onChange: (event) => { setMode(event.target.value) }
            },
              h('option', { value: 'precise' }, '精确（重编码）'),
              h('option', { value: 'fast' }, '快速（流复制）')
            )
          ),
          h('button', {
            style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
            disabled: busy,
            onClick: startClip
          }, busy ? '截取中…' : '开始截取')
        ),

        h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
          '时间可写秒数（83.5）或 mm:ss / hh:mm:ss；长度留空表示截到结尾。快速模式起点会对齐到最近关键帧。'
        ),
        h('div', { style: { marginTop: 6, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
          '截完会自动做一次韵律分析——听语气用音频就够，这里不显示画面。'
        ),

        error ? h('div', { style: S.error }, error) : null,

        clip ? h('div', { style: { marginTop: 16 } },
          h('div', { style: S.status },
            h('span', { style: Object.assign({}, S.dot, { background: statusColor(clip.status) }) }),
            h('span', {}, statusText + ' · ' + formatClock(clip.start) + ' 起 ' + formatClock(clip.duration || 0)
              + (clip.outputBytes ? ' · ' + formatBytes(clip.outputBytes) : '')),
            h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
              (clip.status === 'running' || clip.status === 'queued')
                ? h('button', { style: S.secondarySmall, onClick: cancel }, '取消')
                : null,
              h('span', { style: { color: C.faint, fontFamily: C.mono, fontSize: 10.5 } }, clip.id)
            )
          ),
          (clip.log || []).length ? h('div', { style: S.log },
            clip.log.slice(-40).map((line, index) => h('div', { key: index }, line))
          ) : null,
          clip.status === 'done' && clip.outputPath ? h('div', { style: { marginTop: 14 } },
            // 只放音频：这一段是用来听语气的，画面在这里没有用
            h('audio', {
              controls: true,
              style: { width: '100%' },
              src: '/xiyoungtools/clip-preview?id=' + encodeURIComponent(clip.id)
            }),
            h('div', { style: Object.assign({}, S.actions, { marginTop: 10 }) },
              h('a', {
                style: S.secondaryLink,
                href: '/xiyoungtools/clip-file?id=' + encodeURIComponent(clip.id)
              }, '下载 ' + (clip.outputName || '片段')),
              clip.prosodyId
                ? h('button', {
                  style: S.secondary,
                  onClick: () => { props.onAnalyze(clip.prosodyId) }
                }, '看韵律分析')
                : null,
              h('span', { style: { fontSize: 11, color: C.faint, wordBreak: 'break-all' } }, clip.outputPath)
            )
          ) : null
        ) : null,

        history.length ? h('div', { style: { marginTop: 16 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('div', { style: { fontSize: 12, color: C.muted } }, '最近截取'),
            h('button', { style: S.secondarySmall, onClick: refreshHistory }, '刷新')
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
            history.slice(0, 6).map((entry) => h('button', {
              key: entry.id,
              style: Object.assign({}, S.historyRow, clip && clip.id === entry.id ? { borderColor: C.accent } : null),
              onClick: () => { attach(entry.id) },
              title: entry.source
            },
              h('span', { style: Object.assign({}, S.dot, { background: statusColor(entry.status) }) }),
              h('span', { style: { fontFamily: C.mono, fontSize: 10.5, color: C.faint, flex: '0 0 auto' } }, entry.id.slice(0, 15)),
              h('span', { style: { fontSize: 11.5, color: C.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortUrl(entry.source)),
              h('span', { style: { fontSize: 11, color: C.faint, flex: '0 0 auto' } }, statusLabel(entry.status)),
              h('span', { style: { fontSize: 10.5, color: C.faint, flex: '0 0 auto' } }, timeLabel(entry.createdAt))
            ))
          )
        ) : null
      )
    }


    const PROSODY_SOURCE_KEY = 'xiyoungtools:prosody-source'

    /** 把一条曲线画成 SVG path。null 值断开。 */
    function curvePath(values, times, w, h, min, max, tmax) {
      if (!values || !values.length) return ''
      const span = max - min || 1
      const tx = tmax > 0 ? tmax : 1
      let d = ''
      let pen = false
      for (let i = 0; i < values.length; i++) {
        const v = values[i]
        if (v === null || v === undefined || !isFinite(v)) {
          pen = false
          continue
        }
        const x = (times[i] / tx) * w
        const y = h - ((v - min) / span) * h
        d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '
        pen = true
      }
      return d
    }

    function ProsodyChart(props) {
      const curves = props.curves
      if (!curves || !curves.times || !curves.times.length) return null
      const W = 100
      const H = 26
      const times = curves.times
      const tmax = times[times.length - 1] || 1

      // 半音曲线：固定 -12..+12
      const semi = curvePath(curves.semitone, times, W, H, -12, 12, tmax)
      // 能量：-60..0
      const db = curvePath(curves.db, times, W, H, -60, 0, tmax)
      // 抖动：0..2 半音
      const jit = curvePath(curves.jitter, times, W, H, 0, 2, tmax)

      // 状态带
      const stateColor = { voiced: '#4f7cff', unvoiced: '#b58cff', silence: 'rgba(255,255,255,0.10)' }
      const bands = []
      const state = curves.state || []
      let i = 0
      while (i < state.length) {
        const s = state[i]
        let j = i
        while (j + 1 < state.length && state[j + 1] === s) j++
        bands.push({
          x: (times[i] / tmax) * W,
          w: Math.max(0.05, ((times[j] - times[i]) / tmax) * W),
          color: stateColor[s] || stateColor.silence
        })
        i = j + 1
      }

      const viewBox = '0 0 ' + W + ' ' + H
      const line = { fill: 'none', strokeWidth: 0.5, vectorEffect: 'non-scaling-stroke' }

      const block = (label, path, color) => h('div', { style: { marginTop: 8 } },
        h('div', { style: { fontSize: 11, color: C.faint, marginBottom: 2 } }, label),
        h('svg', {
          viewBox: viewBox,
          preserveAspectRatio: 'none',
          style: { width: '100%', height: 54, display: 'block', background: C.layer1, borderRadius: 8, border: '1px solid ' + C.border }
        }, h('path', { d: path, style: Object.assign({}, line, { stroke: color }) }))
      )

      return h('div', { style: { marginTop: 12 } },
        block('音高（半音，相对说话人中位 ' + Math.round(curves.refHz || 0) + ' Hz）', semi, '#4f7cff'),
        block('响度（dB）', db, '#3ecf8e'),
        block('微颤（半音标准差）', jit, '#ffb84d'),
        h('div', { style: { marginTop: 8 } },
          h('div', { style: { fontSize: 11, color: C.faint, marginBottom: 2 } }, '浊音 / 清音 / 静音'),
          h('svg', {
            viewBox: '0 0 ' + W + ' 4',
            preserveAspectRatio: 'none',
            style: { width: '100%', height: 14, display: 'block', borderRadius: 6, overflow: 'hidden' }
          }, bands.map((b, idx) => h('rect', {
            key: idx, x: b.x, y: 0, width: b.w, height: 4, fill: b.color
          })))
        )
      )
    }

    function ProsodyCard(props) {
      const compact = !!(props && props.compact)
      const [busy, setBusy] = useState(false)
      const [job, setJob] = useState(null)
      const [source, setSource] = useState(() => readStorage(PROSODY_SOURCE_KEY, ''))
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      const timer = useRef(null)
      const activeId = useRef(null)

      const poll = async (id) => {
        try {
          const next = await api('/xiyoungtools/prosody?id=' + encodeURIComponent(id))
          if (!alive.current || activeId.current !== id) return
          setJob(next)
          if (next.status === 'running' || next.status === 'queued') {
            setBusy(true)
            timer.current = setTimeout(() => { poll(id) }, 900)
            return
          }
          setBusy(false)
          if (next.status === 'done') {
            const curves = await api('/xiyoungtools/prosody-curves?id=' + encodeURIComponent(id))
            if (alive.current && activeId.current === id) setData(curves)
          } else {
            setError(next.error || '分析失败')
          }
        } catch (err) {
          if (!alive.current) return
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      useEffect(() => {
        alive.current = true
        // 从截取页跳过来时，直接接那一条，不用再找
        if (props && props.initialId) {
          activeId.current = props.initialId
          poll(props.initialId)
          return () => {
            alive.current = false
            if (timer.current) clearTimeout(timer.current)
          }
        }
        ;(async () => {
          try {
            const res = await api('/xiyoungtools/prosodies')
            if (!alive.current) return
            const list = res.prosodies || []
            const latest = list.find((entry) => entry.status === 'running' || entry.status === 'queued') || list[0]
            if (latest) {
              activeId.current = latest.id
              setJob(latest)
              if (latest.status === 'done') {
                const curves = await api('/xiyoungtools/prosody-curves?id=' + encodeURIComponent(latest.id))
                if (alive.current) setData(curves)
              } else if (latest.status === 'running') {
                poll(latest.id)
              }
            }
          } catch {
            /* nothing yet */
          }
        })()
        return () => {
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const start = async () => {
        const text = String(source || '').trim()
        if (!text) {
          setError('请填写本地文件路径、直链或 B 站链接')
          return
        }
        writeStorage(PROSODY_SOURCE_KEY, text)
        setError('')
        setBusy(true)
        setData(null)
        setJob(null)
        try {
          const res = await api('/xiyoungtools/prosody', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: text })
          })
          activeId.current = res.prosodyId
          await poll(res.prosodyId)
        } catch (err) {
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      const cancel = async () => {
        if (!job) return
        try {
          await api('/xiyoungtools/prosody-cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: job.id })
          })
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      const s = data && data.summary ? data.summary : (job && job.summary ? job.summary : null)
      const isRunning = job && (job.status === 'running' || job.status === 'queued')

      const body = h('div', {},
        h('section', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
            h('div', {},
              h('h2', { style: S.h2 }, compact ? '韵律分析（这段截取）' : '韵律分析'),
              h('p', { style: S.cardDesc }, '第二层：基频曲线、半音走向、微颤、清浊三分类。全部本机算，不上传。')
            ),
            h('span', { style: S.tag }, '本地')
          ),
          h('div', { style: S.row },
            h('input', {
              style: S.input,
              value: source,
              placeholder: 'D:\media\voice.wav 或 https://... 或 BV 号',
              onChange: (event) => { setSource(event.target.value) },
              onKeyDown: (event) => { if (event.key === 'Enter' && !busy) start() }
            }),
            h('button', {
              style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
              disabled: busy,
              onClick: start
            }, busy ? '分析中…' : '开始分析')
          ),
          h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
            '只给数字，不给"这句话是催还是试探"的判断——那需要下面的标注样本。'
          ),
          error ? h('div', { style: S.error }, error) : null,

          job ? h('div', { style: S.status },
            h('span', { style: Object.assign({}, S.dot, { background: statusColor(job.status) }) }),
            h('span', {}, (job.stage || job.status) + (job.source ? ' · ' + shortUrl(job.source) : '')),
            h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
              isRunning ? h('button', { style: S.secondarySmall, onClick: cancel }, '取消') : null,
              h('span', { style: { color: C.faint, fontFamily: C.mono, fontSize: 10.5 } }, job.id)
            )
          ) : null,

          s ? h('div', { style: { marginTop: 14 } },
            // 疑似非人声：警告放在数字前面
            s.suspectedNonSpeech ? h('div', {
              style: { marginBottom: 12, padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(255,107,107,0.45)', background: 'rgba(255,107,107,0.10)', color: C.error, fontSize: 12.5, lineHeight: 1.65 }
            },
              h('div', { style: { fontWeight: 650, marginBottom: 4 } }, '⚠ 疑似非人声——下面的数字不可信'),
              (s.nonSpeechReasons || []).map((r, i) => h('div', { key: i }, '· ' + r)),
              h('div', { style: { marginTop: 6, color: C.muted } }, '这段可能是噪声（雨声、风声、纯背景音），基频和微颤都是追踪器猜出来的。不要当成声音素材导入样本库。')
            ) : null,
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 } },
              [
                ['时长', (s.duration || 0).toFixed(2) + ' 秒'],
                ['基频中位', (s.f0Median || 0).toFixed(1) + ' Hz'],
                ['音域跨度', (s.semitoneRange || 0).toFixed(1) + ' 半音'],
                ['走向', (s.trendSemitone || 0) > 0.5 ? '往上 +' + (s.trendSemitone).toFixed(1)
                  : (s.trendSemitone || 0) < -0.5 ? '沉下去 ' + (s.trendSemitone).toFixed(1)
                  : '持平'],
                ['微颤中位', (s.jitterMedian || 0).toFixed(2) + ' 半音'],
                ['浊音占比', Math.round((s.voicedRatio || 0) * 100) + '%']
              ].map((pair) => h('div', {
                key: pair[0],
                style: { background: C.layer1, border: '1px solid ' + C.border, borderRadius: 9, padding: '8px 10px' }
              },
                h('div', { style: { fontSize: 10.5, color: C.faint } }, pair[0]),
                h('div', { style: { fontSize: 14, marginTop: 2, fontFamily: C.mono } }, pair[1])
              ))
            ),
            // 转写文本：和数字并排看，才知道"抖"落在哪个字上
            data && data.transcript ? h('div', {
              style: { marginTop: 12, padding: '10px 12px', background: C.layer1, border: '1px solid ' + C.border, borderRadius: 9 }
            },
              h('div', { style: { fontSize: 10.5, color: C.faint, marginBottom: 4 } }, '语音转写'),
              h('div', { style: { fontSize: 13.5, lineHeight: 1.7, color: C.text } }, data.transcript)
            ) : null,
            data && data.segments && data.segments.length ? h('div', { style: { marginTop: 10 } },
              h('div', { style: { fontSize: 10.5, color: C.faint, marginBottom: 4 } }, '逐句对照（' + data.segments.length + ' 句）'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                data.segments.map((seg, i) => h('div', {
                  key: i,
                  style: { display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 9px', background: C.layer2, borderRadius: 7, fontSize: 12 }
                },
                  h('span', { style: { fontFamily: C.mono, fontSize: 10.5, color: C.faint, flex: '0 0 auto' } },
                    seg.start.toFixed(2) + '–' + seg.end.toFixed(2) + 's'),
                  h('span', { style: { flex: 1, minWidth: 0 } }, seg.text),
                  seg.f0Median ? h('span', { style: { fontFamily: C.mono, fontSize: 10.5, color: C.muted, flex: '0 0 auto' } },
                    seg.f0Median.toFixed(0) + 'Hz · 抖' + (seg.jitterMedian || 0).toFixed(2)) : null
                ))
              )
            ) : null,
            data && data.curves ? h(ProsodyChart, { curves: data.curves }) : null,
            job ? h('audio', {
              controls: true,
              style: { width: '100%', marginTop: 12 },
              src: '/xiyoungtools/prosody-audio?id=' + encodeURIComponent(job.id)
            }) : null,
            // 存笔记 / 找相似：分析完最想做的两件事
            job && job.id ? h(NoteFromProsody, { job: job, data: data, onSaved: () => {} }) : null
          ) : null
        ),

      )
      return body
    }


    // ---------------------------------------------------------------------
    // 从韵律分析存笔记 + 在笔记里找相似
    // 挂在 ProsodyCard 结果下方——分析完不用切页就能记下来
    // ---------------------------------------------------------------------
    function NoteFromProsody(props) {
      const job = props.job
      const [open, setOpen] = useState(false)
      const [note, setNote] = useState('')
      const [label, setLabel] = useState('')
      const [start, setStart] = useState('')
      const [end, setEnd] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [saved, setSaved] = useState('')
      const [similar, setSimilar] = useState(null)

      const save = async () => {
        const n = String(note || '').trim()
        const l = String(label || '').trim()
        if (!n && !l) { setError('写点东西再存'); return }
        setError(''); setSaved(''); setBusy(true)
        try {
          await api('/xiyoungtools/label-from-prosody', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prosodyId: job.id,
              note: n,
              label: l,
              start: start === '' ? 0 : (Number(start) || 0),
              end: end === '' ? 0 : (Number(end) || 0)
            })
          })
          setSaved('已存进笔记')
          setNote(''); setLabel('')
          if (props.onSaved) props.onSaved()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      const findSimilar = async () => {
        setError(''); setSimilar(null); setBusy(true)
        try {
          const r = await api('/xiyoungtools/label-find-similar', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prosodyId: job.id, limit: 8 })
          })
          setSimilar(r)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid ' + C.border }
      },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', {
            style: S.secondary,
            onClick: () => { setOpen(!open); setSimilar(null) }
          }, open ? '收起' : '存为笔记'),
          h('button', {
            style: S.secondary,
            disabled: busy,
            onClick: findSimilar
          }, busy ? '查询中…' : '在笔记里找相似')
        ),

        error ? h('div', { style: S.error }, error) : null,
        saved ? h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.success } }, saved) : null,

        open ? h('div', { style: { marginTop: 10 } },
          h('textarea', {
            style: Object.assign({}, S.input, {
              width: '100%', height: 70, padding: '9px 12px',
              resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.65
            }),
            value: note,
            placeholder: '你观察到什么？比如「尾音提起来，后半段明显更快」',
            onChange: (e) => setNote(e.target.value)
          }),
          h('div', { style: Object.assign({}, S.options, { marginTop: 8 }) },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              '标签',
              h('input', {
                style: Object.assign({}, S.select, { width: 100 }), value: label,
                placeholder: '可选', onChange: (e) => setLabel(e.target.value)
              })
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              '起',
              h('input', {
                style: Object.assign({}, S.select, { width: 66, fontFamily: C.mono }), value: start,
                placeholder: '0', onChange: (e) => setStart(e.target.value)
              })
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              '止',
              h('input', {
                style: Object.assign({}, S.select, { width: 66, fontFamily: C.mono }), value: end,
                placeholder: '全段', onChange: (e) => setEnd(e.target.value)
              })
            ),
            h('button', {
              style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
              disabled: busy, onClick: save
            }, '记下')
          )
        ) : null,

        similar ? h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 6 } },
            '笔记池里共 ' + similar.total + ' 条带声纹的记录'),
          similar.ok === false
            ? h('div', { style: { fontSize: 11.5, color: C.warn } }, similar.error || '没有可比对的记录')
            : (similar.hits || []).length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                similar.hits.map((h2) => h('div', {
                  key: h2.id,
                  style: Object.assign({}, S.historyRow, { cursor: 'default' })
                },
                  h('span', { style: { fontSize: 10.5, fontFamily: C.mono, color: C.accent, flex: '0 0 auto' } },
                    h2.similarity.toFixed(4)),
                  h('span', { style: { fontSize: 11.5, color: C.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    (h2.label ? '[' + h2.label + '] ' : '') + (h2.note || '(无正文)'))
                ))
              )
              : h('div', { style: { fontSize: 11.5, color: C.faint } },
                '还没有带声纹的笔记。先在上面的分析里「存为笔记」，下次就能比了。'),
          (similar.caveats || []).length
            ? h('div', { style: { marginTop: 8, fontSize: 11, color: C.warn, lineHeight: 1.65 } },
              similar.caveats.map((c, i) => h('div', { key: i }, '⚠ ' + c)))
            : null
        ) : null
      )
    }

    // ---------------------------------------------------------------------
    // 声纹：两段音频像不像同一个人
    //
    // 这是这个插件里少数**产出可验证结论**的功能之一。阈值不是拍脑袋：
    //   CASIA 同人 0.70 / 异人 0.58（实测）
    //   但 resemblyzer 嵌入各向异性严重 —— 所有嵌入挤在同一锥角，
    //   原始余弦普遍偏高。实测 49 段音频里 29.4% 的配对会被误判成"同一人"，
    //   去中心化后降到 5.5%。
    // 所以界面同时给 raw 和 centered，并强调"看相对排序"。
    // ---------------------------------------------------------------------
    function SpeakerCompareCard() {
      const [a, setA] = useState('')
      const [b, setB] = useState('')
      const [extras, setExtras] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')

      const run = async () => {
        const sa = String(a || '').trim()
        const sb = String(b || '').trim()
        if (!sa || !sb) { setError('两条音频都要填'); return }
        setError(''); setBusy(true); setResult(null)
        try {
          const res = await api('/xiyoungtools/speaker-compare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              a: sa,
              b: sb,
              extra: String(extras || '').split('\n').map((x) => x.trim()).filter(Boolean)
            })
          })
          setResult(res)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%')

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
          h('div', {},
            h('h2', { style: S.h2 }, '声纹比对'),
            h('p', { style: S.cardDesc },
              '两段音频像不像同一个人。只回答「像不像」，不做身份识别，也不判断男女/年龄。')
          ),
          h('span', { style: S.tag }, '本地计算')
        ),

        // 原理说明：把"为什么不能只看一个数"讲在前面，避免误读
        h('div', {
          style: {
            marginTop: 10, padding: '8px 10px', background: C.layer1,
            border: '1px solid ' + C.border, borderRadius: 8,
            fontSize: 11.5, color: C.faint, lineHeight: 1.65
          }
        },
          'resemblyzer 的嵌入有各向异性：所有声音都挤在同一个锥角里，原始相似度天然偏高。',
          '实测拿毫不相干的两段声音也常拿到 0.6 以上。所以这里同时给「原始」和「去中心化」两个值，',
          '并强调看**相对排序**——凑够 3 条以上一起比，排在最前面的才值得深究。'),

        error ? h('div', { style: S.error }, error) : null,

        h('div', { style: { marginTop: 14 } },
          h('div', { style: S.row },
            h('input', {
              style: S.input, value: a,
              placeholder: '音频 A：本地路径 / 直链 / BV 号',
              onChange: (e) => setA(e.target.value)
            })
          ),
          h('div', { style: S.row },
            h('input', {
              style: S.input, value: b,
              placeholder: '音频 B',
              onChange: (e) => setB(e.target.value)
            })
          ),
          h('div', { style: { marginTop: 10 } },
            h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 5 } },
              '参考音频（可选，一行一条）。凑 3 条以上会算去中心化基准，判据更稳'),
            h('textarea', {
              style: Object.assign({}, S.input, {
                width: '100%', height: 60, padding: '8px 12px',
                resize: 'vertical', boxSizing: 'border-box', fontFamily: C.mono, fontSize: 12
              }),
              value: extras,
              placeholder: 'E:\\录音\\人声1.wav\nE:\\录音\\雨声.wav',
              onChange: (e) => setExtras(e.target.value)
            })
          ),
          h('div', { style: Object.assign({}, S.actions, { marginTop: 12 }) },
            h('button', {
              style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
              disabled: busy,
              onClick: run
            }, busy ? '计算中…' : '比对')
          )
        ),

        result && result.ok ? h('div', { style: { marginTop: 16, paddingTop: 14, borderTop: '1px solid ' + C.border } },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 } },
            [
              ['原始相似度', result.raw == null ? '—' : result.raw.toFixed(4)],
              ['去中心化', result.centered == null ? '—' : result.centered.toFixed(4)],
              ['本批次排位', result.rankPercentile == null ? '样本不足' : pct(result.rankPercentile)],
              ['参与音频', String((result.baseline && result.baseline.n) || 2) + ' 条']
            ].map((pair) => h('div', {
              key: pair[0],
              style: { background: C.layer1, border: '1px solid ' + C.border, borderRadius: 9, padding: '10px 12px' }
            },
              h('div', { style: { fontSize: 10.5, color: C.faint } }, pair[0]),
              h('div', { style: { fontSize: 15, marginTop: 3, fontFamily: C.mono } }, pair[1])
            ))
          ),

          result.verdictRaw ? h('div', { style: { marginTop: 10, fontSize: 12.5, color: C.text } },
            '原始判据：' + result.verdictRaw) : null,
          result.verdictRelative ? h('div', { style: { marginTop: 4, fontSize: 12.5, color: C.accent } },
            '相对判据：' + result.verdictRelative) : null,
          result.relativeNote ? h('div', { style: { marginTop: 4, fontSize: 11.5, color: C.warn } },
            '注：' + result.relativeNote) : null,

          result.baseline && result.baseline.centeredMedian != null
            ? h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.faint, fontFamily: C.mono } },
              '基准：中位 ' + result.baseline.centeredMedian.toFixed(4)
              + ' · P90 ' + (result.baseline.centeredP90 == null ? '—' : result.baseline.centeredP90.toFixed(4)))
            : null,

          (result.caveats || []).length ? h('div', { style: { marginTop: 10, fontSize: 11.5, color: C.warn, lineHeight: 1.7 } },
            result.caveats.map((c, i) => h('div', { key: i }, '⚠ ' + c))
          ) : null
        ) : null
      )
    }

    // ---------------------------------------------------------------------
    // 声音笔记（原「语气标注」）
    //
    // 重心从"贴一个预设标签"移到"写下你观察到的东西"。原因见 index.js 里
    // readLabels 上方的注释：靠人工标"催/试探/随口"去对照出情绪这条路，
    // 已经被实测否掉了（13.9% < 随机 16.7%）。
    //
    // 但你记的那些话本身是有价值的 —— "断 9 次，平均 0.86 秒一次"、
    // "响度标准差 2.01 dB"、"自相关 6.94 Hz"。所以这个面板改成：
    //   左边写笔记（正文为主，标签可选）
    //   右边按时间看历史，评测语料默认折叠
    // ---------------------------------------------------------------------
    function LabelCard() {
      const [labels, setLabels] = useState([])
      const [tally, setTally] = useState({})
      const [ownCount, setOwnCount] = useState(0)
      const [totalCount, setTotalCount] = useState(0)
      const [showCorpus, setShowCorpus] = useState(false)
      const [label, setLabel] = useState('')
      const [start, setStart] = useState('')
      const [end, setEnd] = useState('')
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const refresh = async () => {
        try {
          const res = await api('/xiyoungtools/labels' + (showCorpus ? '' : '?mine=1'))
          if (!alive.current) return
          setLabels(res.labels || [])
          setTally(res.tally || {})
          setOwnCount(res.ownCount != null ? res.ownCount : 0)
          setTotalCount(res.total != null ? res.total : 0)
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err))
        }
      }

      useEffect(() => {
        alive.current = true
        refresh()
        return () => { alive.current = false }
      }, [showCorpus])

      const add = async () => {
        const body = String(note || '').trim()
        const tag = String(label || '').trim()
        if (!body && !tag) {
          setError('写点什么再存：一段观察，或者一个短标签')
          return
        }
        setError('')
        setBusy(true)
        try {
          await api('/xiyoungtools/labels', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              dataset: 'note',
              label: tag,
              note: body,
              start: start === '' ? 0 : (Number(start) || 0),
              end: end === '' ? null : (Number(end) || null)
            })
          })
          setNote('')
          setLabel('')
          await refresh()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const remove = async (id) => {
        try {
          await api('/xiyoungtools/label-delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id })
          })
          await refresh()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      const keys = Object.keys(tally || {})

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
          h('div', {},
            h('h2', { style: S.h2 }, '声音笔记'),
            h('p', { style: S.cardDesc },
              '记下你对一段声音的观察。不用套预设标签——「7.76 秒里断了 9 次」这种话比标签有用。')
          ),
          h('span', { style: S.tag }, ownCount + ' 条笔记')
        ),

        // 定位说明：把"为什么不走训练集那套"讲清楚，免得以后再绕回去
        h('div', {
          style: {
            marginTop: 10, padding: '8px 10px', background: C.layer1,
            border: '1px solid ' + C.border, borderRadius: 8, fontSize: 11.5,
            color: C.faint, lineHeight: 1.65
          }
        },
          '这里不再攒"催/试探/随口"的训练样本：实测情绪分类准确率 13.9%，低于随机的 16.7%，',
          '再标多少条也得不出结论。但你对声音的观察是可靠的，所以留着这个笔记本。'),

        keys.length && showCorpus ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
          keys.map((key) => h('span', {
            key,
            style: { fontSize: 11, color: C.muted, background: C.layer2, border: '1px solid ' + C.border, borderRadius: 999, padding: '2px 9px' }
          }, key + ' ' + tally[key]))
        ) : null,

        error ? h('div', { style: S.error }, error) : null,

        // ===== 写笔记 =====
        h('div', { style: { marginTop: 14 } },
          h('textarea', {
            style: Object.assign({}, S.input, {
              width: '100%', height: 86, padding: '10px 12px', resize: 'vertical',
              lineHeight: 1.65, boxSizing: 'border-box'
            }),
            value: note,
            placeholder: '写你听到的：比如「鼓点 1.14 秒一次，音节跟着顿，像在数拍子」',
            onChange: (event) => { setNote(event.target.value) }
          }),

          h('div', { style: Object.assign({}, S.options, { marginTop: 10 }) },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              '标签',
              h('input', {
                style: Object.assign({}, S.select, { width: 110 }),
                value: label,
                placeholder: '可选',
                onChange: (event) => { setLabel(event.target.value) }
              })
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              '起',
              h('input', {
                style: Object.assign({}, S.select, { width: 70, fontFamily: C.mono }),
                value: start,
                placeholder: '可选',
                onChange: (event) => { setStart(event.target.value) }
              })
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              '止',
              h('input', {
                style: Object.assign({}, S.select, { width: 70, fontFamily: C.mono }),
                value: end,
                placeholder: '可选',
                onChange: (event) => { setEnd(event.target.value) }
              })
            ),
            h('button', {
              style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
              disabled: busy,
              onClick: add
            }, busy ? '保存中…' : '记下')
          )
        ),

        // ===== 历史 =====
        h('div', { style: { marginTop: 18, paddingTop: 14, borderTop: '1px solid ' + C.border } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, color: C.muted } },
              showCorpus ? '全部记录（含评测语料）' : '我的笔记'),
            h('button', {
              style: S.secondarySmall,
              onClick: () => { setShowCorpus(!showCorpus) }
            }, showCorpus ? '只看我的' : '含评测语料（' + totalCount + ' 条）')
          ),

          labels.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 } },
            labels.slice(0, 40).map((item) => h('div', {
              key: item.id,
              style: Object.assign({}, S.historyRow, { cursor: 'default', alignItems: 'flex-start' })
            },
              h('div', { style: { flex: 1, minWidth: 0 } },
                // 笔记正文优先展示
                item.note
                  ? h('div', {
                    style: {
                      fontSize: 12.5, color: C.text, lineHeight: 1.65,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                    }
                  }, item.note)
                  : null,
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: item.note ? 5 : 0 } },
                  item.label ? h('span', {
                    style: { fontSize: 11, color: C.accent, fontWeight: 600 }
                  }, item.label) : null,
                  (item.start !== null && item.start !== undefined)
                    ? h('span', { style: { fontSize: 10.5, color: C.faint, fontFamily: C.mono } },
                      item.start + 's' + (item.end ? '–' + item.end + 's' : ''))
                    : null,
                  item.features && item.features.f0Median
                    ? h('span', { style: { fontSize: 10.5, color: C.faint, fontFamily: C.mono } },
                      'f0 ' + Math.round(item.features.f0Median) + 'Hz')
                    : null,
                  item.features && item.features.jitterMedian
                    ? h('span', { style: { fontSize: 10.5, color: C.faint, fontFamily: C.mono } },
                      '抖 ' + item.features.jitterMedian.toFixed(2))
                    : null,
                  item.text ? h('span', {
                    style: { fontSize: 10.5, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }
                  }, '「' + item.text + '」') : null,
                  item.dataset ? h('span', { style: { fontSize: 10, color: C.faint } }, item.dataset) : null
                )
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: '0 0 auto' } },
                h('span', { style: { fontSize: 10.5, color: C.faint } }, timeLabel(item.createdAt)),
                h('button', {
                  style: S.secondarySmall,
                  onClick: () => remove(item.id)
                }, '删')
              )
            ))
          ) : h('div', { style: { marginTop: 12, fontSize: 11.5, color: C.faint } },
            showCorpus ? '还没有任何记录。'
              : '还没有笔记。上面写一段就能存下——标不标标签都行。'
          )
        )
      )
    }

    function CacheCard(props) {
      const stats = props.stats
      // 8 个任务目录 + 标注。之前只列了 3 个，其余（含 analyze/batches）在页面上
      // 看不见，也就永远清不掉——只增不减。
      const rows = stats ? [
        ['视频分析', stats.runs, '报告、摘要、拼图会保留；源视频和抽出的帧会清掉'],
        ['音频截取', stats.clips, '成品片段保留；下载的源素材会清掉'],
        ['韵律分析', stats.prosody, 'prosody.json / prosody.md 保留；解码的 wav 会清掉'],
        ['一站式分析', stats.analyze, '报告保留；源视频和解码的 wav 会清掉'],
        ['批量导入', stats.batches, 'batch.json / batch.md 保留'],
        ['说话人聚类', stats.clusters, 'cluster.json / cluster.md 保留'],
        ['说话人分离', stats.diarize, 'diarize.json / diarize.md 保留'],
        ['特征评测', stats.bench, 'bench.json / bench.md 保留'],
        ['声音笔记', stats.labels, '笔记永远不会被清理']
      ].filter((row) => row[1]) : []

      const total = stats
        ? rows.reduce((sum, row) => sum + (row[1].bytes || 0), 0)
        : 0

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
          h('div', {},
            h('h2', { style: S.h2 }, '缓存'),
            h('p', { style: S.cardDesc }, '报告生成后，中间产物就没用了。清理只删这些，报告和成品都留着。')
          ),
          h('button', { style: S.secondarySmall, onClick: props.onRefresh }, '刷新')
        ),

        props.error ? h('div', { style: S.error }, props.error) : null,
        props.notice ? h('div', {
          style: { marginTop: 10, padding: '8px 10px', background: C.layer1, border: '1px solid ' + C.border, borderRadius: 8, fontSize: 11.5, color: C.success, lineHeight: 1.6 }
        }, props.notice) : null,

        stats ? h('div', { style: { marginTop: 12 } },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } },
            rows.map((row) => h('div', {
              key: row[0],
              style: { background: C.layer1, border: '1px solid ' + C.border, borderRadius: 9, padding: '10px 12px' }
            },
              h('div', { style: { fontSize: 10.5, color: C.faint } }, row[0] + ' · ' + row[1].count + ' 个'),
              h('div', { style: { fontSize: 15, marginTop: 3, fontFamily: C.mono } }, formatBytes(row[1].bytes)),
              h('div', { style: { fontSize: 10.5, color: C.faint, marginTop: 4, lineHeight: 1.5 } }, row[2])
            ))
          ),
          h('div', { style: { marginTop: 12, fontSize: 12, color: C.muted } },
            '合计 ' + formatBytes(total)),
          h('div', { style: Object.assign({}, S.actions, { marginTop: 12 }) },
            h('button', {
              style: props.cleaning ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
              disabled: props.cleaning,
              onClick: () => props.onClean({ all: false })
            }, props.cleaning ? '清理中…' : '清理中间产物'),
            h('button', {
              style: S.secondary,
              disabled: props.cleaning,
              onClick: () => props.onClean({ all: true })
            }, '删掉整个任务目录'),
            h('button', {
              style: S.secondary,
              disabled: props.cleaning,
              onClick: () => props.onClean({ all: true, includeOutputs: true })
            }, '连成品片段一起删')
          ),
          h('div', { style: { marginTop: 10, fontSize: 11, color: C.faint, lineHeight: 1.6 } },
            '「删掉整个任务目录」会移除任务记录（报告也跟着没）；「连成品片段一起删」还会删掉截取出来的 mp4/mp3。标注样本永远不动。')
        ) : h('div', { style: { marginTop: 12, fontSize: 12, color: C.faint } }, '读取中…')
      )
    }


    function BatchCard() {
      const [job, setJob] = useState(null)
      const [dir, setDir] = useState('')
      const [labelFrom, setLabelFrom] = useState('auto')
      const [busy, setBusy] = useState(false)
      const [payload, setPayload] = useState(null)
      const [error, setError] = useState('')
      const [imported, setImported] = useState(null)
      const alive = useRef(true)
      const timer = useRef(null)
      const activeId = useRef(null)

      const poll = async (id) => {
        try {
          const next = await api('/xiyoungtools/batch?id=' + encodeURIComponent(id))
          if (!alive.current || activeId.current !== id) return
          setJob(next)
          if (next.status === 'running' || next.status === 'queued') {
            setBusy(true)
            timer.current = setTimeout(() => { poll(id) }, 1200)
            return
          }
          setBusy(false)
          if (next.status === 'done') {
            const res = await api('/xiyoungtools/batch-result?id=' + encodeURIComponent(id))
            if (alive.current && activeId.current === id) setPayload(res)
          } else {
            setError(next.error || '导入失败')
          }
        } catch (err) {
          if (!alive.current) return
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      useEffect(() => {
        alive.current = true
        ;(async () => {
          try {
            const res = await api('/xiyoungtools/batches')
            if (!alive.current) return
            const list = res.batches || []
            const latest = list.find((e) => e.status === 'running' || e.status === 'queued') || list[0]
            if (latest) {
              activeId.current = latest.id
              setJob(latest)
              if (latest.status === 'done') {
                const r2 = await api('/xiyoungtools/batch-result?id=' + encodeURIComponent(latest.id))
                if (alive.current) setPayload(r2)
              } else if (latest.status === 'running') {
                poll(latest.id)
              }
            }
          } catch {
            /* nothing yet */
          }
        })()
        return () => {
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const start = async () => {
        const text = String(dir || '').trim()
        if (!text) {
          setError('请填写文件夹路径')
          return
        }
        setError('')
        setImported(null)
        setBusy(true)
        setPayload(null)
        setJob(null)
        try {
          const res = await api('/xiyoungtools/batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: text, labelFrom: labelFrom })
          })
          activeId.current = res.batchId
          await poll(res.batchId)
        } catch (err) {
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      const importAll = async () => {
        if (!job) return
        try {
          const res = await api('/xiyoungtools/batch-import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: job.id })
          })
          setImported(res.added || 0)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      const byLabel = payload && payload.byLabel ? payload.byLabel : (job && job.byLabel ? job.byLabel : {})
      const keys = Object.keys(byLabel)

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
          h('div', {},
            h('h2', { style: S.h2 }, '评测语料装填'),
            h('p', { style: S.cardDesc },
              '一个文件夹 → 逐条韵律分析 → 按目录名或文件名推出标签 → 攒成对照表。'
              + '这个的用途是给「特征评测」准备语料（比如 CASIA 六个情绪各 200 条），不是攒训练样本。')
          ),
          h('span', { style: S.tag }, '本地')
        ),

        h('div', { style: S.row },
          h('input', {
            style: S.input,
            value: dir,
            placeholder: 'E:\\录音\\casia（子目录名 = 标签，如 angry\\ fear\\ happy\\）',
            onChange: (event) => { setDir(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter' && !busy) start() }
          }),
          h('button', {
            style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
            disabled: busy,
            onClick: start
          }, busy ? '分析中…' : '开始导入')
        ),

        h('div', { style: S.options },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            '标签来源',
            h('select', {
              style: S.select,
              value: labelFrom,
              onChange: (event) => { setLabelFrom(event.target.value) }
            },
              h('option', { value: 'auto' }, '自动（CSV > 目录 > 文件名）'),
              h('option', { value: 'directory' }, '子目录名'),
              h('option', { value: 'filename' }, '文件名前缀'),
              h('option', { value: 'csv' }, 'labels.csv')
            )
          ),
          h('span', { style: { color: C.faint } }, '子目录 / 前缀 / labels.csv')
        ),

        error ? h('div', { style: S.error }, error) : null,

        job ? h('div', { style: S.status },
          h('span', { style: Object.assign({}, S.dot, { background: statusColor(job.status) }) }),
          h('span', {}, (job.stage || job.status) + (job.total ? ' · ' + (job.analyzed || 0) + '/' + job.total : '')),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            h('span', { style: { color: C.faint, fontFamily: C.mono, fontSize: 10.5 } }, job.id)
          )
        ) : null,

        keys.length ? h('div', { style: { marginTop: 12 } },
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            keys.map((key) => h('span', {
              key,
              style: { fontSize: 11.5, color: C.muted, background: C.layer2, border: '1px solid ' + C.border, borderRadius: 999, padding: '3px 10px' }
            }, key + ' ' + byLabel[key]))
          ),
          payload && payload.records && payload.records.length ? h('div', { style: { marginTop: 10 } },
            h('div', { style: { fontSize: 11, color: C.faint, marginBottom: 4 } }, '逐条（' + payload.records.length + ' 条）'),
            h('div', { style: { maxHeight: 220, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
              payload.records.slice(0, 60).map((rec, i) => h('div', {
                key: i,
                style: Object.assign({}, S.historyRow, { cursor: 'default', fontSize: 11 })
              },
                h('span', { style: { color: C.accent, flex: '0 0 auto', fontWeight: 600 } }, rec.label),
                h('span', { style: { color: C.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, rec.file),
                h('span', { style: { fontFamily: C.mono, color: C.faint, flex: '0 0 auto' } },
                  (rec.summary.f0Median ? rec.summary.f0Median.toFixed(0) + 'Hz' : '—')
                  + ' 音域' + (rec.summary.semitoneRange || 0).toFixed(1)
                  + ' 微颤' + (rec.summary.jitterMedian || 0).toFixed(2))
              ))
            )
          ) : null,
          h('div', { style: Object.assign({}, S.actions, { marginTop: 12 }) },
            h('button', { style: S.secondary, onClick: importAll }, imported === null ? '写进标注池' : ('已写入 ' + imported + ' 条')),
            job ? h('a', {
              style: S.secondaryLink,
              href: '/xiyoungtools/batch-report?id=' + encodeURIComponent(job.id)
            }, '下载 batch.md') : null
          )
        ) : h('div', { style: { marginTop: 12, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
          '把录音按语气分到子目录里（催\、试探\、随口\），整个文件夹丢进来就行。'
        )
      )
    }


    function ClusterCard() {
      const [dir, setDir] = useState('')
      const [busy, setBusy] = useState(false)
      const [job, setJob] = useState(null)
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      const timer = useRef(null)
      const activeId = useRef(null)

      const poll = async (id) => {
        try {
          const next = await api('/xiyoungtools/cluster?id=' + encodeURIComponent(id))
          if (!alive.current || activeId.current !== id) return
          setJob(next)
          if (next.status === 'running' || next.status === 'queued') {
            setBusy(true)
            timer.current = setTimeout(() => { poll(id) }, 1200)
            return
          }
          setBusy(false)
          if (next.status === 'done') {
            const res = await api('/xiyoungtools/cluster-result?id=' + encodeURIComponent(id))
            if (alive.current && activeId.current === id) setData(res)
          } else {
            setError(next.error || '聚类失败')
          }
        } catch (err) {
          if (!alive.current) return
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      useEffect(() => {
        alive.current = true
        ;(async () => {
          try {
            const res = await api('/xiyoungtools/clusters')
            if (!alive.current) return
            const list = res.clusters || []
            const latest = list.find((e) => e.status === 'running' || e.status === 'queued') || list[0]
            if (latest) {
              activeId.current = latest.id
              setJob(latest)
              if (latest.status === 'done') {
                const r2 = await api('/xiyoungtools/cluster-result?id=' + encodeURIComponent(latest.id))
                if (alive.current) setData(r2)
              } else if (latest.status === 'running') {
                poll(latest.id)
              }
            }
          } catch {
            /* nothing yet */
          }
        })()
        return () => {
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const start = async () => {
        const text = String(dir || '').trim()
        if (!text) {
          setError('请填写文件夹路径')
          return
        }
        setError('')
        setBusy(true)
        setData(null)
        setJob(null)
        try {
          const res = await api('/xiyoungtools/cluster', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: text })
          })
          activeId.current = res.clusterId
          await poll(res.clusterId)
        } catch (err) {
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      const groups = data && data.groups ? data.groups : []

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
          h('div', {},
            h('h2', { style: S.h2 }, '说话人聚类'),
            h('p', { style: S.cardDesc }, '一批音频 → 算说话人嵌入 → 聚类，回答「这里面大致有几个人」')
          ),
          h('span', { style: S.tag }, '实验')
        ),

        h('div', { style: S.row },
          h('input', {
            style: S.input,
            value: dir,
            placeholder: 'E:\录音\一批（至少 2 条音频）',
            onChange: (event) => { setDir(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter' && !busy) start() }
          }),
          h('button', {
            style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
            disabled: busy,
            onClick: start
          }, busy ? '聚类中…' : '开始聚类')
        ),

        h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
          '这只是在说「哪几条像」，不是「这是谁」。声音相近的人会被并到一起。'
        ),

        error ? h('div', { style: S.error }, error) : null,

        job ? h('div', { style: S.status },
          h('span', { style: Object.assign({}, S.dot, { background: statusColor(job.status) }) }),
          h('span', {}, (job.stage || job.status) + (job.analyzed ? ' · ' + job.analyzed + ' 条' : '')
            + (job.clusterCount ? ' · ' + job.clusterCount + ' 组' : '')),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            h('span', { style: { color: C.faint, fontFamily: C.mono, fontSize: 10.5 } }, job.id)
          )
        ) : null,

        groups.length ? h('div', { style: { marginTop: 14 } },
          h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 8 } },
            groups.length + ' 组 · 共 ' + (data.analyzed || 0) + ' 条'),
          groups.map((g, i) => h('div', {
            key: i,
            style: { marginTop: 8, padding: '10px 12px', background: C.layer1, border: '1px solid ' + C.border, borderRadius: 9 }
          },
            h('div', { style: { fontSize: 12, color: C.accent, fontWeight: 600, marginBottom: 4 } },
              '组 ' + (i + 1) + '（' + g.size + ' 条' + (g.cohesion !== null ? '，相似度 ' + g.cohesion : '') + '）'),
            (g.files || []).map((f) => h('div', {
              key: f,
              style: { fontSize: 11.5, color: C.muted, fontFamily: C.mono, marginTop: 2 }
            }, f))
          ))
        ) : null
      )
    }
    // ---------------------------------------------------------------------
    // 统一分析入口
    //
    // 之前分两套：B 站链接走 video_summary（在"视频逐帧观看"tab），
    // 本地文件走 toolbox_analyze（在"分析"tab）。用户得记住哪个走哪。
    //
    // 现在一个输入框，按内容自动分流：
    //   BV 号 / bilibili.com / b23.tv  → video_summary（有下载和视频元信息）
    //   本地路径 / file://            → toolbox_analyze（本地文件，画面+声音一起）
    // ---------------------------------------------------------------------
    function AnalyzeCard({ health, onDone }) {
      const [source, setSource] = useState(() => readStorage(URL_KEY, ''))
      const [only, setOnly] = useState('both')
      const [busy, setBusy] = useState(false)
      const [job, setJob] = useState(null)
      const [result, setResult] = useState(null)
      const [history, setHistory] = useState([])
      const [error, setError] = useState('')
      const alive = useRef(true)
      const timer = useRef(null)
      const activeId = useRef(null)

      // 判断输入类型。既给用户看"会走哪条路"，也决定调哪个接口。
      const detectKind = (text) => {
        const t = String(text || '').trim()
        if (!t) return null
        if (/^BV[0-9A-Za-z]+$/.test(t)) return 'bili'
        if (/bilibili\.com|b23\.tv/i.test(t)) return 'bili'
        if (/^file:\/\//i.test(t)) return 'local'
        if (/^[a-zA-Z]:[\\/]/.test(t)) return 'local'
        if (t.startsWith('\\\\') || t.startsWith('/')) return 'local'
        if (/\.(mp4|mkv|mov|avi|flv|webm|ts|m4v|wmv|mp3|m4a|wav|flac|aac|ogg)$/i.test(t)) return 'local'
        return null
      }
      const kind = detectKind(source)

      const refreshHistory = async () => {
        try {
          const [a, b] = await Promise.all([
            api('/xiyoungtools/analyzes').catch(() => ({ analyzes: [] })),
            api('/xiyoungtools/jobs').catch(() => ({ jobs: [] }))
          ])
          const rows = []
          for (const x of (a.analyzes || [])) {
            rows.push({ kind: 'local', id: x.id, status: x.status, label: x.source, createdAt: x.createdAt })
          }
          for (const x of (b.jobs || [])) {
            rows.push({ kind: 'bili', id: x.id, status: x.status, label: x.url, createdAt: x.createdAt })
          }
          rows.sort((p, q) => (q.createdAt || 0) - (p.createdAt || 0))
          if (alive.current) setHistory(rows.slice(0, 8))
        } catch {
          /* 历史只是便利功能 */
        }
      }

      const poll = async (id, jobKind) => {
        try {
          const endpoint = jobKind === 'local' ? '/xiyoungtools/analyze?id=' : '/xiyoungtools/job?id='
          const next = await api(endpoint + encodeURIComponent(id))
          if (!alive.current || activeId.current !== id) return
          const j = next.job || next
          setJob(Object.assign({}, j, { __kind: jobKind }))
          if (j.status === 'running' || j.status === 'queued') {
            setBusy(true)
            timer.current = setTimeout(() => { poll(id, jobKind) }, 1500)
            return
          }
          setBusy(false)
          if (j.status === 'done') {
            const resEndpoint = jobKind === 'local' ? '/xiyoungtools/analyze-result?id=' : '/xiyoungtools/report?id='
            const res = await api(resEndpoint + encodeURIComponent(id))
            if (alive.current && activeId.current === id) setResult(Object.assign({ __kind: jobKind }, res))
          } else {
            setError(j.error || '分析失败')
          }
          refreshHistory()
        } catch (err) {
          if (!alive.current) return
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      useEffect(() => {
        alive.current = true
        refreshHistory()
        return () => {
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const start = async () => {
        const text = String(source || '').trim()
        if (!text) { setError('请填写 B 站链接、BV 号或本地文件路径'); return }
        const k = detectKind(text)
        if (!k) {
          setError('认不出这是链接还是文件路径。B 站填 BV 号或完整链接；本地填 D:\\video.mp4 这样的路径')
          return
        }
        writeStorage(URL_KEY, text)
        setError(''); setBusy(true); setResult(null); setJob(null)
        try {
          if (k === 'bili') {
            const res = await api('/xiyoungtools/video-watch', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                url: text,
                model: health && Array.isArray(health.models) && health.models.length ? health.models[0] : undefined,
                summary: true
              })
            })
            activeId.current = res.jobId
            await poll(res.jobId, 'bili')
          } else {
            const res = await api('/xiyoungtools/analyze', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ source: text, only })
            })
            activeId.current = res.analyzeId
            await poll(res.analyzeId, 'local')
          }
        } catch (err) {
          setBusy(false)
          setError(String(err && err.message ? err.message : err))
        }
      }

      const attach = async (id, k) => {
        activeId.current = id
        setBusy(true); setError(''); setResult(null)
        await poll(id, k)
      }

      const audio = result && result.__kind === 'local' ? result.audio : null
      const video = result && result.__kind === 'local' ? result.video : null
      const biliReport = result && result.__kind === 'bili' ? result : null

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
          h('div', {},
            h('h2', { style: S.h2 }, '分析'),
            h('p', { style: S.cardDesc }, 'B 站链接或本地文件，看画面也听声音')
          ),
          h('span', { style: S.tag }, kind === 'bili' ? 'B 站' : kind === 'local' ? '本地文件' : '待输入')
        ),

        h('div', { style: S.row },
          h('input', {
            style: S.input,
            value: source,
            placeholder: 'BV1xx… 或 https://bilibili.com/… 或 D:\\video.mp4',
            onChange: (event) => setSource(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && !busy) start() }
          }),
          h('button', {
            style: busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
            disabled: busy,
            onClick: start
          }, busy ? '分析中…' : '开始')
        ),

        source.trim() ? h('div', {
          style: { marginTop: 8, fontSize: 11.5, color: kind ? C.faint : C.warn, lineHeight: 1.6 }
        },
          kind === 'bili'
            ? '会下载视频并逐帧观看（不含声音分析）。'
            : kind === 'local'
              ? '会同时做画面和声音（本地文件不需要下载）。'
              : '认不出输入。B 站填 BV 号或完整链接；本地填完整路径。'
        ) : null,

        kind === 'local' ? h('div', { style: S.options },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            '做哪部分',
            h('select', {
              style: S.select,
              value: only,
              onChange: (event) => setOnly(event.target.value)
            },
              h('option', { value: 'both' }, '画面 + 声音'),
              h('option', { value: 'video' }, '只看画面'),
              h('option', { value: 'audio' }, '只听声音')
            )
          ),
          h('span', { style: { color: C.faint, fontSize: 11.5 } }, '声音快、画面慢，两路并行')
        ) : null,

        error ? h('div', { style: S.error }, error) : null,

        job ? h('div', { style: S.status },
          h('span', { style: Object.assign({}, S.dot, { background: statusColor(job.status) }) }),
          h('span', {}, job.stage || job.status || ''),
          h('div', { style: { marginLeft: 'auto', color: C.faint, fontFamily: C.mono, fontSize: 10.5 } }, job.id)
        ) : null,

        audio ? h('div', { style: { marginTop: 14 } },
          h('div', { style: { fontSize: 12, color: C.accent, fontWeight: 600, marginBottom: 6 } }, '声音'),
          audio.transcript
            ? h('div', { style: { fontSize: 12.5, color: C.text, lineHeight: 1.7, marginBottom: 6 } }, audio.transcript)
            : h('div', { style: { fontSize: 12, color: C.faint } },
                audio.transcriptStatus === 'no_model' ? '转写模型不可用'
                : audio.transcriptStatus === 'punct' ? '只识别到标点或语气词'
                : '没有识别到说话内容'),
          audio.contentClass && audio.contentClass.kind !== 'speech'
            ? h('div', { style: { fontSize: 11.5, color: C.warn, marginTop: 4 } }, '⚠ ' + audio.contentClass.note)
            : null,
          audio.changeSummary && audio.changeSummary.count > 0
            ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 6 } }, audio.changeSummary.note)
            : null
        ) : null,

        video && video.report ? h('div', { style: { marginTop: 14 } },
          h('div', { style: { fontSize: 12, color: C.accent, fontWeight: 600, marginBottom: 6 } }, '画面'),
          h('pre', { style: Object.assign({}, S.report, { maxHeight: 320 }) }, String(video.report).slice(0, 4000))
        ) : null,

        biliReport && biliReport.report ? h('div', { style: { marginTop: 14 } },
          h('div', { style: { fontSize: 12, color: C.accent, fontWeight: 600, marginBottom: 6 } },
            '画面 · ' + (biliReport.analyzed || 0) + '/' + (biliReport.total || 0) + ' 张'),
          biliReport.summary
            ? h('details', { style: { marginBottom: 8 } },
                h('summary', { style: { cursor: 'pointer', fontSize: 12, color: C.muted } }, '模型摘要'),
                h('pre', { style: Object.assign({}, S.report, { maxHeight: 200 }) }, biliReport.summary)
              )
            : null,
          h('pre', { style: Object.assign({}, S.report, { maxHeight: 360 }) }, String(biliReport.report).slice(0, 4000))
        ) : null,

        result && result.outDir ? h('div', {
          style: { marginTop: 10, fontSize: 11, color: C.faint, fontFamily: C.mono, wordBreak: 'break-all' }
        }, result.outDir) : null,

        history.length ? h('div', { style: { marginTop: 18, paddingTop: 14, borderTop: '1px solid ' + C.border } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '最近任务'),
            h('button', { style: S.secondarySmall, onClick: refreshHistory }, '刷新')
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
            history.map((entry) => h('button', {
              key: entry.kind + entry.id,
              style: Object.assign({}, S.historyRow, job && job.id === entry.id ? { borderColor: C.accent } : null),
              onClick: () => attach(entry.id, entry.kind),
              title: entry.label
            },
              h('span', { style: Object.assign({}, S.dot, { background: statusColor(entry.status) }) }),
              h('span', { style: { fontSize: 10, color: C.faint, flex: '0 0 auto' } }, entry.kind === 'bili' ? 'B站' : '本地'),
              h('span', { style: { fontFamily: C.mono, fontSize: 10.5, color: C.faint, flex: '0 0 auto' } }, String(entry.id).slice(0, 13)),
              h('span', { style: { fontSize: 11.5, color: C.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortUrl(entry.label)),
              h('span', { style: { fontSize: 11, color: C.faint, flex: '0 0 auto' } }, statusLabel(entry.status))
            ))
          )
        ) : null
      )
    }



    // ---------------------------------------------------------------------
    // 配置面板
    //
    // 设计原则：能用选的就不用输的。
    //   - 模型：从后端扫描出来的列表里选（带"是否支持视觉"标记）
    //   - 后端：下拉选 ollama / openai 兼容
    //   - 数值：范围合理的用滑块，离散的用下拉
    //   - 布尔：勾选框
    //   - 只有地址、路径这类才用输入框
    // ---------------------------------------------------------------------
    function ConfigCard({ health, onChanged }) {
      const [data, setData] = useState(null)
      const [models, setModels] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [showAdvanced, setShowAdvanced] = useState(false)
      const alive = useRef(true)

      const load = async () => {
        try {
          const res = await api('/xiyoungtools/config')
          if (alive.current) setData(res)
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err))
        }
      }

      const scanModels = async () => {
        setScanning(true)
        try {
          const res = await api('/xiyoungtools/models')
          if (alive.current) setModels(res)
        } catch (err) {
          if (alive.current) setModels({ ok: false, models: [], error: String(err && err.message ? err.message : err) })
        } finally {
          if (alive.current) setScanning(false)
        }
      }

      useEffect(() => {
        alive.current = true
        load().then(() => scanModels())
        return () => { alive.current = false }
      }, [])

      const save = async (patch, okNote) => {
        setBusy(true); setError(''); setNote('')
        try {
          const res = await api('/xiyoungtools/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch })
          })
          if (!alive.current) return
          setData(Object.assign({}, data, { config: res.config }))
          await load()
          // 换后端或地址后要重新扫
          const changedModel = Object.keys(patch).includes('model')
          if (changedModel) await scanModels()
          if (okNote) setNote(okNote)
          if (onChanged) onChanged()
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const applyPreset = async (key) => {
        setBusy(true); setError(''); setNote('')
        try {
          const res = await api('/xiyoungtools/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset: key })
          })
          if (!alive.current) return
          if (res.note) setNote(res.note)
          await load()
          if (onChanged) onChanged()
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const reset = async () => {
        setBusy(true); setError(''); setNote('')
        try {
          await api('/xiyoungtools/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true })
          })
          await load()
          await scanModels()
          if (onChanged) onChanged()
          setNote('已恢复默认')
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const cfg = data && data.config
      const m = cfg ? cfg.model : null
      const v = cfg ? cfg.video : null
      const a = cfg ? cfg.audio : null
      const ch = cfg ? cfg.changes : null
      const sp = cfg ? cfg.speaker : null
      const l = cfg ? cfg.limits : null
      const presets = (data && data.presets) || []
      const currentPreset = cfg && cfg.__meta ? cfg.__meta.preset : null

      // 常用行：标签 + 控件 + 提示
      const row = (label, control, hint) =>
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11.5, color: C.muted, width: 132, flex: '0 0 auto' } }, label),
          control,
          hint ? h('span', { style: { fontSize: 11, color: C.faint } }, hint) : null
        )

      const select = (value, options, onChange, width) =>
        h('select', {
          style: Object.assign({}, S.select, { width: width || 200 }),
          value: String(value),
          disabled: busy,
          onChange: (event) => onChange(event.target.value)
        }, options.map((o) => h('option', { key: String(o.value), value: String(o.value) }, o.label)))

      const slider = (value, min, max, step, onChange, unit) =>
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            type: 'range',
            min, max, step,
            value: value === undefined || value === null ? min : value,
            style: { width: 170 },
            disabled: busy,
            onChange: (event) => onChange(Number(event.target.value))
          }),
          h('span', { style: { fontSize: 12, color: C.text, width: 60, fontFamily: C.mono } },
            String(value) + (unit || ''))
        )

      const checkbox = (checked, onChange, label) =>
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 } },
          h('input', { type: 'checkbox', checked: Boolean(checked), disabled: busy, onChange: (e) => onChange(e.target.checked) }),
          label
        )

      // 模型下拉：优先用扫描结果；扫不到就退回手输
      const visionModels = models && models.ok
        ? (models.models || []).filter((x) => x.vision !== false)
        : []
      const modelOptions = visionModels.length
        ? visionModels.map((x) => ({
            value: x.name,
            label: x.name
              + (x.size ? ' · ' + (x.size / 1e9).toFixed(1) + 'GB' : '')
              + (x.vision === true ? ' · 视觉' : '')
          }))
        : []

      return h('section', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
          h('div', {},
            h('h2', { style: S.h2 }, '配置'),
            h('p', { style: S.cardDesc }, '按你的机器和模型服务调整')
          ),
          h('span', { style: S.tag }, data && data.configExists ? '已自定义' : '默认')
        ),

        error ? h('div', { style: S.error }, error) : null,
        note ? h('div', { style: { marginTop: 10, padding: '8px 10px', background: C.layer1, border: '1px solid ' + C.border, borderRadius: 8, fontSize: 11.5, color: C.warn, lineHeight: 1.6 } }, note) : null,

        // ===== 模型服务 =====
        cfg ? h('div', { style: { marginTop: 14 } },
          h('div', { style: { fontSize: 12.5, color: C.accent, fontWeight: 600 } }, '模型服务'),

          row('后端',
            select(m.provider, [
              { value: 'ollama', label: 'Ollama（本机或远程）' },
              { value: 'openai', label: 'OpenAI 兼容（LM Studio / vLLM / 云端）' }
            ], (val) => {
              // 切后端时给个合理默认地址
              const patch = { model: { provider: val } }
              if (val === 'ollama' && !m.host) patch.model.host = 'http://127.0.0.1:11434'
              save(patch, '后端已切换，正在重新扫描模型…')
            }),
            m.provider === 'openai' ? '需要填地址和 API Key' : null
          ),

          row('服务地址',
            h('input', {
              style: Object.assign({}, S.input, { width: 280, padding: '5px 9px', fontSize: 12 }),
              defaultValue: m.host,
              placeholder: m.provider === 'openai' ? 'https://api.example.com' : 'http://127.0.0.1:11434',
              disabled: busy,
              onBlur: (event) => {
                const val = String(event.target.value).trim()
                if (val !== m.host) save({ model: { host: val } }, '地址已更新，重新扫描中…')
              }
            })
          ),

          m.provider === 'openai' ? row('API Key',
            h('input', {
              type: 'password',
              style: Object.assign({}, S.input, { width: 280, padding: '5px 9px', fontSize: 12 }),
              defaultValue: m.apiKey || '',
              placeholder: 'sk-...',
              disabled: busy,
              onBlur: (event) => {
                const val = String(event.target.value).trim()
                if (val !== (m.apiKey || '')) save({ model: { apiKey: val } })
              }
            }),
            '只存本地配置文件'
          ) : null,

          row('模型',
            modelOptions.length
              ? select(m.name, modelOptions, (val) => save({ model: { name: val } }), 280)
              : h('input', {
                  style: Object.assign({}, S.input, { width: 280, padding: '5px 9px', fontSize: 12 }),
                  defaultValue: m.name,
                  disabled: busy,
                  onBlur: (event) => {
                    const val = String(event.target.value).trim()
                    if (val && val !== m.name) save({ model: { name: val } })
                  }
                }),
            h('button', {
              style: Object.assign({}, S.secondarySmall, scanning ? S.buttonDisabled : null),
              disabled: scanning,
              onClick: scanModels
            }, scanning ? '扫描中…' : '重新扫描')
          ),

          models ? h('div', {
            style: { fontSize: 11, marginTop: 4, marginLeft: 142, color: models.ok ? C.faint : C.warn, lineHeight: 1.6 }
          },
            models.ok
              ? ('扫描到 ' + (models.models || []).length + ' 个模型'
                 + ((models.models || []).filter((x) => x.vision === true).length
                    ? '，其中 ' + (models.models || []).filter((x) => x.vision === true).length + ' 个支持视觉'
                    : ''))
              : ('扫描失败：' + String(models.error || '')).slice(0, 160)
          ) : null
        ) : null,

        // ===== 机况预设 =====
        h('div', { style: { marginTop: 18 } },
          h('div', { style: { fontSize: 12.5, color: C.accent, fontWeight: 600 } }, '机况预设'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
            presets.map((p) => h('button', {
              key: p.key,
              style: Object.assign({},
                S.secondarySmall,
                currentPreset === p.key ? { borderColor: C.accent, color: C.accent } : null,
                busy ? S.buttonDisabled : null),
              disabled: busy,
              title: p.note || '',
              onClick: () => applyPreset(p.key)
            }, p.label))
          ),
          h('div', { style: { fontSize: 11, color: C.faint, marginTop: 6, lineHeight: 1.6 } },
            '选一个当起点，下面还能逐项改')
        ),

        // ===== 视频 =====
        cfg ? h('div', { style: { marginTop: 18 } },
          h('div', { style: { fontSize: 12.5, color: C.accent, fontWeight: 600 } }, '视频分析'),

          row('下载分辨率',
            select(v.height, [
              { value: 240, label: '240p · 最省' },
              { value: 360, label: '360p · 省' },
              { value: 480, label: '480p · 均衡（推荐）' },
              { value: 720, label: '720p · 清晰' },
              { value: 1080, label: '1080p · 最清晰' }
            ], (val) => save({ video: { height: Number(val) } })),
            '越低越快'
          ),

          row('拼图宽度',
            select(v.sheetWidth, [
              { value: 512, label: '512px · 小' },
              { value: 640, label: '640px' },
              { value: 800, label: '800px · 均衡' },
              { value: 1000, label: '1000px · 清晰（推荐）' },
              { value: 1280, label: '1280px · 大' },
              { value: 1600, label: '1600px · 很大' }
            ], (val) => save({ video: { sheetWidth: Number(val) } })),
            '单格实际像素 = 这个值 ÷ 每行格数'
          ),

          row('最多拼图张数',
            slider(v.maxSheets, 1, 200, 1, (val) => save({ video: { maxSheets: val } }), ' 张'),
            '越多覆盖越细（200 x 4 格 = 800 帧）'
          ),

          // ===== 抽帧密度（0.12.0 新增）=====
          row('抽帧策略',
            select(v.density || 'budget', [
              { value: 'budget', label: '按预算均匀铺满（默认，快）' },
              { value: 'max', label: '抽到最密（细，慢很多）' }
            ], (val) => save({ video: { density: val } })),
            'max 会一直抽到「最小间隔」为止，不看张数预算'
          ),

          row('最小间隔',
            select(v.minInterval != null ? v.minInterval : 1.0, [
              { value: 0.2, label: '0.2 秒 · 极密（5 帧/秒）' },
              { value: 0.5, label: '0.5 秒 · 很密' },
              { value: 1, label: '1 秒 · 默认' },
              { value: 2, label: '2 秒' },
              { value: 5, label: '5 秒 · 稀疏' }
            ], (val) => save({ video: { minInterval: Number(val) } })),
            '自动规划时不会比这个更密'
          ),

          row('每张拼图帧数',
            select(v.framesPerSheet || 4, [
              { value: 4, label: '4 格（2x2）· 默认' },
              { value: 6, label: '6 格（2x3）' },
              { value: 9, label: '9 格（3x3）· 一屏看更多' }
            ], (val) => save({ video: { framesPerSheet: Number(val) } })),
            '格数越多，每格越小'
          ),

          row('每行格数',
            select(v.perRow || 2, [
              { value: 2, label: '2 格/行 · 默认' },
              { value: 3, label: '3 格/行 · 适合宽画面' }
            ], (val) => save({ video: { perRow: Number(val) } })),
            '影响单格宽高比'
          ),

          row('单帧宽度',
            select(v.frameWidth || 1000, [
              { value: 640, label: '640px' },
              { value: 800, label: '800px' },
              { value: 1000, label: '1000px · 默认' },
              { value: 1280, label: '1280px' },
              { value: 1600, label: '1600px' }
            ], (val) => save({ video: { frameWidth: Number(val) } })),
            '抽帧时单帧缩放到的宽度'
          ),

          row('并发数',
            select(v.concurrency, [
              { value: 1, label: '1 · 串行（最稳）' },
              { value: 2, label: '2' },
              { value: 3, label: '3' },
              { value: 4, label: '4' }
            ], (val) => save({ video: { concurrency: Number(val) } })),
            health && health.gpuFit
              ? (health.gpuFit.vramRatio >= 90
                  ? '显存 ' + health.gpuFit.vramRatio + '%，可开'
                  : '显存仅 ' + health.gpuFit.vramRatio + '%，建议 1')
              : null
          )
        ) : null,

        // ===== 变化点检测（0.12.0 新增：以前这 6 项只有配置文件能改）=====
        ch ? h('div', { style: { marginTop: 18 } },
          h('div', { style: { fontSize: 12.5, color: C.accent, fontWeight: 600 } }, '变化点检测'),
          h('p', { style: { margin: '4px 0 0', fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
            '这组参数决定「哪里变了」有多敏感。调小更敏感但误报更多。'),

          row('音高突变阈值',
            slider(ch.pitchJumpSemitone, 2, 24, 1, (val) => save({ changes: { pitchJumpSemitone: val } }), ' 半音'),
            '默认 6，小于它的跳变不算'
          ),

          row('响度变化下限',
            slider(ch.loudnessFloorDb, 3, 40, 1, (val) => save({ changes: { loudnessFloorDb: val } }), ' dB'),
            '默认 12'
          ),

          row('响度变化上限',
            slider(ch.loudnessCeilDb, 5, 60, 1, (val) => save({ changes: { loudnessCeilDb: val } }), ' dB'),
            '默认 25'
          ),

          row('停顿判定',
            select(ch.minPauseSec, [
              { value: 0.2, label: '0.2 秒 · 敏感' },
              { value: 0.4, label: '0.4 秒 · 默认' },
              { value: 0.8, label: '0.8 秒' },
              { value: 1.5, label: '1.5 秒 · 只算明显停顿' }
            ], (val) => save({ changes: { minPauseSec: Number(val) } })),
            '多长的静音才算一次停顿'
          ),

          row('变化点合并间隔',
            select(ch.minGapSec != null ? ch.minGapSec : 0.35, [
              { value: 0.35, label: '0.35 秒 · 默认' },
              { value: 1, label: '1 秒' },
              { value: 3, label: '3 秒' },
              { value: 5, label: '5 秒 · 只留大的' }
            ], (val) => save({ changes: { minGapSec: Number(val) } })),
            '同类变化挨得比这更近就合成一条'
          ),

          row('换腔判定上限',
            slider(ch.registerMaxSemitone, 4, 30, 1, (val) => save({ changes: { registerMaxSemitone: val } }), ' 半音'),
            '默认 12'
          )
        ) : null,

        // ===== 说话人（0.12.0 新增）=====
        sp ? h('div', { style: { marginTop: 18 } },
          h('div', { style: { fontSize: 12.5, color: C.accent, fontWeight: 600 } }, '说话人'),
          h('p', { style: { margin: '4px 0 0', fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
            '聚类阈值越高分组越碎。手头样本少时可以调低一点。'),

          row('聚类种子阈值',
            slider(sp.clusterSeed, 0.5, 0.99, 0.01, (val) => save({ speaker: { clusterSeed: val } })),
            '默认 0.82'
          ),

          row('质心合并阈值',
            slider(sp.clusterMerge, 0.5, 0.99, 0.01, (val) => save({ speaker: { clusterMerge: val } })),
            '默认 0.75'
          ),

          row('分离窗口',
            select(sp.diarizeWindow, [
              { value: 1.0, label: '1.0 秒 · 细但抖' },
              { value: 1.5, label: '1.5 秒' },
              { value: 2.0, label: '2.0 秒 · 默认' },
              { value: 3.0, label: '3.0 秒 · 稳但粗' }
            ], (val) => save({ speaker: { diarizeWindow: Number(val) } })),
            '小于 1.5 秒嵌入会不稳'
          ),

          // 后端选择（0.20.0）。两个模型的 raw 坐标系完全不同，所以要把
          // 各自的「不同人通常多少」写出来，否则用户会拿旧阈值套新数字。
          row('嵌入模型',
            select(sp.backend, [
              { value: 'auto', label: '自动 · 有 CAM++ 就用' },
              { value: 'campplus', label: 'CAM++ · 更准，需模型' },
              { value: 'resemblyzer', label: 'Resemblyzer · 装了就能用' }
            ], (val) => save({ speaker: { backend: val } })),
            sp.backend === 'resemblyzer'
              ? '不同人通常 0.3~0.5，基准偏高'
              : '不同人通常 0.1~0.4，更分得开'
          ),

          row('CAM++ 模型路径',
            h('input', {
              type: 'text',
              value: sp.modelPath || '',
              placeholder: '留空自动查找 models/ 或 datasets/speaker-models/',
              style: Object.assign({}, S.input, { width: 220 }),
              onChange: (e) => save({ speaker: { modelPath: e.target.value } })
            }),
            '选 campplus 又找不到模型时会退回 resemblyzer'
          )
        ) : null,

        // ===== 音频 =====
        cfg ? h('div', { style: { marginTop: 18 } },
          h('div', { style: { fontSize: 12.5, color: C.accent, fontWeight: 600 } }, '音频与转写'),

          row('转写块长',
            select(a.chunkSec, [
              { value: 5, label: '5 秒 · 最细' },
              { value: 8, label: '8 秒 · 推荐' },
              { value: 10, label: '10 秒' },
              { value: 12, label: '12 秒 · 省' },
              { value: 20, label: '20 秒 · 最省' }
            ], (val) => save({ audio: { chunkSec: Number(val) } })),
            '8 秒实测最优'
          ),

          row('说话人基频范围',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              select(a.f0Min, [
                { value: 50, label: '50 Hz' },
                { value: 60, label: '60 Hz' },
                { value: 75, label: '75 Hz · 默认' },
                { value: 100, label: '100 Hz' }
              ], (val) => save({ audio: { f0Min: Number(val) } }), 110),
              h('span', { style: { fontSize: 11, color: C.faint } }, '到'),
              select(a.f0Max, [
                { value: 300, label: '300 Hz' },
                { value: 400, label: '400 Hz · 默认' },
                { value: 500, label: '500 Hz · 女声/童声' },
                { value: 800, label: '800 Hz' }
              ], (val) => save({ audio: { f0Max: Number(val) } }), 130)
            ),
            '男声可 60，女声可 500'
          ),

          row('转写语言',
            select(a.language, [
              { value: 'zh', label: '中文' },
              { value: 'en', label: '英文' },
              { value: 'ja', label: '日文' },
              { value: 'ko', label: '韩文' },
              { value: 'auto', label: '自动' }
            ], (val) => save({ audio: { language: val } }))
          )
        ) : null,

        // ===== 高级 =====
        cfg ? h('div', { style: { marginTop: 18 } },
          h('button', {
            style: Object.assign({}, S.secondarySmall, { marginBottom: 6 }),
            onClick: () => setShowAdvanced(!showAdvanced)
          }, showAdvanced ? '收起高级' : '展开高级'),

          showAdvanced ? h('div', {},
            row('上下文长度',
              select(m.numCtx, [
                { value: 2048, label: '2048' },
                { value: 4096, label: '4096 · 省显存' },
                { value: 8192, label: '8192 · 默认' },
                { value: 16384, label: '16384' }
              ], (val) => save({ model: { numCtx: Number(val) } }))
            ),
            row('单次输出上限',
              slider(m.numPredict, 200, 2000, 100, (val) => save({ model: { numPredict: val } }), ' token')
            ),
            row('请求超时',
              select(m.timeoutSec, [
                { value: 120, label: '2 分钟' },
                { value: 300, label: '5 分钟' },
                { value: 600, label: '10 分钟 · 默认' },
                { value: 1200, label: '20 分钟' },
                { value: 1800, label: '30 分钟' }
              ], (val) => save({ model: { timeoutSec: Number(val) } }))
            ),
            row('日志保留',
              slider(l.maxLogLines, 100, 2000, 100, (val) => save({ limits: { maxLogLines: val } }), ' 行')
            ),
            row('任务保留',
              slider(l.maxJobs, 10, 200, 10, (val) => save({ limits: { maxJobs: val } }), ' 个')
            )
          ) : null
        ) : null,

        // ===== 底部 =====
        h('div', { style: { marginTop: 20, paddingTop: 14, borderTop: '1px solid ' + C.border, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', {
            style: busy ? Object.assign({}, S.secondarySmall, S.buttonDisabled) : S.secondarySmall,
            disabled: busy,
            onClick: reset
          }, '恢复默认'),
          data && data.configPath
            ? h('span', { style: { fontSize: 10.5, color: C.faint, fontFamily: C.mono, wordBreak: 'break-all' } }, data.configPath)
            : null
        )
      )
    }

    function ToolboxPage(props) {
      const [tab, setTab] = useState('analyze')
      const [prosodyTarget, setProsodyTarget] = useState(null)
      // 音频页子标签：五个卡片一次挂会太长
      const [audioTab, setAudioTab] = useState('clip')
      // 批量页两种用途：装填评测语料 / 看有几个人
      const [batchMode, setBatchMode] = useState('import')
      // 缓存清理的反馈（这个页面唯一的错误/成功展示位）
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [cache, setCache] = useState(null)
      const [cleaning, setCleaning] = useState(false)
      const [health, setHealth] = useState(null)
      const [healthError, setHealthError] = useState('')

      const refreshCache = async () => {
        try {
          const res = await api('/xiyoungtools/cache')
          setCache(res.stats || null)
        } catch {
          /* cache info is optional */
        }
      }

      // 环境自检：之前这个页面从不请求 /health，导致 health 恒为 null，
      // 于是底部环境状态条、显存并发建议、模型下拉全都拿不到数据。
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        ;(async () => {
          try {
            const h = await api('/xiyoungtools/health')
            if (alive.current) setHealth(h)
          } catch (err) {
            if (alive.current) setHealthError(String(err && err.message ? err.message : err))
          }
        })()
        refreshCache()
        return () => { alive.current = false }
      }, [])

      const cleanCache = async (options) => {
        setCleaning(true)
        setError('')
        setNotice('')
        try {
          const res = await api('/xiyoungtools/cache-clean', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options || {})
          })
          await refreshCache()
          if (res && res.freedBytes !== undefined) {
            setNotice('已释放 ' + formatBytes(res.freedBytes)
              + (res.removedJobs ? '，删除 ' + res.removedJobs + ' 个任务目录' : ''))
          }
        } catch (err) {
          // 之前这个错误只进了 setError，而 ToolboxPage 从不渲染 error，
          // 于是点「清理」失败时界面完全没有反应。
          setError('清理失败：' + String(err && err.message ? err.message : err))
        } finally {
          setCleaning(false)
        }
      }

      return h('div', { style: S.page },
        h('div', { style: S.inner },
          h('header', { style: S.header },
            h('div', { style: S.brand }, h(ToolboxIcon, { size: 25 })),
            h('div', {},
              h('h1', { style: S.title }, 'Auris Oculi 感知工具箱'),
              h('p', { style: S.subtitle }, '本地小工具集合 · 全部在本机运行')
            ),
            props.onBack ? h('button', { style: S.back, onClick: props.onBack }, '返回对话') : null
          ),

          h('div', { style: S.tabs },
            [
              ['analyze', '分析'],
              ['audio', '截取与韵律'],
              ['config', '配置']
            ].map((pair) => h('button', {
              key: pair[0],
              style: Object.assign({}, S.tab, tab === pair[0] ? S.tabActive : null),
              onClick: () => { setTab(pair[0]) }
            }, pair[1]))
          ),

          tab === 'analyze' ? h(AnalyzeCard, { health: health }) : null,

          tab === 'config' ? h(ConfigCard, { health: health }) : null,
          tab === 'audio' ? h('div', {},
            // 音频页之前一次挂 5 个卡片，得一直往下滚。
            // 拆成子标签：一次只看一件事。
            h('div', { style: Object.assign({}, S.tabs, { marginBottom: 12 }) },
              [
                ['clip', '截取'],
                ['prosody', '韵律与转写'],
                ['voice', '声纹'],
                ['batch', '批量分析'],
                ['label', '笔记']
              ].map((pair) => h('button', {
                key: pair[0],
                style: Object.assign({}, S.tab, audioTab === pair[0] ? S.tabActive : null),
                onClick: () => { setAudioTab(pair[0]) }
              }, pair[1]))
            ),
            audioTab === 'clip' ? h(ClipCard, { onAnalyze: (id) => {
              setProsodyTarget(id)
              setAudioTab('prosody')
            } }) : null,
            audioTab === 'prosody' ? h(ProsodyCard, { initialId: prosodyTarget }) : null,
            audioTab === 'voice' ? h(SpeakerCompareCard, null) : null,
            audioTab === 'batch' ? h('div', {},
              // 批量导入和说话人聚类都是"给文件夹跑一批"，合成一页用下拉切
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
                h('span', { style: { fontSize: 12, color: C.muted } }, '用途'),
                h('select', {
                  style: S.select,
                  value: batchMode,
                  onChange: (event) => { setBatchMode(event.target.value) }
                },
                  h('option', { value: 'import' }, '评测语料装填（给特征评测备料）'),
                  h('option', { value: 'cluster' }, '说话人聚类（看有几个人）')
                )
              ),
              batchMode === 'import' ? h(BatchCard, null) : h(ClusterCard, null)
            ) : null,
            audioTab === 'label' ? h(LabelCard, null) : null
          ) : null,

          // 缓存并在配置页底部：它只有清理功能，不值得单独一个 tab
          tab === 'config' ? h('div', { style: { marginTop: 14 } },
            h(CacheCard, { stats: cache, onRefresh: refreshCache, onClean: cleanCache, cleaning: cleaning, error: error, notice: notice })
          ) : null,
          h('section', { style: S.more },
            h('div', { style: { fontWeight: 600, color: C.muted, marginBottom: 4 } }, '会话工具（11 个）'),
            h('div', { style: { fontFamily: C.mono, fontSize: 11, lineHeight: 1.9, color: C.faint } },
              'toolbox_analyze   一站式：视频+音频',
              h('br'),
              'video_summary     B 站逐帧观看',
              h('br'),
              'media_clip        片段截取',
              h('br'),
              'prosody_analyze   韵律+转写',
              h('br'),
              'prosody_label     声音笔记',
              h('br'),
              'prosody_batch     批量导入',
              h('br'),
              'speaker_cluster / speaker_diarize   说话人',
              h('br'),
              'toolbox_benchmark 特征评测',
              h('br'),
              'toolbox_job       统一查任务',
              h('br'),
              'toolbox_cache_clean  清理缓存'
            )
          ),

          // 环境状态：哪一项缺失比"全部正常"更值得看
          health ? h('div', {
            style: { marginTop: 10, fontSize: 10.5, color: C.faint, fontFamily: C.mono, lineHeight: 1.8 }
          },
            'ffmpeg: ' + (health.ffmpegExists ? 'OK' : '缺失')
            + ' · yt-dlp: ' + (health.ytdlpExists ? 'OK' : '缺失')
            + ' · 会话工具可用'
          ) : (healthError ? h('div', { style: S.error }, healthError) : null)
        )
      )
    }

    return {
      name: PANEL_ID,
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({
              onBack: () => {
                try {
                  ctx.layout.selectPanel(null)
                } catch {
                  /* a host without a conversation panel simply stays here */
                }
              }
            })
          }, ToolboxPage)
          const stopIcon = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            label: () => 'Auris Oculi 感知工具箱'
          }, ToolboxIcon)
          return () => {
            if (typeof stopIcon === 'function') stopIcon()
            if (typeof stopMain === 'function') stopMain()
          }
        }))
      }
    }
  }
})
