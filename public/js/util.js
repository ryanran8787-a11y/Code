// DOM convenience: make append/replaceChildren ignore null/false and flatten arrays
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ['append', 'replaceChildren', 'prepend']) {
    const orig = proto[name]
    proto[name] = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false)) }
  }
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'html') el.innerHTML = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export const icon = (name, cls = '') => h('i', { class: `codicon codicon-${name} ${cls}` })

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function basename(p) { return (p || '').split('/').pop() }
export function dirname(p) { const i = (p || '').lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
  md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', py: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml',
  sql: 'sql', toml: 'ini', ini: 'ini', vue: 'html', svg: 'xml', kt: 'kotlin', swift: 'swift', dockerfile: 'dockerfile',
}
export function languageOf(path) {
  const b = basename(path).toLowerCase()
  if (b === 'dockerfile') return 'dockerfile'
  return EXT_LANG[b.split('.').pop()] || 'plaintext'
}

// file icon: codicon + color by extension (lightweight stand-in for Seti icons)
const ICONS = {
  js: ['symbol-method', '#e8d44d'], mjs: ['symbol-method', '#e8d44d'], jsx: ['symbol-method', '#61dafb'], ts: ['symbol-method', '#3178c6'], tsx: ['symbol-method', '#3178c6'],
  json: ['json', '#cbcb41'], md: ['markdown', '#519aba'], css: ['symbol-color', '#56b6c2'], html: ['code', '#e37933'], py: ['symbol-namespace', '#3572A5'],
  png: ['file-media', '#a074c4'], jpg: ['file-media', '#a074c4'], svg: ['file-media', '#ffb13b'], sh: ['terminal', '#89e051'], yml: ['settings', '#cb171e'], yaml: ['settings', '#cb171e'],
  lock: ['lock', '#888'], txt: ['file', '#aaa'], go: ['symbol-namespace', '#00ADD8'], rs: ['symbol-namespace', '#dea584'],
}
export function fileIcon(path) {
  const ext = basename(path).toLowerCase().split('.').pop()
  const [n, color] = ICONS[ext] || ['file', 'var(--vscode-icon-foreground)']
  const i = icon(n, 'file-icon')
  i.style.color = color
  return i
}

export function debounce(fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

/** Make an element resizable by dragging a sash. */
export function sash(el, { dir = 'x', target, min = 120, max = 900, invert = false, onResize, storageKey }) {
  if (storageKey) { const v = +localStorage.getItem(storageKey); if (v) target.style[dir === 'x' ? 'width' : 'height'] = v + 'px' }
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const start = dir === 'x' ? e.clientX : e.clientY
    const startSize = dir === 'x' ? target.offsetWidth : target.offsetHeight
    el.classList.add('active')
    document.body.classList.add(dir === 'x' ? 'resizing-x' : 'resizing-y')
    const move = (ev) => {
      const d = (dir === 'x' ? ev.clientX : ev.clientY) - start
      const size = Math.max(min, Math.min(max, startSize + (invert ? -d : d)))
      target.style[dir === 'x' ? 'width' : 'height'] = size + 'px'
      onResize?.(size)
    }
    const up = () => {
      el.classList.remove('active')
      document.body.classList.remove('resizing-x', 'resizing-y')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (storageKey) localStorage.setItem(storageKey, String(dir === 'x' ? target.offsetWidth : target.offsetHeight))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}

let toastBox
export function toast(msg, kind = 'info', ms = 3500) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox) }
  const t = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info'), h('span', {}, msg))
  toastBox.append(t)
  setTimeout(() => t.remove(), ms)
}

export function renderMarkdown(md) {
  const html = window.marked ? window.marked.parse(md || '', { gfm: true, breaks: false }) : escapeHtml(md)
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : html
}

export function lineDiffStats(a, b) {
  if (!window.Diff) return { added: 0, removed: 0 }
  let added = 0, removed = 0
  for (const part of window.Diff.diffLines(a ?? '', b ?? '')) {
    if (part.added) added += part.count
    else if (part.removed) removed += part.count
  }
  return { added, removed }
}
