// Integrated browser: previews local dev servers through the /preview/<port>/ proxy.
// Design Mode lets you click elements on the page; the picked element (selector,
// text, computed styles) + your comment are sent to an agent as a structured target.
import { api, bus } from './api.js'
import { h, icon, toast } from './util.js'

export class BrowserView {
  /** @param {{ onDesignPrompt?: (text:string)=>void }} o */
  constructor(o = {}) {
    this.onDesignPrompt = o.onDesignPrompt
    this.url = localStorage.getItem('browser.url') || ''
    this.frame = h('iframe', { class: 'browser-frame', sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals' })
    this.addr = h('input', { class: 'browser-addr', spellcheck: 'false', placeholder: 'localhost:5173 — a local port or path', value: this.url })
    this.addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.navigate(this.addr.value) })
    this.designBtn = h('button', { class: 'icon-btn', title: 'Design Mode: pick an element and ask an agent to change it', onclick: () => this.toggleDesign() }, icon('inspect'))
    this.console = h('div', { class: 'browser-console hidden' })
    this.picked = h('div', { class: 'design-card hidden' })
    this.empty = h('div', { class: 'browser-empty' })
    this.el = h('div', { class: 'browser' },
      h('div', { class: 'browser-bar' },
        h('button', { class: 'icon-btn', title: 'Back', onclick: () => { try { this.frame.contentWindow.history.back() } catch { /* cross-origin */ } } }, icon('arrow-left')),
        h('button', { class: 'icon-btn', title: 'Forward', onclick: () => { try { this.frame.contentWindow.history.forward() } catch { /* */ } } }, icon('arrow-right')),
        h('button', { class: 'icon-btn', title: 'Reload', onclick: () => this.reload() }, icon('refresh')),
        this.addr,
        this.designBtn,
        h('button', { class: 'icon-btn', title: 'Toggle console errors', onclick: () => this.console.classList.toggle('hidden') }, icon('debug-console')),
        h('button', { class: 'icon-btn', title: 'Open in new tab', onclick: () => this.src && window.open(this.src, '_blank') }, icon('link-external'))),
      h('div', { class: 'browser-body' }, this.frame, this.empty, this.picked),
      this.console)
    this.design = false
    window.addEventListener('message', (e) => {
      if (e.source !== this.frame.contentWindow || !e.data?.cursorweb) return
      const d = e.data
      if (d.cursorweb === 'pick') this.showPick(d)
      else if (d.cursorweb === 'nav') {
        const m = /\/preview\/(\d+)(\/.*)?$/.exec(new URL(d.href).pathname + new URL(d.href).search)
        if (m) { this.url = `localhost:${m[1]}${m[2] && m[2] !== '/' ? m[2] : ''}`; this.addr.value = this.url; localStorage.setItem('browser.url', this.url) }
        if (this.design) this.sendInspect(true)
      } else if (d.cursorweb === 'console') this.log(d.text)
    })
    bus.on('proc', () => this.renderEmpty())
    this.renderEmpty()
    if (this.url) this.navigate(this.url)
  }

  toSrc(input) {
    let s = String(input || '').trim()
    if (!s) return ''
    s = s.replace(/^https?:\/\//, '')
    const m = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:?(\d{2,5})(\/.*)?$/.exec(s)
    if (m) return `/preview/${m[1]}${m[2] || '/'}`
    return ''
  }

  navigate(input) {
    const src = this.toSrc(input)
    if (!src) { toast('Enter a local port such as localhost:5173 (only local dev servers can be previewed).', 'warn'); return }
    this.url = String(input).replace(/^https?:\/\//, '')
    localStorage.setItem('browser.url', this.url)
    this.addr.value = this.url
    this.src = src
    this.frame.src = src
    this.empty.classList.add('hidden')
    this.console.replaceChildren()
  }

  reload() { if (this.src) this.frame.src = this.frame.src }

  async renderEmpty() {
    if (this.src) return
    let ps = []
    try { ps = (await api.get('/api/processes')).filter((p) => p.status === 'running' && p.ports.length) } catch { /* ignore */ }
    this.empty.replaceChildren(icon('globe', 'big'), h('div', {}, 'Preview a local dev server'),
      h('div', { class: 'muted small' }, 'Start one in the terminal or ask an agent, then open its port.'),
      ...ps.flatMap((p) => p.ports.map((port) => h('button', { class: 'btn-ghost', onclick: () => this.navigate(`localhost:${port}`) }, icon('radio-tower'), `localhost:${port}`, h('span', { class: 'muted small' }, p.command.slice(0, 40))))))
  }

  toggleDesign() {
    this.design = !this.design
    this.designBtn.classList.toggle('on', this.design)
    this.sendInspect(this.design)
    if (!this.design) this.picked.classList.add('hidden')
    else toast('Design Mode: click an element on the page to annotate it.')
  }
  sendInspect(on) { try { this.frame.contentWindow?.postMessage({ cursorweb: 'inspect', on }, '*') } catch { /* */ } }

  showPick(d) {
    const note = h('textarea', { class: 'design-note', rows: 2, placeholder: 'Describe the change, e.g. "make this button larger and blue"' })
    const send = () => {
      const text = note.value.trim()
      if (!text) { note.focus(); return }
      const prompt = `Design Mode request for the page at http://${this.url}\n\nTarget element: \`${d.selector}\` (<${d.tag}>, ${d.rect.w}×${d.rect.h}px at ${d.rect.x},${d.rect.y})\nText: ${JSON.stringify(d.text.slice(0, 120))}\nComputed styles: color ${d.styles.color}; background ${d.styles.background}; font ${d.styles.font}; margin ${d.styles.margin}; padding ${d.styles.padding}; display ${d.styles.display}\nHTML: \`${d.html.slice(0, 300).replace(/`/g, "'")}\`\n\nRequested change: ${text}\n\nFind the source file that renders this element, make the change, then verify with fetch_url.`
      this.onDesignPrompt?.(prompt)
      this.picked.classList.add('hidden')
    }
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
    this.picked.classList.remove('hidden')
    this.picked.replaceChildren(
      h('div', { class: 'design-head' }, icon('inspect'), h('code', {}, d.selector), h('div', { class: 'flex1' }), h('button', { class: 'icon-btn', onclick: () => this.picked.classList.add('hidden') }, icon('close'))),
      h('div', { class: 'design-meta muted small' }, `<${d.tag}> ${d.rect.w}×${d.rect.h} · ${d.styles.font} · ${d.styles.color}`),
      d.text ? h('div', { class: 'design-text' }, d.text.slice(0, 120)) : null,
      note,
      h('div', { class: 'design-actions' }, h('button', { class: 'btn-primary small', onclick: send }, icon('sparkle'), 'Send to Agent')))
    setTimeout(() => note.focus(), 20)
  }

  log(text) {
    this.console.append(h('div', { class: 'console-line' }, icon('error'), text))
    this.console.classList.remove('hidden')
  }
}

/** Ports / background processes list. */
export class PortsView {
  constructor({ openPort }) {
    this.openPort = openPort
    this.el = h('div', { class: 'ports' })
    bus.on('proc', () => this.render())
    bus.on('proc.removed', () => this.render())
    this.render()
  }
  async render() {
    let ps = []
    try { ps = await api.get('/api/processes') } catch { return }
    this.el.replaceChildren(
      h('div', { class: 'ports-head' }, h('span', { class: 'muted small' }, 'Background processes started by you or agents'), h('div', { class: 'flex1' }),
        h('button', { class: 'btn-ghost', onclick: async () => { const { inputBox } = await import('./palette.js'); const c = await inputBox({ placeholder: 'npm run dev', prompt: 'Start a background process in the workspace' }); if (c) await api.post('/api/processes', { command: c }) } }, icon('add'), 'Start…')),
      ps.length ? null : h('div', { class: 'empty-note' }, 'No background processes.'),
      ...ps.map((p) => [h('div', { class: 'port-row ' + p.status },
        h('span', { class: 'status-dot ' + (p.status === 'running' ? 'st-done' : 'st-stopped') }, icon(p.status === 'running' ? 'circle-filled' : 'circle-outline')),
        h('code', { class: 'port-cmd', title: p.command }, p.command),
        h('span', { class: 'muted small' }, p.owner === 'user' ? 'you' : 'agent'),
        ...p.ports.map((port) => h('button', { class: 'port-chip', title: 'Open in browser', onclick: () => this.openPort(port) }, icon('globe'), port)),
        h('div', { class: 'flex1' }),
        h('button', { class: 'icon-btn', title: 'Show output', onclick: () => { const pre = this.el.querySelector(`[data-out="${p.id}"]`); if (pre) pre.classList.toggle('hidden') } }, icon('output')),
        p.status === 'running' ? h('button', { class: 'icon-btn', title: 'Stop', onclick: () => api.post(`/api/processes/${p.id}/stop`) }, icon('debug-stop')) : h('button', { class: 'icon-btn', title: 'Remove', onclick: () => api.del(`/api/processes/${p.id}`) }, icon('trash'))),
      h('pre', { class: 'port-out hidden', dataset: { out: p.id } }, p.tail || '(no output)')]),
    )
  }
}
