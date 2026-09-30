// Terminal panel: multiple interactive PTY terminals (xterm.js <-> node-pty over
// WebSocket) with a tab list, like VS Code's integrated terminal.
import { api, bus } from './api.js'
import { h, icon, toast } from './util.js'

let xtermLoaded
function loadXterm() {
  if (xtermLoaded) return xtermLoaded
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/xterm/xterm/css/xterm.css'; document.head.append(css)
  const js = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s) })
  // xterm UMD bundles would clash with Monaco's AMD loader: hide `define` while loading
  xtermLoaded = (async () => {
    const d = window.define; window.define = undefined
    try {
      await js('/vendor/xterm/xterm/lib/xterm.js')
      await js('/vendor/xterm/addon-fit/lib/addon-fit.js')
      await js('/vendor/xterm/addon-web-links/lib/addon-web-links.js')
    } finally { window.define = d }
  })()
  return xtermLoaded
}

function cssVar(n, f) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f }

class TermView {
  constructor(info, panel) {
    this.id = info.id
    this.title = info.title
    this.panel = panel
    this.el = h('div', { class: 'xterm-host' })
    this.term = new window.Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace", fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: cssVar('--vscode-terminal-background', '') || cssVar('--vscode-panel-background', '#191a1b'),
        foreground: cssVar('--vscode-terminal-foreground', '#cccccc'),
        cursor: cssVar('--vscode-terminalCursor-foreground', '#e6e6e6'),
        selectionBackground: '#3994bc55',
        black: '#000000', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
      },
    })
    this.fit = new window.FitAddon.FitAddon()
    this.term.loadAddon(this.fit)
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => this.panel.onLink?.(uri)))
    this.opened = false
    this.connect()
    this.term.onData((d) => this.send({ t: 'i', d }))
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }))
    this.ro = new ResizeObserver(() => this.doFit())
    this.ro.observe(this.el)
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/api/terminals/${this.id}/ws`)
    this.ws.onopen = () => { this.doFit(); const d = this.fit.proposeDimensions?.(); if (d) this.send({ t: 'r', cols: d.cols, rows: d.rows }) }
    let first = true
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.t === 'o') { if (first) { this.term.reset(); first = false } this.term.write(msg.d) }
      else if (msg.t === 'x') { this.exited = true; this.term.write('\r\n\x1b[90m[process exited — press any key to close]\x1b[0m'); this.term.onKey(() => this.panel.kill(this.id)) }
    }
    this.ws.onclose = () => { if (!this.exited && !this.disposed) setTimeout(() => this.connect(), 1500) }
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)) }
  mount(host) {
    host.replaceChildren(this.el)
    if (!this.opened) { this.term.open(this.el); this.opened = true }
    requestAnimationFrame(() => { this.doFit(); this.term.focus() })
  }
  doFit() { if (this.el.offsetParent && this.el.clientWidth > 20 && this.el.clientHeight > 10) try { this.fit.fit() } catch { /* not visible */ } }
  dispose() { this.disposed = true; this.ro.disconnect(); this.ws?.close(); this.term.dispose() }
}

export class TerminalPanel {
  constructor({ onLink } = {}) {
    this.onLink = onLink
    this.views = new Map()
    this.active = null
    this.host = h('div', { class: 'term-stage' })
    this.list = h('div', { class: 'term-list' })
    this.el = h('div', { class: 'terminal-panel' }, this.host, this.list)
    bus.on('terminals', () => this.sync())
  }
  ensure() {
    if (!this._ensuring) this._ensuring = (async () => {
      await loadXterm()
      await this.sync()
      if (!this.views.size) await this.create()
      else if (!this.active) this.select([...this.views.keys()][0])
    })().finally(() => { this._ensuring = null })
    return this._ensuring
  }
  async sync() {
    if (!window.Terminal) return
    // serialize syncs: the 'terminals' event can race with create()
    this._sync = (this._sync || Promise.resolve()).then(() => this._doSync()).catch(() => {})
    return this._sync
  }
  async _doSync() {
    const infos = await api.get('/api/terminals')
    for (const i of infos) if (!this.views.has(i.id)) this.views.set(i.id, new TermView(i, this))
    for (const id of [...this.views.keys()]) if (!infos.find((i) => i.id === id)) { this.views.get(id).dispose(); this.views.delete(id); if (this.active === id) this.active = null }
    if (!this.active && this.views.size) this.select([...this.views.keys()].pop())
    if (!this.views.size) this.host.replaceChildren(h('div', { class: 'empty-note' }, 'No terminals. Click + to create one.'))
    this.renderList()
  }
  async create() {
    await loadXterm()
    const i = await api.post('/api/terminals', {})
    await this.sync()
    if (!this.views.has(i.id)) this.views.set(i.id, new TermView(i, this))
    this.select(i.id)
    return this.views.get(i.id)
  }
  select(id) {
    this.active = id
    this.views.get(id)?.mount(this.host)
    this.renderList()
  }
  async kill(id = this.active) {
    if (!id) return
    await api.del('/api/terminals/' + id).catch((e) => toast(e.message, 'error'))
    await this.sync()
  }
  /** Run a command in the active terminal (creates one if needed). */
  async run(cmd) {
    await this.ensure()
    const v = this.views.get(this.active)
    v?.send({ t: 'i', d: cmd + '\r' })
  }
  renderList() {
    const items = [...this.views.values()]
    this.list.classList.toggle('hidden', items.length < 2)
    this.list.replaceChildren(...items.map((v) => h('div', { class: 'term-item' + (v.id === this.active ? ' active' : ''), onclick: () => this.select(v.id) },
      icon('terminal'), h('span', { class: 'flex1' }, v.title),
      h('button', { class: 'icon-btn', title: 'Kill Terminal', onclick: (e) => { e.stopPropagation(); this.kill(v.id) } }, icon('trash')))))
  }
  focus() { this.views.get(this.active)?.term.focus() }
  fitAll() { for (const v of this.views.values()) v.doFit() }
  clear() { this.views.get(this.active)?.term.clear() }
}
