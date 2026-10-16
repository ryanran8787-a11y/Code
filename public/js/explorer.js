// Explorer view (file tree) and Search view for the Editor Window side bar.
import { files } from './files.js'
import { api } from './api.js'
import { h, icon, fileIcon, basename, dirname, debounce, toast, escapeHtml } from './util.js'
import { inputBox } from './palette.js'

export class ExplorerView {
  constructor({ openFile, workspaceName, onRename }) {
    this.openFile = openFile
    this.onRename = onRename
    this.expanded = new Set(JSON.parse(localStorage.getItem('explorer.expanded') || '["src"]'))
    this.selected = null
    this.recent = new Map() // path -> 'agent' highlight
    this.treeEl = h('div', { class: 'tree', tabindex: '0' })
    this.el = h('div', { class: 'pane explorer' },
      h('div', { class: 'pane-title' }, h('span', {}, 'Explorer'), h('div', { class: 'flex1' }),
        h('button', { class: 'icon-btn', title: 'New File…', onclick: () => this.newFile() }, icon('new-file')),
        h('button', { class: 'icon-btn', title: 'New Folder…', onclick: () => this.newFolder() }, icon('new-folder')),
        h('button', { class: 'icon-btn', title: 'Refresh Explorer', onclick: () => files.refreshTree() }, icon('refresh')),
        h('button', { class: 'icon-btn', title: 'Collapse Folders', onclick: () => { this.expanded.clear(); this.persist(); this.render() } }, icon('collapse-all'))),
      h('div', { class: 'section-head' }, icon('chevron-down'), h('span', {}, (workspaceName || 'workspace').toUpperCase())),
      this.treeEl)
    files.on('tree', () => this.render())
    files.on('dirty', () => this.render())
    files.on('fs', (e) => {
      if (e.source?.startsWith('agent:') && e.path) {
        this.recent.set(e.path, Date.now())
        // auto-expand parents of agent-touched files
        let d = dirname(e.path); while (d) { this.expanded.add(d); d = dirname(d) }
        setTimeout(() => { this.recent.delete(e.path); this.render() }, 4000)
      }
    })
    this.treeEl.addEventListener('keydown', (e) => this.onKey(e))
    this.render()
    this.treeEl.addEventListener('contextmenu', (e) => { if (e.target === this.treeEl) { e.preventDefault(); this.menu(e, null) } })
  }

  persist() { localStorage.setItem('explorer.expanded', JSON.stringify([...this.expanded])) }

  render() {
    const rows = []
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const isDir = n.type === 'dir'
        const open = isDir && this.expanded.has(n.path)
        const dirty = !isDir && files.isDirty(n.path)
        const row = h('div', {
          class: `tree-row${this.selected === n.path ? ' selected' : ''}${this.recent.has(n.path) ? ' agent-touched' : ''}`,
          style: { paddingLeft: 8 + depth * 12 + 'px' }, title: n.path, dataset: { path: n.path },
          onclick: (e) => {
            this.selected = n.path
            if (isDir) { open ? this.expanded.delete(n.path) : this.expanded.add(n.path); this.persist(); this.render() }
            else { this.render(); this.openFile(n.path, { preview: true }) }
          },
          ondblclick: () => { if (!isDir) this.openFile(n.path, { preview: false }) },
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.selected = n.path; this.render(); this.menu(e, n) },
        },
        h('span', { class: 'indent-guides' }, ...Array.from({ length: depth }, (_, i) => h('span', { class: 'guide', style: { left: 14 + i * 12 + 'px' } }))),
        isDir ? icon(open ? 'chevron-down' : 'chevron-right', 'twisty') : h('span', { class: 'twisty-space' }),
        isDir ? null : fileIcon(n.path),
        h('span', { class: 'tree-label' + (isDir ? ' dir' : '') }, n.name),
        dirty ? h('span', { class: 'dirty-dot' }) : null,
        this.recent.has(n.path) ? h('span', { class: 'agent-badge', title: 'Modified by an agent' }, 'A') : null,
        )
        rows.push(row)
        if (open) walk(n.children || [], depth + 1)
      }
    }
    walk(files.tree, 0)
    this.treeEl.replaceChildren(...rows)
    if (!rows.length) this.treeEl.append(h('div', { class: 'empty-note' }, 'The workspace is empty.'))
  }

  reveal(path) {
    let d = dirname(path); while (d) { this.expanded.add(d); d = dirname(d) }
    this.selected = path
    this.render()
    this.treeEl.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  onKey(e) {
    const rows = [...this.treeEl.querySelectorAll('.tree-row')]
    const i = rows.findIndex((r) => r.dataset.path === this.selected)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (n) { this.selected = n.dataset.path; this.render() ; this.treeEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }) }
    } else if (e.key === 'Enter' && this.selected) rows[i]?.click()
    else if (e.key === 'Delete' && this.selected) this.remove(this.selected)
    else if (e.key === 'F2' && this.selected) this.rename(this.selected)
  }

  baseDir() {
    if (!this.selected) return ''
    const isDir = this.treeEl.querySelector(`[data-path="${CSS.escape(this.selected)}"] .tree-label.dir`)
    return isDir ? this.selected : dirname(this.selected)
  }

  async newFile(dir = this.baseDir()) {
    const name = await inputBox({ placeholder: 'File name', prompt: `New file in ${dir || '/'}` })
    if (!name) return
    const p = (dir ? dir + '/' : '') + name
    try { await api.put('/api/file', { path: p, content: '' }); if (dir) this.expanded.add(dir); await files.refreshTree(); this.openFile(p, { preview: false }) } catch (e) { toast(e.message, 'error') }
  }
  async newFolder(dir = this.baseDir()) {
    const name = await inputBox({ placeholder: 'Folder name', prompt: `New folder in ${dir || '/'}` })
    if (!name) return
    const p = (dir ? dir + '/' : '') + name
    try { await api.post('/api/fs/mkdir', { path: p }); this.expanded.add(p); await files.refreshTree() } catch (e) { toast(e.message, 'error') }
  }
  async rename(p) {
    const name = await inputBox({ value: basename(p), prompt: 'Rename' })
    if (!name || name === basename(p)) return
    const to = (dirname(p) ? dirname(p) + '/' : '') + name
    try { await api.post('/api/fs/rename', { from: p, to }); this.onRename?.(p, to); await files.refreshTree() } catch (e) { toast(e.message, 'error') }
  }
  async remove(p) {
    if (!confirm(`Delete '${p}'?`)) return
    try { await api.post('/api/fs/delete', { path: p }); await files.refreshTree() } catch (e) { toast(e.message, 'error') }
  }

  menu(e, n) {
    const items = []
    if (!n || n.type === 'dir') items.push(['New File…', () => this.newFile(n?.path || '')], ['New Folder…', () => this.newFolder(n?.path || '')])
    if (n) {
      if (n.type === 'file') items.push(['Open to the Side', () => this.openFile(n.path, { preview: false })])
      items.push(['Copy Path', () => navigator.clipboard?.writeText(n.path)], ['Rename…', () => this.rename(n.path)], ['Delete', () => this.remove(n.path)])
    }
    contextMenu(e.clientX, e.clientY, items)
  }
}

export function contextMenu(x, y, items) {
  document.querySelector('.context-menu')?.remove()
  const m = h('div', { class: 'context-menu', style: { left: x + 'px', top: y + 'px' } },
    ...items.map(([label, fn]) => label === '-' ? h('div', { class: 'cm-sep' }) : h('div', { class: 'cm-item', onclick: () => { m.remove(); fn() } }, label)))
  document.body.append(m)
  const r = m.getBoundingClientRect()
  if (r.right > innerWidth) m.style.left = innerWidth - r.width - 4 + 'px'
  if (r.bottom > innerHeight) m.style.top = innerHeight - r.height - 4 + 'px'
  setTimeout(() => window.addEventListener('mousedown', function off(ev) { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', off) } }), 0)
}

export class SearchView {
  constructor({ openFile }) {
    this.openFile = openFile
    this.input = h('input', { class: 'search-input', placeholder: 'Search', spellcheck: 'false' })
    this.include = h('input', { class: 'search-input small', placeholder: 'files to include (e.g. *.js)', spellcheck: 'false' })
    this.caseBtn = h('button', { class: 'toggle-btn', title: 'Match Case', onclick: () => { this.caseBtn.classList.toggle('on'); this.run() } }, icon('case-sensitive'))
    this.regexBtn = h('button', { class: 'toggle-btn', title: 'Use Regular Expression', onclick: () => { this.regexBtn.classList.toggle('on'); this.run() } }, icon('regex'))
    this.results = h('div', { class: 'search-results' })
    this.summary = h('div', { class: 'search-summary' })
    this.el = h('div', { class: 'pane search' },
      h('div', { class: 'pane-title' }, h('span', {}, 'Search')),
      h('div', { class: 'search-box' }, h('div', { class: 'search-row' }, this.input, this.caseBtn, this.regexBtn), this.include),
      this.summary, this.results)
    const run = debounce(() => this.run(), 250)
    this.input.addEventListener('input', run)
    this.include.addEventListener('input', run)
  }
  focus() { this.input.focus(); this.input.select() }
  async run() {
    const q = this.input.value
    if (!q) { this.results.replaceChildren(); this.summary.textContent = ''; return }
    const params = new URLSearchParams({ q, case: this.caseBtn.classList.contains('on') ? '1' : '0', regex: this.regexBtn.classList.contains('on') ? '1' : '0', include: this.include.value })
    let hits = []
    try { hits = await api.get('/api/search?' + params) } catch (e) { this.summary.textContent = e.message; return }
    const by = new Map()
    for (const hit of hits) { if (!by.has(hit.path)) by.set(hit.path, []); by.get(hit.path).push(hit) }
    this.summary.textContent = hits.length ? `${hits.length} results in ${by.size} files` : 'No results found.'
    this.maybeRgHint()
    const re = this.regexBtn.classList.contains('on') ? safeRe(q, this.caseBtn.classList.contains('on')) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), this.caseBtn.classList.contains('on') ? 'g' : 'gi')
    this.results.replaceChildren(...[...by].map(([p, hs]) => {
      const group = h('div', { class: 'sr-group' },
        h('div', { class: 'sr-file', onclick: () => group.classList.toggle('collapsed') }, icon('chevron-down', 'twisty'), fileIcon(p), h('span', {}, basename(p)), h('span', { class: 'muted' }, dirname(p)), h('span', { class: 'sr-count' }, hs.length)),
        ...hs.map((x) => h('div', { class: 'sr-line', onclick: () => this.openFile(p, { line: x.line, preview: true }), html: highlight(x.text.trim(), re) })))
      return group
    }))
  }
  async maybeRgHint() {
    if (this._rgHint === undefined) {
      this._rgHint = ''
      try {
        const r = await api.get('/api/search-backend')
        if (r.backend !== 'rg') this._rgHint = ' — ripgrep not found, search is slow (Windows: winget install BurntSushi.ripgrep.MSVC)'
      } catch { /* ignore */ }
    }
    this.summary.textContent += this._rgHint
  }
}
function safeRe(q, cs) { try { return new RegExp(q, cs ? 'g' : 'gi') } catch { return /$^/ } }
function highlight(text, re) {
  let out = '', last = 0
  if (re) text.replace(re, (m, ...a) => { const i = a[a.length - 2]; out += escapeHtml(text.slice(last, i)) + '<mark>' + escapeHtml(m) + '</mark>'; last = i + m.length; return m })
  return out + escapeHtml(text.slice(last))
}
