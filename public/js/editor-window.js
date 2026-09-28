// Editor Window: the classic VS Code-style workbench.
// ┌ title bar ────────────────────────────────────────────────┐
// │ activity │ side bar │  editor group (tabs + monaco) │ agent │
// │   bar    │ explorer │───────────────────────────────│ panel │
// │          │ search   │  panel (terminal)             │       │
// └ status bar ───────────────────────────────────────────────┘
import { files } from './files.js'
import { agentStore, STATUS } from './agent-store.js'
import { EditorGroup } from './editor-group.js'
import { ExplorerView, SearchView } from './explorer.js'
import { TerminalPanel } from './terminal.js'
import { AgentChatView } from './chat.js'
import { h, icon, sash, timeAgo } from './util.js'
import { Emitter, api } from './api.js'
import { ScmView } from './scm.js'
import { BrowserView, PortsView } from './browser.js'

export class EditorWindow extends Emitter {
  constructor({ workspace }) {
    super()
    this.workspace = workspace
    this.group = new EditorGroup()
    this.explorer = new ExplorerView({ openFile: (p, o) => this.openFile(p, o), workspaceName: workspace.name, onRename: (a, b) => this.group.renameTabsForPath(a, b) })
    this.search = new SearchView({ openFile: (p, o) => this.openFile(p, o) })
    this.agentsList = h('div', { class: 'pane agents-pane' })
    this.terminal = new TerminalPanel({ onLink: (uri) => this.openLink(uri) })
    this.scm = new ScmView({ openDiff: (p) => this.group.openGitDiff(p), openFile: (p) => this.openFile(p, { preview: false }) })
    this.scm.onStatus = (st) => { this.gitStatus = st; this.renderActivity(); this.renderStatus() }
    this.browser = new BrowserView({ onDesignPrompt: (t) => this.sendToChat(t) })
    this.ports = new PortsView({ openPort: (port) => this.openBrowser(`localhost:${port}`) })
    this.group.browser = this.browser
    this.chat = new AgentChatView({
      compact: true,
      openFile: (p) => this.openFile(p, { preview: false }),
      openDiff: (id, p) => this.group.openDiff(id, p),
      onCreated: (id) => { this.chatAgent = id; this.renderChatHead() },
    })
    this.chatAgent = localStorage.getItem('editor.chatAgent') || null
    this.view = localStorage.getItem('editor.view') || 'explorer'

    // --- activity bar
    this.activity = h('div', { class: 'activitybar' })
    // --- side bar
    this.sidebar = h('div', { class: 'sidebar' })
    this.sidebarSash = h('div', { class: 'sash sash-v' })
    // --- panel
    this.panelTab = localStorage.getItem('editor.panelTab') || 'terminal'
    this.panelTitle = h('div', { class: 'panel-title' })
    this.panelBody = h('div', { class: 'panel-body' })
    this.panel = h('div', { class: 'panel' }, this.panelTitle, this.panelBody)
    this.renderPanel()
    this.panelSash = h('div', { class: 'sash sash-h' })
    // --- auxiliary (agent) bar
    this.chatHead = h('div', { class: 'aux-title' })
    this.aux = h('div', { class: 'auxbar' }, this.chatHead, this.chat.el)
    this.auxSash = h('div', { class: 'sash sash-v' })

    this.main = h('div', { class: 'editor-main' }, this.group.el, this.panelSash, this.panel)
    this.status = h('div', { class: 'statusbar' })
    this.el = h('div', { class: 'window editor-window' },
      h('div', { class: 'workbench-body' }, this.activity, this.sidebar, this.sidebarSash, this.main, this.auxSash, this.aux),
      this.status)

    sash(this.sidebarSash, { target: this.sidebar, min: 170, max: 600, storageKey: 'editor.sidebarW' })
    sash(this.auxSash, { target: this.aux, min: 300, max: 900, invert: true, storageKey: 'editor.auxW' })
    sash(this.panelSash, { dir: 'y', target: this.panel, min: 80, max: 800, invert: true, storageKey: 'editor.panelH' })

    this.togglePanel(localStorage.getItem('editor.panel') === '1')
    this.toggleAux(localStorage.getItem('editor.aux') !== '0')
    this.group.on('cursor', () => this.renderStatus())
    this.group.on('active', (t) => { if (t?.kind === 'file') this.explorer.reveal(t.path); this.renderStatus() })
    this.group.on('addToChat', ({ path, text, range }) => {
      this.toggleAux(true)
      if (text) {
        const lines = range ? ` (lines ${range.startLineNumber}-${range.endLineNumber})` : ''
        this.chat.composer.input.value += `\n\`\`\`${path}${lines}\n${text}\n\`\`\`\n`
        this.chat.composer.autosize()
      } else this.chat.composer.addContext(path)
      this.chat.focus()
    })
    agentStore.on('list', () => { this.renderAgentsPane(); this.renderStatus(); this.renderActivity() })
    agentStore.on('summary', () => this.renderChatHead())
    this.renderActivity()
    this.setView(this.view)
    this.renderChatHead()
    this.renderStatus()
    this.chat.show(this.chatAgent && agentStore.get(this.chatAgent) ? this.chatAgent : null)
  }

  renderActivity() {
    const running = agentStore.list.filter((a) => a.status === 'running' || a.status === 'awaiting_approval').length
    const item = (id, ic, title, badge) => h('button', { class: 'activity-item' + (this.view === id && !this.sidebar.classList.contains('hidden') ? ' active' : ''), title, onclick: () => this.setView(id, true) }, icon(ic), badge ? h('span', { class: 'activity-badge' }, badge) : null)
    this.activity.replaceChildren(
      item('explorer', 'files', 'Explorer (Ctrl+Shift+E)'),
      item('search', 'search', 'Search (Ctrl+Shift+F)'),
      item('scm', 'source-control', 'Source Control (Ctrl+Shift+G)', this.gitStatus?.repo ? (this.gitStatus.entries.length || null) : null),
      item('agents', 'hubot', 'Agents', running || null),
      h('button', { class: 'activity-item', title: 'Browser (preview local dev servers)', onclick: () => this.openBrowser() }, icon('globe')),
      h('div', { class: 'flex1' }),
      h('button', { class: 'activity-item', title: 'Open Agents Window (Ctrl+Shift+A)', onclick: () => this.emit('switch', 'agents') }, icon('layout-sidebar-left')),
      h('button', { class: 'activity-item', title: 'Settings', onclick: () => this.emit('settings') }, icon('settings-gear')),
    )
  }

  setView(id, toggle = false) {
    if (toggle && this.view === id && !this.sidebar.classList.contains('hidden')) { this.sidebar.classList.add('hidden'); this.sidebarSash.classList.add('hidden'); this.renderActivity(); return }
    this.view = id
    localStorage.setItem('editor.view', id)
    this.sidebar.classList.remove('hidden'); this.sidebarSash.classList.remove('hidden')
    const el = id === 'search' ? this.search.el : id === 'agents' ? this.agentsList : id === 'scm' ? this.scm.el : this.explorer.el
    if (id === 'scm') this.scm.refresh()
    this.sidebar.replaceChildren(el)
    if (id === 'search') this.search.focus()
    if (id === 'agents') this.renderAgentsPane()
    this.renderActivity()
  }

  renderAgentsPane() {
    if (this.view !== 'agents') return
    this.agentsList.replaceChildren(
      h('div', { class: 'pane-title' }, h('span', {}, 'Agents'), h('div', { class: 'flex1' }),
        h('button', { class: 'icon-btn', title: 'New Agent', onclick: () => this.newChat() }, icon('add')),
        h('button', { class: 'icon-btn', title: 'Open Agents Window', onclick: () => this.emit('switch', 'agents') }, icon('link-external'))),
      ...agentStore.list.map((a) => {
        const st = STATUS[a.status] || STATUS.idle
        return h('div', { class: 'agent-row' + (a.id === this.chatAgent ? ' selected' : ''), onclick: () => this.showAgent(a.id) },
          h('span', { class: `status-dot ${st.cls}` }, icon(st.icon, a.status === 'running' ? 'codicon-modifier-spin' : '')),
          h('span', { class: 'agent-row-title' }, a.title), a.unread ? h('span', { class: 'unread-dot' }) : null, h('span', { class: 'muted small' }, timeAgo(a.updatedAt)))
      }),
      agentStore.list.length ? null : h('div', { class: 'empty-note' }, 'No agents yet. Start one from the Agent panel →'),
    )
  }

  renderChatHead() {
    const a = this.chatAgent && agentStore.get(this.chatAgent)
    this.chatHead.replaceChildren(
      h('span', { class: 'aux-name' }, a ? a.title : 'New Agent'),
      h('div', { class: 'flex1' }),
      h('button', { class: 'icon-btn', title: 'New Agent (Ctrl+N in chat)', onclick: () => this.newChat() }, icon('add')),
      h('button', { class: 'icon-btn', title: 'Agent History', onclick: () => this.pickAgent() }, icon('history')),
      h('button', { class: 'icon-btn', title: 'Open in Agents Window', onclick: () => this.emit('switch', 'agents', this.chatAgent) }, icon('link-external')),
      h('button', { class: 'icon-btn', title: 'Close Agent Panel (Ctrl+L)', onclick: () => this.toggleAux(false) }, icon('close')),
    )
    if (this.chatAgent) localStorage.setItem('editor.chatAgent', this.chatAgent); else localStorage.removeItem('editor.chatAgent')
    this.renderAgentsPane()
  }

  async pickAgent() {
    const { quickPick } = await import('./palette.js')
    const id = await quickPick(agentStore.list.map((a) => ({ label: a.title, description: `${STATUS[a.status]?.label} · ${timeAgo(a.updatedAt)}`, value: a.id, icon: icon('comment-discussion') })), { placeholder: 'Select an agent' })
    if (id) this.showAgent(id)
  }

  newChat() { this.chatAgent = null; this.chat.show(null); this.toggleAux(true); this.renderChatHead(); this.chat.focus() }
  showAgent(id) { this.chatAgent = id; this.toggleAux(true); this.chat.show(id); this.renderChatHead() }

  openFile(p, o) { return this.group.openFile(p, o) }

  renderPanel() {
    const tab = (id, label) => h('span', { class: 'panel-tab' + (this.panelTab === id ? ' active' : ''), onclick: () => { this.panelTab = id; localStorage.setItem('editor.panelTab', id); this.renderPanel() } }, label)
    const isTerm = this.panelTab === 'terminal'
    this.panelTitle.replaceChildren(tab('terminal', 'Terminal'), tab('ports', 'Ports'), h('div', { class: 'flex1' }),
      isTerm ? h('button', { class: 'icon-btn', title: 'New Terminal', onclick: () => this.terminal.create() }, icon('add')) : null,
      isTerm ? h('button', { class: 'icon-btn', title: 'Kill Terminal', onclick: () => this.terminal.kill() }, icon('trash')) : null,
      isTerm ? h('button', { class: 'icon-btn', title: 'Clear', onclick: () => this.terminal.clear() }, icon('clear-all')) : null,
      h('button', { class: 'icon-btn', title: 'Maximize Panel', onclick: () => { this.panel.classList.toggle('maximized'); setTimeout(() => this.terminal.fitAll(), 30) } }, icon('chevron-up')),
      h('button', { class: 'icon-btn', title: 'Close Panel', onclick: () => this.togglePanel(false) }, icon('close')))
    this.panelBody.replaceChildren(isTerm ? this.terminal.el : this.ports.el)
    if (isTerm && !this.panel.classList.contains('hidden')) this.terminal.ensure().then(() => this.terminal.fitAll())
    if (!isTerm) this.ports.render()
  }

  togglePanel(show = this.panel.classList.contains('hidden'), tab) {
    if (tab && tab !== this.panelTab) { this.panelTab = tab; localStorage.setItem('editor.panelTab', tab) }
    this.panel.classList.toggle('hidden', !show)
    this.panelSash.classList.toggle('hidden', !show)
    localStorage.setItem('editor.panel', show ? '1' : '0')
    if (show) { this.renderPanel(); setTimeout(() => this.panelTab === 'terminal' && this.terminal.focus(), 60) }
  }

  openBrowser(url) {
    if (url) this.browser.navigate(url)
    this.group.openBrowser()
  }

  openLink(uri) {
    const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)(\/.*)?$/.exec(uri)
    if (m) this.openBrowser(`localhost:${m[1]}${m[2] || ''}`)
    else window.open(uri, '_blank', 'noopener')
  }

  sendToChat(text) {
    this.toggleAux(true)
    this.chat.composer.input.value = text
    this.chat.composer.autosize()
    this.chat.focus()
  }
  toggleAux(show = this.aux.classList.contains('hidden')) {
    this.aux.classList.toggle('hidden', !show)
    this.auxSash.classList.toggle('hidden', !show)
    localStorage.setItem('editor.aux', show ? '1' : '0')
    this.renderStatus?.()
  }
  toggleSidebar() {
    const hidden = !this.sidebar.classList.contains('hidden')
    this.sidebar.classList.toggle('hidden', hidden); this.sidebarSash.classList.toggle('hidden', hidden); this.renderActivity()
  }

  renderStatus() {
    const t = this.group.activeTab()
    const pos = t?.kind === 'file' ? this.group.editor.getPosition() : null
    const model = t?.kind === 'file' ? this.group.editor.getModel() : null
    const running = agentStore.list.filter((a) => a.status === 'running').length
    const waiting = agentStore.list.filter((a) => a.status === 'awaiting_approval').length
    this.status.replaceChildren(
      h('button', { class: 'sb-item sb-remote', title: 'Switch to Agents Window', onclick: () => this.emit('switch', 'agents') }, icon('remote'), 'Editor'),
      h('button', { class: 'sb-item', title: 'Source Control', onclick: () => this.setView('scm') }, icon('source-control'), this.gitStatus?.repo ? (this.gitStatus.branch || 'HEAD') + (this.gitStatus.entries.length ? '*' : '') : 'no git'),
      h('span', { class: 'sb-item', title: 'Agents' }, icon('hubot'), running ? `${running} running` : 'Agents idle', waiting ? h('span', { class: 'sb-warn' }, ` · ${waiting} needs approval`) : null),
      h('div', { class: 'flex1' }),
      pos ? h('span', { class: 'sb-item' }, `Ln ${pos.lineNumber}, Col ${pos.column}`) : null,
      model ? h('span', { class: 'sb-item' }, `Spaces: ${model.getOptions().tabSize}`) : null,
      model ? h('span', { class: 'sb-item' }, 'UTF-8') : null,
      model ? h('span', { class: 'sb-item' }, model.getLanguageId()) : null,
      h('button', { class: 'sb-item', title: 'Toggle Terminal', onclick: () => this.togglePanel() }, icon('terminal')),
      h('button', { class: 'sb-item', title: 'Toggle Agent Panel', onclick: () => this.toggleAux() }, icon('layout-sidebar-right')),
    )
  }

  layout() { this.group.layout() }
}
