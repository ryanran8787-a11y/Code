// EditorGroup: tab strip + a single Monaco code editor (models swapped per tab,
// view state preserved) + Monaco diff editor for agent change review.
import { files } from './files.js'
import { agentStore } from './agent-store.js'
import { h, icon, basename, dirname, fileIcon, languageOf, toast } from './util.js'
import { Emitter, api, bus } from './api.js'

export class EditorGroup extends Emitter {
  constructor({ id = 'main', showBreadcrumbs = true } = {}) {
    super()
    this.showBreadcrumbs = showBreadcrumbs
    this.id = id
    this.tabs = [] // {key, kind:'file'|'diff', path, agentId?, preview}
    this.active = null
    this.viewStates = new Map()
    this.tabStrip = h('div', { class: 'tabs', role: 'tablist' })
    this.tabStrip.addEventListener('wheel', (e) => { if (e.deltaY) { this.tabStrip.scrollLeft += e.deltaY; e.preventDefault() } }, { passive: false })
    this.tabActions = h('div', { class: 'tab-actions' })
    this.breadcrumbs = h('div', { class: 'breadcrumbs' + (showBreadcrumbs ? '' : ' hidden') })
    this.editorHost = h('div', { class: 'editor-host' })
    this.diffHost = h('div', { class: 'editor-host hidden' })
    this.browserHost = h('div', { class: 'editor-host hidden' })
    this.diffBar = h('div', { class: 'diff-bar hidden' })
    this.welcome = h('div', { class: 'editor-welcome' },
      h('div', { class: 'welcome-logo' }),
      h('div', { class: 'welcome-rows' },
        ...[['Show All Commands', 'Ctrl+Shift+P'], ['Go to File', 'Ctrl+P'], ['Open Agents Window', 'Ctrl+Shift+A'], ['Toggle Agent Panel', 'Ctrl+L'], ['Toggle Terminal', 'Ctrl+`']].map(([l, k]) =>
          h('div', { class: 'welcome-row' }, h('span', {}, l), h('span', { class: 'qi-kb' }, ...k.split('+').map((x) => h('kbd', {}, x)))))))
    this.el = h('div', { class: 'editor-group' },
      h('div', { class: 'tabs-container' }, this.tabStrip, this.tabActions),
      this.breadcrumbs, this.diffBar,
      h('div', { class: 'editor-body' }, this.editorHost, this.diffHost, this.browserHost, this.welcome))
    this.editor = monaco.editor.create(this.editorHost, {
      automaticLayout: true, theme: 'cursor-dark', fontSize: 13, lineHeight: 20,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'Courier New', monospace",
      minimap: { enabled: true, renderCharacters: false, scale: 1 }, scrollBeyondLastLine: false,
      renderLineHighlight: 'all', smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true }, guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true }, padding: { top: 4 }, model: null, tabSize: 2,
    })
    this.diffEditor = null
    this.editor.onDidChangeCursorPosition((e) => this.emit('cursor', e.position))
    this.editor.onDidFocusEditorText(() => this.emit('focus'))
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveActive())
    this.editor.addAction({
      id: 'cursor.addToChat', label: 'Add Selection to Agent Chat', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      run: (ed) => {
        const sel = ed.getSelection(); const m = ed.getModel()
        const tab = this.activeTab()
        if (!m || !tab) return
        const text = sel && !sel.isEmpty() ? m.getValueInRange(sel) : ''
        this.emit('addToChat', { path: tab.path, text, range: sel })
      },
    })
    files.on('dirty', (p) => this.renderTabs())
    files.on('deleted', (p) => { const t = this.tabs.find((t) => t.kind === 'file' && t.path === p); if (t) { t.deleted = true; this.renderTabs() } })
    files.on('conflict', (p) => toast(`${basename(p)} changed on disk but has unsaved edits. Save to overwrite, or revert.`, 'warn', 6000))
    agentStore.on('changes', (agentId) => this.refreshDiffs(agentId))
    this.render()
  }

  key(kind, path, agentId) { return kind === 'diff' ? `diff:${agentId}:${path}` : kind === 'gitdiff' ? `gitdiff:${path}` : kind === 'browser' ? 'browser' : `file:${path}` }

  /** Working-tree changes vs HEAD (Source Control). */
  async openGitDiff(path) {
    const key = this.key('gitdiff', path)
    if (!this.tabs.find((x) => x.key === key)) {
      const ai = this.tabs.findIndex((x) => x.key === this.active)
      this.tabs.splice(ai + 1, 0, { key, kind: 'gitdiff', path })
    }
    await this.activate(key)
  }

  async openBrowser() {
    if (!this.tabs.find((x) => x.key === 'browser')) this.tabs.push({ key: 'browser', kind: 'browser', path: 'Browser' })
    await this.activate('browser')
  }
  activeTab() { return this.tabs.find((t) => t.key === this.active) }

  async openFile(path, { preview = true, line, focus = true } = {}) {
    const key = this.key('file', path)
    let t = this.tabs.find((x) => x.key === key)
    if (!t) {
      // replace an existing preview tab (VS Code "preview editor" behavior)
      const pi = this.tabs.findIndex((x) => x.preview && x.kind === 'file' && !files.isDirty(x.path))
      t = { key, kind: 'file', path, preview }
      if (pi >= 0 && preview) this.tabs.splice(pi, 1, t)
      else {
        const ai = this.tabs.findIndex((x) => x.key === this.active)
        this.tabs.splice(ai + 1, 0, t)
      }
    } else if (!preview) t.preview = false
    try { await files.open(path) } catch (e) { toast(`Cannot open ${path}: ${e.message}`, 'error'); this.tabs = this.tabs.filter((x) => x !== t); this.render(); return }
    await this.activate(key)
    if (line) { this.editor.revealLineInCenter(line); this.editor.setPosition({ lineNumber: line, column: 1 }) }
    if (focus) this.editor.focus()
  }

  async openDiff(agentId, path) {
    const key = this.key('diff', path, agentId)
    if (!this.tabs.find((x) => x.key === key)) {
      const ai = this.tabs.findIndex((x) => x.key === this.active)
      this.tabs.splice(ai + 1, 0, { key, kind: 'diff', path, agentId })
    }
    await this.activate(key)
  }

  async activate(key) {
    const prev = this.activeTab()
    if (prev?.kind === 'file' && this.editor.getModel()) this.viewStates.set(prev.key, this.editor.saveViewState())
    this.active = key
    const t = this.activeTab()
    if (t?.kind === 'file') {
      const d = await files.open(t.path)
      this.editor.setModel(d.model)
      const vs = this.viewStates.get(key)
      if (vs) this.editor.restoreViewState(vs)
    } else if (t?.kind === 'diff' || t?.kind === 'gitdiff') {
      await this.showDiff(t)
    } else if (t?.kind === 'browser' && this.browser) {
      if (this.browser.el.parentElement !== this.browserHost) this.browserHost.replaceChildren(this.browser.el)
    }
    this.render()
    this.emit('active', t)
  }

  ensureDiffEditor() {
    if (this.diffEditor) return this.diffEditor
    this.diffEditor = monaco.editor.createDiffEditor(this.diffHost, {
      automaticLayout: true, theme: 'cursor-dark', fontSize: 13, lineHeight: 20, renderSideBySide: true, readOnly: false, originalEditable: false,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: true }, renderIndicators: true, useInlineViewWhenSpaceIsLimited: true,
    })
    return this.diffEditor
  }

  async showDiff(t) {
    const de = this.ensureDiffEditor()
    if (t.kind === 'gitdiff') return this.showGitDiff(t, de)
    let list = []
    try { list = await agentStore.changes(t.agentId) } catch { /* agent removed */ }
    const c = list.find((x) => x.path === t.path)
    const orig = c?.original ?? ''
    const cur = c?.current ?? ''
    const lang = languageOf(t.path)
    const old = de.getModel()
    de.setModel({ original: monaco.editor.createModel(orig, lang), modified: monaco.editor.createModel(cur, lang) })
    if (old) { old.original.dispose(); old.modified.dispose() }
    t.change = c
    const a = agentStore.get(t.agentId)
    const pending = c?.status === 'pending'
    this.diffBar.replaceChildren(
      icon('diff'), h('span', { class: 'diff-title' }, `${basename(t.path)}`),
      h('span', { class: 'muted' }, ` — changes by ${a ? a.title : 'agent'}`),
      c ? h('span', { class: 'diff-status ' + c.status }, c.status) : h('span', { class: 'muted' }, ' (no changes recorded)'),
      h('div', { class: 'flex1' }),
      h('button', { class: 'btn-ghost', onclick: () => this.openFile(t.path, { preview: false }) }, icon('go-to-file'), 'Open File'),
      pending ? h('button', { class: 'btn-ghost', onclick: () => agentStore.resolve(t.agentId, t.path, false) }, icon('discard'), 'Undo') : null,
      pending ? h('button', { class: 'btn-primary small', onclick: () => agentStore.resolve(t.agentId, t.path, true) }, icon('check'), 'Keep') : null,
    )
  }

  async showGitDiff(t, de) {
    const [{ content: head }, cur] = await Promise.all([
      api.get('/api/git/show?path=' + encodeURIComponent(t.path)),
      api.get('/api/file?path=' + encodeURIComponent(t.path)).then((r) => r.content).catch(() => ''),
    ])
    const lang = languageOf(t.path)
    const old = de.getModel()
    // modified side edits the live document when the file is open, so edits in the diff are real edits
    const doc = await files.open(t.path).catch(() => null)
    de.setModel({ original: monaco.editor.createModel(head ?? '', lang), modified: doc ? doc.model : monaco.editor.createModel(cur, lang) })
    if (old) { old.original.dispose(); if (![...files.docs.values()].some((d) => d.model === old.modified)) old.modified.dispose() }
    this.diffBar.replaceChildren(
      icon('source-control'), h('span', { class: 'diff-title' }, basename(t.path)),
      h('span', { class: 'muted' }, head === null ? ' — new file (untracked)' : ' — HEAD ↔ Working Tree'),
      h('div', { class: 'flex1' }),
      h('button', { class: 'btn-ghost', onclick: () => this.openFile(t.path, { preview: false }) }, icon('go-to-file'), 'Open File'),
      h('button', { class: 'btn-ghost', onclick: async () => { await api.post('/api/git/stage', { paths: [t.path] }); bus.emit('git') } }, icon('add'), 'Stage'),
    )
  }

  refreshDiffs(agentId) {
    const t = this.activeTab()
    if (t?.kind === 'diff' && t.agentId === agentId) this.showDiff(t)
  }

  closeTab(key, force = false) {
    const i = this.tabs.findIndex((t) => t.key === key)
    if (i < 0) return
    const t = this.tabs[i]
    if (t.kind === 'file' && files.isDirty(t.path) && !force) {
      if (!confirm(`Do you want to discard your unsaved changes to ${basename(t.path)}?`)) return
      files.docs.get(t.path)?.model.setValue(files.docs.get(t.path).saved)
    }
    this.tabs.splice(i, 1)
    this.viewStates.delete(key)
    if (this.active === key) {
      const n = this.tabs[i] || this.tabs[i - 1]
      this.active = null
      if (n) this.activate(n.key)
      else { this.editor.setModel(null); this.render(); this.emit('active', null) }
    } else this.render()
  }

  closeAll() { for (const t of [...this.tabs]) this.closeTab(t.key) }

  async saveActive() {
    const t = this.activeTab()
    if (t?.kind !== 'file') return
    try { await files.save(t.path); t.preview = false; this.renderTabs() } catch (e) { toast('Save failed: ' + e.message, 'error') }
  }

  renameTabsForPath(from, to) {
    for (const t of this.tabs) if (t.path === from || t.path.startsWith(from + '/')) { t.path = to + t.path.slice(from.length); t.key = this.key(t.kind, t.path, t.agentId) }
    this.render()
  }

  render() {
    const t = this.activeTab()
    this.renderTabs()
    const isDiff = t?.kind === 'diff' || t?.kind === 'gitdiff'
    const isBrowser = t?.kind === 'browser'
    this.editorHost.classList.toggle('hidden', !t || isDiff || isBrowser)
    this.diffHost.classList.toggle('hidden', !isDiff)
    this.browserHost.classList.toggle('hidden', !isBrowser)
    this.breadcrumbs.classList.toggle('hidden', isBrowser || !this.showBreadcrumbs)
    this.diffBar.classList.toggle('hidden', !isDiff)
    this.welcome.classList.toggle('hidden', !!t)
    this.breadcrumbs.replaceChildren()
    if (t && !isBrowser) {
      const parts = t.path.split('/')
      parts.forEach((p, i) => {
        if (i) this.breadcrumbs.append(icon('chevron-right', 'bc-sep'))
        this.breadcrumbs.append(h('span', { class: 'bc-item' }, i === parts.length - 1 ? fileIcon(p) : null, p))
      })
    }
    this.tabActions.replaceChildren(
      t?.kind === 'file' ? h('button', { class: 'icon-btn', title: 'Split / Open in Agent Chat (Ctrl+L)', onclick: () => this.emit('addToChat', { path: t.path, text: '' }) }, icon('comment-discussion')) : null,
      this.tabs.length ? h('button', { class: 'icon-btn', title: 'Close All', onclick: () => this.closeAll() }, icon('close-all')) : null,
    )
  }

  renderTabs() {
    this.tabStrip.replaceChildren(...this.tabs.map((t) => {
      const dirty = t.kind === 'file' && files.isDirty(t.path)
      const el = h('div', {
        class: `tab${t.key === this.active ? ' active' : ''}${t.preview ? ' preview' : ''}${dirty ? ' dirty' : ''}${t.deleted ? ' deleted' : ''}`,
        role: 'tab', title: t.path, draggable: 'true',
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(t.key) } },
        onclick: () => this.activate(t.key),
        ondblclick: () => { t.preview = false; this.renderTabs() },
      },
      t.kind === 'diff' ? icon('diff', 'file-icon diff-icon') : t.kind === 'gitdiff' ? icon('source-control', 'file-icon diff-icon') : t.kind === 'browser' ? icon('globe', 'file-icon') : fileIcon(t.path),
      h('span', { class: 'tab-label' }, basename(t.path)),
      t.kind === 'diff' ? h('span', { class: 'tab-desc' }, 'Agent Diff') : t.kind === 'gitdiff' ? h('span', { class: 'tab-desc' }, 'Working Tree') : this.needsDir(t) ? h('span', { class: 'tab-desc' }, dirname(t.path)) : null,
      h('button', { class: 'tab-close', title: 'Close (Ctrl+W)', onclick: (e) => { e.stopPropagation(); this.closeTab(t.key) } }, icon(dirty ? 'circle-filled' : 'close')),
      )
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/tab', t.key) })
      el.addEventListener('dragover', (e) => e.preventDefault())
      el.addEventListener('drop', (e) => {
        const k = e.dataTransfer.getData('text/tab'); if (!k || k === t.key) return
        const from = this.tabs.findIndex((x) => x.key === k); const moved = this.tabs.splice(from, 1)[0]
        this.tabs.splice(this.tabs.indexOf(t), 0, moved); this.renderTabs()
      })
      return el
    }))
    this.tabStrip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  needsDir(t) { return this.tabs.some((x) => x !== t && basename(x.path) === basename(t.path)) }
  layout() { this.editor.layout(); this.diffEditor?.layout() }
}
