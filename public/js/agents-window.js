// Agents Window: agent-first workbench modelled after Cursor 3.
// ┌ sidebar ─────┬ agent tabs  [single|split|grid] ─────────┬ review ─────────┐
// │ + New Agent  │ ┌ agent A chat ─┐ ┌ agent B chat ─┐        │ Changes | Files │
// │ search       │ │ timeline      │ │ timeline      │        │ diff / file     │
// │ Running  ●   │ │ composer      │ │ composer      │        │ viewer          │
// │ Recent   ✓   │ └───────────────┘ └───────────────┘        │                 │
// └──────────────┴──────────────────────────────────────────────┴─────────────────┘
import { agentStore, STATUS } from './agent-store.js'
import { files } from './files.js'
import { AgentChatView } from './chat.js'
import { EditorGroup } from './editor-group.js'
import { h, icon, sash, timeAgo, basename, fileIcon, lineDiffStats, toast } from './util.js'
import { Emitter } from './api.js'
import { contextMenu } from './explorer.js'
import { inputBox } from './palette.js'

export class AgentsWindow extends Emitter {
  constructor({ workspace }) {
    super()
    this.workspace = workspace
    const saved = JSON.parse(localStorage.getItem('agents.tabs') || '[]')
    this.tabs = saved.filter((id) => id === null || agentStore.get(id)) // null = "new agent" tab
    if (!this.tabs.length) this.tabs = [null]
    this.focused = Math.min(+localStorage.getItem('agents.focused') || 0, this.tabs.length - 1)
    this.layoutMode = localStorage.getItem('agents.layout') || 'single' // single | split | grid
    this.filter = ''
    this.panes = [] // AgentChatView instances currently mounted

    this.sidebar = h('div', { class: 'aw-sidebar' })
    this.sideSash = h('div', { class: 'sash sash-v' })
    this.tabStrip = h('div', { class: 'aw-tabs' })
    this.stage = h('div', { class: 'aw-stage' })
    this.review = new EditorGroup({ id: 'review', showBreadcrumbs: false })
    this.reviewList = h('div', { class: 'aw-review-list' })
    this.reviewTabs = h('div', { class: 'aw-review-head' })
    this.reviewPanel = h('div', { class: 'aw-review' }, this.reviewTabs, this.reviewList, this.review.el)
    this.reviewSash = h('div', { class: 'sash sash-v' })
    this.reviewMode = 'changes'
    this.center = h('div', { class: 'aw-center' }, h('div', { class: 'aw-topbar' }, this.tabStrip, h('div', { class: 'aw-layout-btns' })), this.stage)
    this.el = h('div', { class: 'window agents-window' }, this.sidebar, this.sideSash, this.center, this.reviewSash, this.reviewPanel)

    sash(this.sideSash, { target: this.sidebar, min: 200, max: 480, storageKey: 'agents.sideW' })
    sash(this.reviewSash, { target: this.reviewPanel, min: 320, max: 1100, invert: true, storageKey: 'agents.reviewW' })
    this.toggleReview(localStorage.getItem('agents.review') === '1')

    agentStore.on('list', () => { this.renderSidebar(); this.renderTabs() })
    agentStore.on('changes', (id) => { if (id === this.focusedAgent()) this.renderReviewList() })
    agentStore.on('summary', (s, prev) => {
      if (s.id === this.focusedAgent() && prev && prev.pendingChanges !== s.pendingChanges) this.renderReviewList()
      if (prev && prev.status !== s.status && (s.status === 'done' || s.status === 'error' || s.status === 'awaiting_approval') && !this.isVisible(s.id)) {
        toast(`${s.title}: ${STATUS[s.status].label}`, s.status === 'error' ? 'error' : s.status === 'awaiting_approval' ? 'warn' : 'info')
      }
    })
    files.on('tree', () => { if (this.reviewMode === 'files') this.renderReviewList() })
    this.renderSidebar()
    this.renderLayout()
  }

  // ---------- state helpers ----------
  focusedAgent() { return this.tabs[this.focused] ?? null }
  isVisible(id) { return document.body.dataset.window === 'agents' && this.visibleTabs().includes(id) }
  persist() {
    localStorage.setItem('agents.tabs', JSON.stringify(this.tabs))
    localStorage.setItem('agents.focused', String(this.focused))
    localStorage.setItem('agents.layout', this.layoutMode)
  }
  visibleTabs() {
    const n = this.layoutMode === 'single' ? 1 : this.layoutMode === 'split' ? 2 : 4
    if (n === 1) return [this.tabs[this.focused]]
    // show a window of n tabs containing the focused one
    const start = Math.max(0, Math.min(this.focused - (n - 1), this.tabs.length - n))
    return this.tabs.slice(Math.max(0, start), Math.max(0, start) + n)
  }

  // ---------- actions ----------
  newAgent() {
    const empty = this.tabs.indexOf(null)
    if (empty >= 0) this.focused = empty
    else { this.tabs.push(null); this.focused = this.tabs.length - 1 }
    this.persist(); this.renderLayout()
    setTimeout(() => this.panes.find((p) => p.agentId === null)?.focus(), 20)
  }

  openAgent(id, { newTab = false } = {}) {
    let i = this.tabs.indexOf(id)
    if (i < 0) {
      if (!newTab && this.tabs[this.focused] === null && this.layoutMode === 'single') { this.tabs[this.focused] = id; i = this.focused }
      else if (!newTab && this.layoutMode === 'single') { this.tabs[this.focused] = id; i = this.focused }
      else { this.tabs.push(id); i = this.tabs.length - 1 }
    }
    this.focused = i
    this.persist(); this.renderLayout()
  }

  closeTab(i) {
    this.tabs.splice(i, 1)
    if (!this.tabs.length) this.tabs = [null]
    this.focused = Math.min(this.focused, this.tabs.length - 1)
    this.persist(); this.renderLayout()
  }

  setLayout(m) { this.layoutMode = m; this.persist(); this.renderLayout() }

  toggleReview(show = this.reviewPanel.classList.contains('hidden')) {
    this.reviewPanel.classList.toggle('hidden', !show)
    this.reviewSash.classList.toggle('hidden', !show)
    localStorage.setItem('agents.review', show ? '1' : '0')
    this.renderTopButtons?.()
    if (show) this.renderReviewList()
  }

  async openDiff(agentId, path) {
    this.toggleReview(true)
    this.reviewMode = 'changes'
    this.renderReviewList()
    await this.review.openDiff(agentId, path)
  }
  async openFile(path, o = {}) {
    this.toggleReview(true)
    this.reviewMode = 'files'
    this.renderReviewList()
    await this.review.openFile(path, { preview: true, ...o })
  }

  // ---------- rendering ----------
  renderSidebar() {
    const q = this.filter.toLowerCase()
    const list = agentStore.list.filter((a) => !q || a.title.toLowerCase().includes(q))
    const active = list.filter((a) => a.status === 'running' || a.status === 'awaiting_approval')
    const review = list.filter((a) => !active.includes(a) && a.pendingChanges > 0)
    const rest = list.filter((a) => !active.includes(a) && !review.includes(a))
    const search = h('input', { class: 'aw-search', placeholder: 'Search agents…', value: this.filter, spellcheck: 'false' })
    search.addEventListener('input', () => { this.filter = search.value; const pos = search.selectionStart; this.renderSidebar(); const s = this.sidebar.querySelector('.aw-search'); s.focus(); s.setSelectionRange(pos, pos) })
    const section = (title, items, ic) => items.length ? [h('div', { class: 'aw-section' }, icon(ic), h('span', {}, title), h('span', { class: 'aw-count' }, items.length)), ...items.map((a) => this.agentItem(a))] : []
    this.sidebar.replaceChildren(
      h('div', { class: 'aw-brand' }, h('div', { class: 'brand-logo' }), h('span', { class: 'brand-name' }, 'CursorWeb'), h('div', { class: 'flex1' }),
        h('button', { class: 'icon-btn', title: 'Settings', onclick: () => this.emit('settings') }, icon('settings-gear'))),
      h('button', { class: 'aw-new', onclick: () => this.newAgent(), title: 'New Agent (Ctrl+N)' }, icon('add'), h('span', {}, 'New Agent'), h('span', { class: 'flex1' }), h('kbd', {}, 'Ctrl'), h('kbd', {}, 'N')),
      h('div', { class: 'aw-search-wrap' }, icon('search'), search),
      h('div', { class: 'aw-workspace', title: this.workspace.root }, icon('folder'), h('span', {}, this.workspace.name), h('div', { class: 'flex1' }),
        h('button', { class: 'icon-btn', title: 'Browse files (Ctrl+P)', onclick: () => this.emit('quickOpen') }, icon('go-to-file'))),
      h('div', { class: 'aw-list' },
        ...section('In Progress', active, 'sync'),
        ...section('Ready for Review', review, 'git-pull-request'),
        ...section('Recent', rest, 'history'),
        list.length ? null : h('div', { class: 'empty-note' }, q ? 'No matching agents.' : 'No agents yet.\nStart one with New Agent, and run several in parallel.'),
      ),
      h('div', { class: 'aw-foot' },
        h('button', { class: 'aw-foot-btn', title: 'Open Editor Window (Ctrl+Shift+E)', onclick: () => this.emit('switch', 'editor') }, icon('code'), h('span', {}, 'Open Editor Window'))),
    )
  }

  agentItem(a) {
    const st = STATUS[a.status] || STATUS.idle
    const open = this.tabs.includes(a.id)
    const el = h('div', {
      class: 'aw-item' + (a.id === this.focusedAgent() ? ' selected' : '') + (open ? ' open' : ''), title: a.title,
      onclick: (e) => this.openAgent(a.id, { newTab: e.ctrlKey || e.metaKey }),
      onauxclick: (e) => { if (e.button === 1) this.openAgent(a.id, { newTab: true }) },
      oncontextmenu: (e) => { e.preventDefault(); this.itemMenu(e, a) },
    },
    h('span', { class: `status-dot ${st.cls}`, title: st.label }, icon(st.icon, a.status === 'running' ? 'codicon-modifier-spin' : '')),
    h('div', { class: 'aw-item-main' },
      h('div', { class: 'aw-item-title' }, a.title),
      h('div', { class: 'aw-item-sub' },
        a.status === 'awaiting_approval' ? h('span', { class: 'warn' }, 'Needs approval') : a.todos?.length ? `${a.todos.filter((t) => t.status === 'completed').length}/${a.todos.length} to-dos` : (a.lastMessage || '').replace(/[#*`>\n]/g, ' ').slice(0, 60)),
    ),
    h('div', { class: 'aw-item-meta' },
      a.unread ? h('span', { class: 'unread-dot' }) : null,
      a.pendingChanges ? h('span', { class: 'aw-changes', title: `${a.pendingChanges} files to review` }, icon('diff'), a.pendingChanges) : null,
      h('span', { class: 'muted small' }, timeAgo(a.updatedAt))),
    )
    return el
  }

  itemMenu(e, a) {
    contextMenu(e.clientX, e.clientY, [
      ['Open in New Tab', () => this.openAgent(a.id, { newTab: true })],
      ['Open in Editor Window', () => this.emit('switch', 'editor', a.id)],
      ['Rename…', async () => { const t = await inputBox({ value: a.title, prompt: 'Rename agent' }); if (t) agentStore.rename(a.id, t) }],
      a.status === 'running' || a.status === 'awaiting_approval' ? ['Stop', () => agentStore.stop(a.id)] : null,
      ['-'],
      ['Delete', () => { if (confirm(`Delete agent "${a.title}"?`)) { agentStore.remove(a.id); const i = this.tabs.indexOf(a.id); if (i >= 0) this.closeTab(i) } }],
    ].filter(Boolean))
  }

  renderTabs() {
    this.tabStrip.replaceChildren(...this.tabs.map((id, i) => {
      const a = id && agentStore.get(id)
      const st = a ? STATUS[a.status] || STATUS.idle : null
      return h('div', {
        class: 'aw-tab' + (i === this.focused ? ' active' : '') + (this.visibleTabs().includes(id) && this.layoutMode !== 'single' ? ' visible' : ''),
        onclick: () => { this.focused = i; this.persist(); this.renderLayout() },
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(i) } },
        title: a ? a.title : 'New Agent',
      },
      st ? h('span', { class: `status-dot ${st.cls}` }, icon(st.icon, a.status === 'running' ? 'codicon-modifier-spin' : '')) : icon('sparkle'),
      h('span', { class: 'aw-tab-label' }, a ? a.title : 'New Agent'),
      h('button', { class: 'tab-close', onclick: (e) => { e.stopPropagation(); this.closeTab(i) } }, icon('close')))
    }), h('button', { class: 'icon-btn aw-tab-add', title: 'New Agent Tab', onclick: () => { this.tabs.push(null); this.focused = this.tabs.length - 1; this.persist(); this.renderLayout() } }, icon('add')))
    this.renderTopButtons()
  }

  renderTopButtons() {
    const box = this.center.querySelector('.aw-layout-btns')
    if (!box) return
    const b = (m, ic, title) => h('button', { class: 'icon-btn' + (this.layoutMode === m ? ' on' : ''), title, onclick: () => this.setLayout(m) }, icon(ic))
    box.replaceChildren(
      b('single', 'window', 'Single agent'), b('split', 'split-horizontal', 'Side by side (2 agents)'), b('grid', 'layout', 'Grid (4 agents)'),
      h('span', { class: 'sep' }),
      h('button', { class: 'icon-btn' + (!this.reviewPanel.classList.contains('hidden') ? ' on' : ''), title: 'Toggle Review Panel (changes & files)', onclick: () => this.toggleReview() }, icon('layout-sidebar-right')),
      h('button', { class: 'btn-ghost editor-switch', title: 'Open Editor Window (Ctrl+Shift+E)', onclick: () => this.emit('switch', 'editor') }, icon('code'), 'Editor'),
    )
  }

  renderLayout() {
    this.renderTabs()
    this.renderSidebar()
    const vis = this.visibleTabs()
    // reuse panes when possible to avoid flicker
    for (const p of this.panes) p.dispose()
    this.panes = []
    this.stage.className = 'aw-stage layout-' + this.layoutMode
    this.stage.replaceChildren(...vis.map((id) => {
      const idx = this.tabs.indexOf(id)
      const view = new AgentChatView({
        openFile: (p) => this.openFile(p),
        openDiff: (aid, p) => this.openDiff(aid, p),
        onCreated: (newId) => { this.tabs[idx] = newId; this.focused = idx; this.persist(); this.renderTabs(); this.renderSidebar() },
      })
      this.panes.push(view)
      view.show(id)
      const wrap = h('div', { class: 'aw-pane' + (idx === this.focused ? ' focused' : ''), onmousedown: () => { if (this.focused !== idx) { this.focused = idx; this.persist(); this.renderTabs(); this.renderSidebar(); this.stage.querySelectorAll('.aw-pane').forEach((p) => p.classList.toggle('focused', p === wrap)); this.renderReviewList() } } }, view.el)
      if (id === null) wrap.classList.add('is-new')
      return wrap
    }))
    this.renderReviewList()
  }

  async renderReviewList() {
    if (this.reviewPanel.classList.contains('hidden')) return
    const id = this.focusedAgent()
    const tab = (m, label, ic) => h('button', { class: 'aw-rtab' + (this.reviewMode === m ? ' active' : ''), onclick: () => { this.reviewMode = m; this.renderReviewList() } }, icon(ic), label)
    let changes = []
    if (id) { try { changes = await agentStore.changes(id) } catch { /* gone */ } }
    const pending = changes.filter((c) => c.status === 'pending')
    this.reviewTabs.replaceChildren(tab('changes', `Changes${pending.length ? ' ' + pending.length : ''}`, 'diff'), tab('files', 'Files', 'files'), h('div', { class: 'flex1' }),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => this.toggleReview(false) }, icon('close')))
    if (this.reviewMode === 'files') {
      this.reviewList.replaceChildren(h('div', { class: 'aw-files' }, ...files.flat.slice(0, 400).map((p) => h('div', { class: 'aw-file', onclick: () => this.review.openFile(p) }, fileIcon(p), h('span', {}, basename(p)), h('span', { class: 'muted small' }, p)))))
      return
    }
    if (!id) { this.reviewList.replaceChildren(h('div', { class: 'empty-note' }, 'Changes made by the selected agent appear here.')); return }
    if (!changes.length) { this.reviewList.replaceChildren(h('div', { class: 'empty-note' }, 'This agent has not changed any files yet.')); return }
    let add = 0, rem = 0
    const rows = changes.map((c) => {
      const s = lineDiffStats(c.original ?? '', c.current ?? '')
      if (c.status === 'pending') { add += s.added; rem += s.removed }
      return h('div', { class: 'aw-change ' + c.status, onclick: () => this.review.openDiff(id, c.path) },
        fileIcon(c.path), h('span', { class: 'change-name' }, basename(c.path)), h('span', { class: 'muted small change-dir' }, c.path),
        h('div', { class: 'flex1' }),
        c.status !== 'pending' ? h('span', { class: 'diff-status ' + c.status }, c.status) : [h('span', { class: 'plus' }, '+' + s.added), h('span', { class: 'minus' }, '-' + s.removed),
          h('button', { class: 'icon-btn', title: 'Undo', onclick: (e) => { e.stopPropagation(); agentStore.resolve(id, c.path, false) } }, icon('discard')),
          h('button', { class: 'icon-btn', title: 'Keep', onclick: (e) => { e.stopPropagation(); agentStore.resolve(id, c.path, true) } }, icon('check'))])
    })
    this.reviewList.replaceChildren(
      pending.length ? h('div', { class: 'aw-review-actions' }, h('span', {}, `${pending.length} pending`), h('span', { class: 'plus' }, '+' + add), h('span', { class: 'minus' }, '-' + rem), h('div', { class: 'flex1' }),
        h('button', { class: 'btn-ghost', onclick: () => agentStore.resolve(id, null, false) }, 'Undo All'),
        h('button', { class: 'btn-primary small', onclick: () => agentStore.resolve(id, null, true) }, 'Keep All')) : null,
      ...rows)
    if (!this.review.activeTab() && changes[0]) this.review.openDiff(id, changes[0].path)
  }

  focusComposer() { this.panes[this.visibleTabs().indexOf(this.focusedAgent())]?.focus() }
  layout() { this.review.layout() }
}
