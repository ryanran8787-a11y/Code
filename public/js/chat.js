// AgentChatView: renders an agent conversation (messages, tool calls, diffs,
// terminal output, approvals, todos) plus the composer. Used by the Agents
// Window main pane and by the Editor Window's secondary side bar.
import { agentStore, STATUS } from './agent-store.js'
import { api } from './api.js'
import { files } from './files.js'
import { h, icon, renderMarkdown, basename, fileIcon, lineDiffStats, toast } from './util.js'

const TOOL_META = {
  list_dir: { icon: 'folder-opened', verb: 'Listed', running: 'Listing' },
  read_file: { icon: 'file', verb: 'Read', running: 'Reading' },
  grep_search: { icon: 'search', verb: 'Searched', running: 'Searching' },
  file_search: { icon: 'search-fuzzy', verb: 'Found files', running: 'Finding files' },
  edit_file: { icon: 'edit', verb: 'Edited', running: 'Editing' },
  write_file: { icon: 'new-file', verb: 'Wrote', running: 'Writing' },
  delete_file: { icon: 'trash', verb: 'Deleted', running: 'Deleting' },
  run_terminal_command: { icon: 'terminal', verb: 'Ran', running: 'Running' },
  update_todos: { icon: 'checklist', verb: 'Updated todos', running: 'Updating todos' },
  start_background_process: { icon: 'server-process', verb: 'Started', running: 'Starting' },
  read_process_output: { icon: 'output', verb: 'Read output of', running: 'Reading output of' },
  stop_process: { icon: 'debug-stop', verb: 'Stopped', running: 'Stopping' },
  fetch_url: { icon: 'globe', verb: 'Fetched', running: 'Fetching' },
}

export class Composer {
  constructor({ placeholder = 'Plan, search, build anything… (@ for context)', onSubmit, onStop, compact = false, autofocus = false }) {
    this.onSubmit = onSubmit
    this.onStop = onStop
    this.mode = localStorage.getItem('composer.mode') || 'agent'
    this.env = localStorage.getItem('composer.env') || agentStore.settings?.defaultEnv || 'local'
    this.model = localStorage.getItem('composer.model') || agentStore.settings?.defaultModel || ''
    this.busy = false
    this.isNew = true
    this.input = h('textarea', { class: 'composer-input', rows: 1, placeholder, spellcheck: 'false' })
    this.input.addEventListener('input', () => { this.autosize(); this.updateMention() })
    this.input.addEventListener('keydown', (e) => {
      if (this.menu && this.onMenuKey(e)) return
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit() }
      if (e.key === 'Escape' && this.busy) { e.preventDefault(); this.onStop?.() }
    })
    this.input.addEventListener('blur', () => setTimeout(() => this.closeMenu(), 150))
    this.modeBtn = h('button', { class: 'composer-pill', title: 'Mode (Agent can edit files & run commands, Ask is read-only)', onclick: () => this.toggleMode() })
    this.envBtn = h('button', { class: 'composer-pill env-pill', title: 'Where the new agent runs: Local = edits your workspace directly; Worktree = isolated git worktree + branch, merge when done', onclick: () => this.toggleEnv() })
    this.modelSel = h('select', { class: 'composer-model', title: 'Model' })
    this.modelSel.addEventListener('change', () => { this.model = this.modelSel.value; localStorage.setItem('composer.model', this.model) })
    this.sendBtn = h('button', { class: 'composer-send', title: 'Send (Enter)', onclick: () => (this.busy ? this.onStop?.() : this.submit()) })
    this.mentionBtn = h('button', { class: 'composer-icon-btn', title: 'Add context (@)', onclick: () => this.insertAt() }, icon('mention'))
    this.meter = h('span', { class: 'ctx-meter hidden' })
    this.chips = h('div', { class: 'composer-chips' })
    this.context = [] // {type:'file'|'folder'|'symbol'|'terminal'|'browser', value, label}
    this.el = h('div', { class: 'composer' + (compact ? ' compact' : '') },
      this.chips,
      this.input,
      h('div', { class: 'composer-bar' }, this.modeBtn, this.envBtn, this.modelSel, h('div', { class: 'flex1' }), this.meter, this.mentionBtn, this.sendBtn),
    )
    this.refreshModels()
    this.renderMode()
    this.setBusy(false)
    if (autofocus) setTimeout(() => this.input.focus(), 30)
  }
  refreshModels() {
    const models = agentStore.settings?.models || []
    if (!models.includes(this.model)) this.model = agentStore.settings?.defaultModel || models[0] || ''
    this.modelSel.replaceChildren(...models.map((m) => h('option', { value: m, selected: m === this.model }, m)))
  }
  toggleMode() { this.mode = this.mode === 'agent' ? 'ask' : 'agent'; localStorage.setItem('composer.mode', this.mode); this.renderMode() }
  toggleEnv() { if (!this.isNew) return; this.env = this.env === 'local' ? 'worktree' : 'local'; localStorage.setItem('composer.env', this.env); this.renderMode() }
  setNew(isNew, agent) { this.isNew = isNew; this.agentEnv = agent?.env; this.renderMode() }
  renderMode() {
    this.modeBtn.replaceChildren(icon(this.mode === 'agent' ? 'infinity' : 'comment-discussion'), h('span', {}, this.mode === 'agent' ? 'Agent' : 'Ask'), icon('chevron-down', 'small'))
    const env = this.isNew ? this.env : this.agentEnv || 'local'
    this.envBtn.replaceChildren(icon(env === 'worktree' ? 'git-branch' : 'device-desktop'), h('span', {}, env === 'worktree' ? 'Worktree' : 'Local'))
    this.envBtn.classList.toggle('locked', !this.isNew)
    this.envBtn.classList.toggle('wt', env === 'worktree')
  }
  setBusy(b) {
    this.busy = b
    this.sendBtn.replaceChildren(icon(b ? 'debug-stop' : 'arrow-up'))
    this.sendBtn.classList.toggle('stop', b)
    this.sendBtn.title = b ? 'Stop (Esc)' : 'Send (Enter)'
  }
  setUsage(a) {
    if (!a || !a.contextWindow || !a.contextTokens) { this.meter.classList.add('hidden'); return }
    const used = a.contextTokens
    const pct = Math.min(100, Math.max(1, Math.round((used / a.contextWindow) * 100)))
    this.meter.classList.remove('hidden')
    this.meter.classList.toggle('warn', pct >= 70)
    this.meter.title = `Context: ~${used.toLocaleString()} / ${a.contextWindow.toLocaleString()} tokens (${pct}%)\nTotal usage: ${(a.usage?.prompt || 0).toLocaleString()} in · ${(a.usage?.completion || 0).toLocaleString()} out\nOlder turns are summarized automatically near the limit.`
    this.meter.replaceChildren(h('span', { class: 'ring', style: { background: `conic-gradient(currentColor ${pct * 3.6}deg, #ffffff22 0)` } }), `${pct}%`)
  }
  autosize() { this.input.style.height = 'auto'; this.input.style.height = Math.min(this.input.scrollHeight, 260) + 'px' }

  // ---------------- context chips ----------------
  addContext(item) {
    if (typeof item === 'string') item = item.endsWith('/') ? { type: 'folder', value: item, label: item } : { type: 'file', value: item, label: basename(item) }
    if (this.context.some((c) => c.type === item.type && c.value === item.value)) return
    this.context.push(item)
    this.renderChips()
  }
  renderChips() {
    const ic = (c) => c.type === 'file' ? fileIcon(c.value) : icon(c.type === 'folder' ? 'folder' : c.type === 'symbol' ? 'symbol-method' : c.type === 'terminal' ? 'terminal' : 'globe')
    this.chips.replaceChildren(...this.context.map((c) => h('span', { class: 'chip chip-' + c.type, title: c.value }, ic(c), c.label,
      h('button', { class: 'chip-x', onclick: () => { this.context = this.context.filter((x) => x !== c); this.renderChips() } }, icon('close')))))
  }

  // ---------------- @ mention popup ----------------
  insertAt() {
    const pos = this.input.selectionStart ?? this.input.value.length
    const v = this.input.value
    const pre = pos > 0 && !/\s/.test(v[pos - 1]) ? ' @' : '@'
    this.input.value = v.slice(0, pos) + pre + v.slice(pos)
    this.input.focus()
    this.input.setSelectionRange(pos + pre.length, pos + pre.length)
    this.updateMention()
  }
  mentionQuery() {
    const pos = this.input.selectionStart
    const m = /(^|\s)@([^\s@]*)$/.exec(this.input.value.slice(0, pos))
    return m ? { q: m[2], start: pos - m[2].length - 1, end: pos } : null
  }
  async updateMention() {
    const mq = this.mentionQuery()
    if (!mq) return this.closeMenu()
    const q = mq.q.toLowerCase()
    const seq = (this._seq = (this._seq || 0) + 1)
    const fuzzy = (s) => { let i = 0; s = s.toLowerCase(); for (const ch of q) { i = s.indexOf(ch, i); if (i < 0) return false; i++ } return true }
    const specials = [
      { type: 'terminal', value: 'terminal', label: 'Terminal output', desc: 'latest background process output', icon: icon('terminal') },
      { type: 'browser', value: 'browser', label: 'Browser page', desc: 'page open in the integrated browser', icon: icon('globe') },
    ].filter((x) => !q || x.label.toLowerCase().includes(q))
    const fileItems = files.flat.filter((f) => !q || fuzzy(f))
      .sort((a, b) => (basename(a).toLowerCase().startsWith(q) ? 0 : 1) - (basename(b).toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 8)
      .map((f) => ({ type: 'file', value: f, label: basename(f), desc: f, icon: fileIcon(f) }))
    const dirs = [...new Set(files.flat.flatMap((f) => { const p = f.split('/').slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join('/')) }))]
    const dirItems = dirs.filter((d) => !q || fuzzy(d)).slice(0, 4).map((d) => ({ type: 'folder', value: d + '/', label: basename(d) + '/', desc: d + '/', icon: icon('folder') }))
    this.renderMenu([...fileItems, ...dirItems, ...specials], mq)
    if (q.length >= 1) {
      try {
        const syms = await api.get('/api/symbols?q=' + encodeURIComponent(mq.q))
        if (seq !== this._seq || !this.menu) return
        const kindIcon = { class: 'symbol-class', interface: 'symbol-interface', heading: 'symbol-string', variable: 'symbol-variable', enum: 'symbol-enum' }
        const symItems = syms.slice(0, 8).map((s) => ({ type: 'symbol', value: `${s.path}:${s.line}`, label: s.name, desc: `${s.kind} · ${s.path}:${s.line}`, icon: icon(kindIcon[s.kind] || 'symbol-method') }))
        this.renderMenu([...fileItems, ...dirItems, ...symItems, ...specials], mq)
      } catch { /* ignore */ }
    }
  }
  renderMenu(items, mq) {
    if (!items.length) return this.closeMenu()
    if (!this.menu) { this.menu = h('div', { class: 'mention-menu' }); this.el.append(this.menu) }
    this.menuItems = items
    this.menuMq = mq
    this.menuSel = Math.min(this.menuSel || 0, items.length - 1)
    const group = { file: 'Files', folder: 'Folders', symbol: 'Symbols', terminal: 'Other', browser: 'Other' }
    let last = null
    this.menu.replaceChildren(...items.flatMap((it, i) => {
      const out = []
      if (group[it.type] !== last) { last = group[it.type]; out.push(h('div', { class: 'mm-sep' }, last)) }
      out.push(h('div', { class: 'mm-item' + (i === this.menuSel ? ' sel' : ''), dataset: { type: it.type, value: it.value }, onmousedown: (e) => { e.preventDefault(); this.pickMention(i) }, onmousemove: () => { if (this.menuSel !== i) { this.menuSel = i; this.markMenu() } } },
        it.icon, h('span', { class: 'mm-label' }, it.label), h('span', { class: 'mm-desc' }, it.desc)))
      return out
    }))
  }
  markMenu() {
    const els = this.menu?.querySelectorAll('.mm-item') || []
    els.forEach((el, i) => el.classList.toggle('sel', i === this.menuSel))
    els[this.menuSel]?.scrollIntoView({ block: 'nearest' })
  }
  onMenuKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.menuSel = Math.min(this.menuItems.length - 1, this.menuSel + 1); this.markMenu(); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.menuSel = Math.max(0, this.menuSel - 1); this.markMenu(); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.pickMention(this.menuSel); return true }
    if (e.key === 'Escape') { e.preventDefault(); this.closeMenu(); return true }
    return false
  }
  pickMention(i) {
    const it = this.menuItems?.[i]; const mq = this.menuMq
    if (!it) return
    const v = this.input.value
    this.input.value = v.slice(0, mq.start) + v.slice(mq.end)
    this.input.setSelectionRange(mq.start, mq.start)
    this.addContext({ type: it.type, value: it.value, label: it.label })
    this.closeMenu()
    this.autosize()
  }
  closeMenu() { this.menu?.remove(); this.menu = null; this.menuSel = 0 }
  pickFile() { this.insertAt() }

  /** Expand chips into textual context for the model. */
  async expandContext() {
    const parts = []
    for (const c of this.context) {
      if (c.type === 'file') parts.push(`- File: \`${c.value}\``)
      else if (c.type === 'folder') {
        const inside = files.flat.filter((f) => f.startsWith(c.value)).slice(0, 60)
        parts.push(`- Folder: \`${c.value}\` containing:\n${inside.map((f) => '  - ' + f).join('\n')}`)
      } else if (c.type === 'symbol') parts.push(`- Symbol \`${c.label}\` defined at \`${c.value}\``)
      else if (c.type === 'terminal') {
        let out = ''
        try { const ps = await api.get('/api/processes'); if (ps[0]) out = `Process \`${ps[0].command}\` (${ps[0].status}):\n${ps[0].tail.slice(-3000)}` } catch { /* */ }
        parts.push('- Terminal output:\n```\n' + (out || '(no background process output available)') + '\n```')
      } else if (c.type === 'browser') {
        const url = localStorage.getItem('browser.url')
        parts.push(url ? `- Browser page: http://${url} (use fetch_url to inspect it)` : '- Browser page: (none open)')
      }
    }
    return parts.length ? '\n\nContext:\n' + parts.join('\n') : ''
  }
  async submit() {
    let text = this.input.value.trim()
    if (!text || this.busy) return
    text += await this.expandContext()
    this.onSubmit?.(text, { mode: this.mode, model: this.model, env: this.env })
    this.input.value = ''
    this.context = []
    this.renderChips()
    this.autosize()
  }
  focus() { this.input.focus() }
}

function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n) }

export class AgentChatView {
  /**
   * @param {object} o
   * @param {(path:string, opts?:any)=>void} o.openFile   open a file in the editor
   * @param {(agentId:string, path:string)=>void} o.openDiff open a diff review
   * @param {(id:string)=>void} o.onCreated called when a new agent was created from the empty state
   */
  constructor({ openFile, openDiff, onCreated, compact = false }) {
    this.openFile = openFile
    this.openDiff = openDiff
    this.onCreated = onCreated
    this.compact = compact
    this.agentId = null
    this.itemEls = new Map()
    this.scroller = h('div', { class: 'chat-scroll' })
    this.list = h('div', { class: 'chat-list' })
    this.scroller.append(this.list)
    this.todosEl = h('div', { class: 'chat-todos hidden' })
    this.changesBar = h('div', { class: 'changes-bar hidden' })
    this.composer = new Composer({
      compact,
      onSubmit: (text, o) => this.submit(text, o),
      onStop: () => this.agentId && agentStore.stop(this.agentId),
    })
    this.header = h('div', { class: 'chat-header' })
    this.el = h('div', { class: 'agent-chat' + (compact ? ' compact' : '') }, this.header, this.scroller,
      h('div', { class: 'chat-bottom' }, this.todosEl, this.changesBar, this.composer.el))
    this.stick = true
    this.scroller.addEventListener('scroll', () => {
      this.stick = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40
    })
    this.unsub = [
      agentStore.on('item', (id, item) => id === this.agentId && this.renderItem(item)),
      agentStore.on('delta', (id, item) => id === this.agentId && this.renderItem(item)),
      agentStore.on('summary', (s) => { if (s.id !== this.agentId) return; this.renderMeta(); if (s.unread && this.el.isConnected && this.el.offsetParent) agentStore.markRead(s.id) }),
      agentStore.on('changes', (id) => id === this.agentId && this.renderChanges()),
      agentStore.on('detail', (id) => id === this.agentId && this.renderAll()),
    ]
  }

  async show(agentId) {
    this.agentId = agentId
    this.todosOpen = undefined
    this.itemEls.clear()
    this.list.replaceChildren()
    if (!agentId) { this.renderEmpty(); this.renderMeta(); return }
    await agentStore.load(agentId)
    if (this.agentId !== agentId) return
    agentStore.markRead(agentId)
    this.renderAll()
  }

  renderEmpty() {
    this.list.replaceChildren(h('div', { class: 'chat-empty' },
      h('div', { class: 'chat-empty-logo' }),
      h('div', { class: 'chat-empty-title' }, this.compact ? 'New Agent' : 'What should we build?'),
      h('div', { class: 'chat-empty-sub' }, 'Agents read files, edit code and run terminal commands on your workspace autonomously.'),
      h('div', { class: 'chat-suggestions' },
        ...['Explain the structure of this project', 'Add a `remove(id)` method to src/todo.js and a test for it, then run `npm test`', 'Find all TODO comments in the code'].map((s) =>
          h('button', { class: 'suggestion', onclick: () => { this.composer.input.value = s; this.composer.autosize(); this.composer.focus() } }, icon('sparkle'), s)),
      ),
    ))
    this.todosEl.classList.add('hidden')
    this.changesBar.classList.add('hidden')
    this.composer.setBusy(false)
  }

  renderAll() {
    const d = agentStore.details.get(this.agentId)
    if (!d) return
    this.itemEls.clear()
    this.list.replaceChildren()
    for (const it of d.timeline) this.renderItem(it, false)
    this.renderMeta()
    this.renderChanges()
    this.scrollToBottom(true)
  }

  renderMeta() {
    const a = agentStore.get(this.agentId)
    const busy = a && (a.status === 'running' || a.status === 'awaiting_approval')
    this.composer.setBusy(!!busy)
    this.composer.setNew(!a, a)
    this.composer.setUsage(a)
    this.header.replaceChildren()
    if (a) {
      const st = STATUS[a.status] || STATUS.idle
      this.header.append(
        h('span', { class: `status-dot ${st.cls}` }, icon(st.icon, a.status === 'running' ? 'codicon-modifier-spin' : '')),
        h('span', { class: 'chat-title', title: a.title }, a.title),
        a.env === 'worktree' ? h('span', { class: 'wt-badge', title: 'Isolated git worktree branch' }, icon('git-branch'), a.branch || 'worktree') : null,
        h('span', { class: 'chat-sub' }, a.model),
        h('div', { class: 'flex1' }),
        a.usage?.prompt ? h('span', { class: 'chat-usage', title: 'Total tokens used by this agent' }, `${fmtTok(a.usage.prompt)} in · ${fmtTok(a.usage.completion)} out`) : null,
        a.status !== 'running' && a.contextTokens ? h('button', { class: 'icon-btn', title: 'Compact context now (summarize older turns)', onclick: () => api.post(`/api/agents/${a.id}/compact`).then(() => toast('Context compacted')).catch((e) => toast(e.message, 'error')) }, icon('fold')) : null,
      )
    } else this.header.append(h('span', { class: 'chat-title' }, 'New Agent'))
    // thinking indicator
    this.list.querySelector('.thinking')?.remove()
    if (a?.status === 'running') {
      this.list.append(h('div', { class: 'thinking' }, h('span', { class: 'shimmer' }, 'Working'), h('span', { class: 'dots' }, h('i'), h('i'), h('i'))))
      this.scrollToBottom()
    }
    // todos
    if (a?.todos?.length) {
      const done = a.todos.filter((t) => t.status === 'completed').length
      this.todosEl.classList.remove('hidden')
      const running = a.status === 'running' || a.status === 'awaiting_approval'
      if (this.todosOpen === undefined || this._lastRunning !== running) this.todosOpen = running
      this._lastRunning = running
      this.todosEl.classList.toggle('collapsed', !this.todosOpen)
      this.todosEl.replaceChildren(
        h('div', { class: 'todos-head', onclick: () => { this.todosOpen = !this.todosOpen; this.todosEl.classList.toggle('collapsed', !this.todosOpen) } }, icon('chevron-down', 'chev'), icon('checklist'), `To-dos ${done}/${a.todos.length}`),
        ...a.todos.map((t) => h('div', { class: 'todo ' + t.status }, icon(t.status === 'completed' ? 'pass-filled' : t.status === 'in_progress' ? 'circle-large-filled' : 'circle-large-outline'), h('span', {}, t.content))),
      )
    } else this.todosEl.classList.add('hidden')
  }

  async renderChanges() {
    if (!this.agentId) return
    const d = agentStore.details.get(this.agentId)
    const a = agentStore.get(this.agentId)
    let pending = []
    try {
      pending = (await agentStore.changes(this.agentId)).filter((c) => c.status === 'pending')
    } catch { /* ignore */ }
    if (!pending.length) { this.changesBar.classList.add('hidden'); return }
    let add = 0, rem = 0
    const rows = pending.map((c) => {
      const s = lineDiffStats(c.original ?? '', c.current ?? '')
      add += s.added; rem += s.removed
      return h('div', { class: 'change-row', onclick: () => this.openDiff?.(this.agentId, c.path) },
        fileIcon(c.path), h('span', { class: 'change-name' }, basename(c.path)), h('span', { class: 'change-dir' }, c.path),
        c.original === null ? h('span', { class: 'badge-new' }, 'new') : null,
        c.current === null ? h('span', { class: 'badge-del' }, 'deleted') : null,
        h('span', { class: 'plus' }, '+' + s.added), h('span', { class: 'minus' }, '-' + s.removed),
        h('button', { class: 'icon-btn', title: 'Undo file', onclick: (e) => { e.stopPropagation(); agentStore.resolve(this.agentId, c.path, false) } }, icon('discard')),
        h('button', { class: 'icon-btn', title: 'Keep file', onclick: (e) => { e.stopPropagation(); agentStore.resolve(this.agentId, c.path, true) } }, icon('check')),
      )
    })
    const open = this.changesBar.classList.contains('open')
    this.changesBar.classList.remove('hidden')
    this.changesBar.replaceChildren(
      h('div', { class: 'changes-head', onclick: () => this.changesBar.classList.toggle('open') },
        icon('chevron-right', 'chev'),
        h('span', {}, `${pending.length} file${pending.length > 1 ? 's' : ''} changed`),
        h('span', { class: 'plus' }, '+' + add), h('span', { class: 'minus' }, '-' + rem),
        h('div', { class: 'flex1' }),
        h('button', { class: 'btn-ghost', onclick: (e) => { e.stopPropagation(); agentStore.resolve(this.agentId, null, false).catch((er) => toast(er.message, 'error')) } }, a?.env === 'worktree' ? 'Discard' : 'Undo all'),
        h('button', { class: 'btn-primary small', title: a?.env === 'worktree' ? 'Apply the worktree changes to your workspace' : 'Keep all changes', onclick: (e) => { e.stopPropagation(); agentStore.resolve(this.agentId, null, true).then(() => a?.env === 'worktree' && toast('Merged into workspace')).catch((er) => toast(er.message, 'error')) } }, a?.env === 'worktree' ? [icon('git-merge'), ' Apply'] : 'Keep all'),
        h('button', { class: 'btn-ghost review-btn', title: 'Review diffs', onclick: (e) => { e.stopPropagation(); this.openDiff?.(this.agentId, pending[0].path) } }, icon('diff'), h('span', { class: 'review-label' }, 'Review')),
      ),
      h('div', { class: 'changes-list' }, rows),
    )
    if (open) this.changesBar.classList.add('open')
  }

  scrollToBottom(force = false) {
    if (force || this.stick) requestAnimationFrame(() => { this.scroller.scrollTop = this.scroller.scrollHeight })
  }

  async submit(text, o) {
    try {
      if (!this.agentId) {
        const s = await agentStore.create(text, o)
        this.onCreated?.(s.id)
        await this.show(s.id)
      } else {
        await agentStore.send(this.agentId, text, o)
      }
      this.stick = true
    } catch (e) { toast(e.message, 'error') }
  }

  renderItem(it, scroll = true) {
    let el = this.itemEls.get(it.id)
    const fresh = this.buildItem(it)
    if (!fresh) return
    if (el) el.replaceWith(fresh)
    else {
      const thinking = this.list.querySelector('.thinking')
      if (thinking) this.list.insertBefore(fresh, thinking); else this.list.append(fresh)
    }
    this.itemEls.set(it.id, fresh)
    if (scroll) this.scrollToBottom()
  }

  buildItem(it) {
    switch (it.type) {
      case 'user':
        return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble' }, it.text))
      case 'assistant': {
        const el = h('div', { class: 'msg msg-assistant markdown', html: renderMarkdown(it.text) })
        el.querySelectorAll('a').forEach((a) => a.setAttribute('target', '_blank'))
        return el
      }
      case 'reasoning': {
        const d = h('details', { class: 'reasoning' }, h('summary', {}, icon('lightbulb'), 'Thought'), h('div', { class: 'reasoning-body' }, it.text))
        return d
      }
      case 'error':
        return h('div', { class: 'msg msg-error' }, icon('error'), h('span', {}, it.text))
      case 'tool':
        return this.buildTool(it)
    }
    return null
  }

  buildTool(it) {
    const m = TOOL_META[it.name] || { icon: 'tools', verb: it.name, running: it.name }
    const a = it.args || {}
    const running = it.status === 'running'
    const statusIcon = running ? icon('loading', 'codicon-modifier-spin') : it.status === 'error' ? icon('error', 'err') : it.status === 'rejected' ? icon('circle-slash', 'muted') : it.status === 'pending_approval' ? icon('shield', 'warn') : null
    const verb = running ? m.running : it.status === 'error' ? `Failed: ${m.verb.toLowerCase()}` : m.verb
    const fileLink = (p, label) => h('a', { class: 'file-link', onclick: (e) => { e.stopPropagation(); this.openFile?.(p) } }, fileIcon(p), label || basename(p))

    if (it.name === 'edit_file' || it.name === 'write_file' || it.name === 'delete_file') {
      const p = a.path || ''
      const card = h('div', { class: 'tool-card edit-card' })
      const meta = it.meta || {}
      card.append(h('div', { class: 'edit-head', onclick: () => this.openDiff?.(this.agentId, p) },
        statusIcon || icon(m.icon), fileLink(p),
        meta.created ? h('span', { class: 'badge-new' }, 'new') : null,
        it.status === 'done' && it.name !== 'delete_file' ? [h('span', { class: 'plus' }, '+' + (meta.added ?? 0)), h('span', { class: 'minus' }, '-' + (meta.removed ?? 0))] : null,
        h('div', { class: 'flex1' }),
        it.status === 'error' ? h('span', { class: 'tool-err', title: it.result }, 'failed') : null,
      ))
      // inline mini diff
      if (it.name === 'edit_file' && a.old_string !== undefined && it.status !== 'error') {
        card.append(miniDiff(a.old_string || '', a.new_string || ''))
      } else if (it.name === 'write_file' && typeof a.content === 'string' && it.status !== 'error') {
        card.append(miniDiff('', a.content.split('\n').slice(0, 14).join('\n') + (a.content.split('\n').length > 14 ? '\n…' : '')))
      }
      if (it.status === 'error') card.append(h('div', { class: 'tool-error-text' }, it.result))
      return card
    }

    if (it.name === 'start_background_process') {
      const ports = it.meta?.ports || []
      const card = h('div', { class: 'tool-card term-card' + (it.status === 'pending_approval' ? ' needs-approval' : '') },
        h('div', { class: 'term-head' }, statusIcon || icon('server-process'), h('span', { class: 'term-label' }, it.status === 'pending_approval' ? 'Start background process?' : `${verb} background process`),
          it.meta?.procId ? h('code', { class: 'muted' }, it.meta.procId) : null, h('div', { class: 'flex1' }),
          ...ports.map((p) => h('button', { class: 'port-chip', title: 'Open in browser', onclick: () => window.cursorWeb?.openPreview?.(p) }, icon('globe'), 'localhost:' + p))),
        h('pre', { class: 'term-cmd' }, h('span', { class: 'prompt' }, '$ '), a.command || ''),
        it.result && it.status !== 'pending_approval' ? h('pre', { class: 'term-out' }, (it.result.split('--- output ---\n')[1] || '').slice(-3000)) : null)
      if (it.status === 'pending_approval') card.append(h('div', { class: 'approve-bar' },
        h('button', { class: 'btn-ghost', onclick: () => agentStore.approve(this.agentId, it.id, false) }, 'Skip'),
        h('button', { class: 'btn-primary small', onclick: () => agentStore.approve(this.agentId, it.id, true) }, 'Start')))
      return card
    }
    if (it.name === 'fetch_url') {
      const st = it.meta?.status
      const u = String(a.url || '')
      const pm = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)(\/.*)?/.exec(u)
      return h('details', { class: 'tool-line-wrap' },
        h('summary', { class: 'tool-line' }, statusIcon || icon('globe'), h('span', { class: 'verb' }, verb), h('code', {}, u),
          st !== undefined ? h('span', { class: st >= 200 && st < 400 ? 'exit-ok' : 'exit-bad' }, ' ' + (st || 'failed')) : null,
          pm ? h('a', { class: 'file-link', onclick: (e) => { e.preventDefault(); window.cursorWeb?.openPreview?.(pm[1], pm[2]) } }, ' open') : null),
        it.result ? h('pre', { class: 'tool-result' }, it.result.slice(0, 4000)) : null)
    }

    if (it.name === 'run_terminal_command') {
      const out = it.output || (it.result ? it.result.replace(/^\$ .*\n/, '') : '')
      const exit = it.meta?.exitCode
      const card = h('div', { class: 'tool-card term-card' + (it.status === 'pending_approval' ? ' needs-approval' : '') },
        h('div', { class: 'term-head' }, statusIcon || icon('terminal'), h('span', { class: 'term-label' }, it.status === 'pending_approval' ? 'Run command?' : verb),
          h('div', { class: 'flex1' }),
          exit !== undefined && exit !== null ? h('span', { class: exit === 0 ? 'exit-ok' : 'exit-bad' }, `exit ${exit}`) : null),
        h('pre', { class: 'term-cmd' }, h('span', { class: 'prompt' }, '$ '), a.command || ''),
        out ? h('pre', { class: 'term-out' }, out.slice(-6000)) : null,
      )
      if (it.status === 'pending_approval') {
        card.append(h('div', { class: 'approve-bar' },
          h('button', { class: 'btn-ghost', onclick: () => agentStore.approve(this.agentId, it.id, false) }, 'Skip'),
          h('button', { class: 'btn-primary small', onclick: () => agentStore.approve(this.agentId, it.id, true) }, 'Run ', h('kbd', {}, '⏎')),
        ))
      }
      return card
    }

    if (it.name === 'update_todos') return h('div', { class: 'tool-line' }, icon('checklist'), h('span', {}, `Updated to-dos (${(a.todos || []).length})`))

    // read / list / search: compact collapsible line
    let label = ''
    if (it.name === 'read_file') {
      const r = it.meta?.range
      label = [fileLink(a.path || ''), r ? h('span', { class: 'muted' }, ` L${r[0]}-${r[1]}`) : null]
    } else if (it.name === 'list_dir') label = h('code', {}, (a.path && a.path !== '.' ? a.path.replace(/\/$/, '') : '.') + '/')
    else if (it.name === 'grep_search') label = [h('code', {}, a.query), it.meta ? h('span', { class: 'muted' }, ` ${it.meta.count} results`) : null]
    else if (it.name === 'read_process_output' || it.name === 'stop_process') label = h('code', {}, a.id)
    else if (it.name === 'file_search') label = [h('code', {}, a.pattern), it.meta ? h('span', { class: 'muted' }, ` ${it.meta.count} files`) : null]
    else label = h('code', {}, JSON.stringify(a).slice(0, 80))
    const d = h('details', { class: 'tool-line-wrap' },
      h('summary', { class: 'tool-line' }, statusIcon || icon(m.icon), h('span', { class: 'verb' }, verb), label),
      it.result ? h('pre', { class: 'tool-result' }, it.result.slice(0, 4000)) : null,
    )
    return d
  }

  focus() { this.composer.focus() }
  dispose() { this.unsub.forEach((u) => u()) }
}

function miniDiff(a, b) {
  const box = h('div', { class: 'mini-diff' })
  const parts = window.Diff ? window.Diff.diffLines(a, b) : [{ removed: true, value: a }, { added: true, value: b }]
  let lines = 0
  for (const p of parts) {
    const ls = p.value.replace(/\n$/, '').split('\n')
    if (!p.added && !p.removed) {
      // context: show at most 2 lines around changes
      const ctx = ls.length > 4 ? [...ls.slice(0, 2), '⋯', ...ls.slice(-2)] : ls
      for (const l of ctx) { if (lines++ > 40) break; box.append(h('div', { class: 'dl ctx' }, h('span', { class: 'sig' }, ' '), l)) }
      continue
    }
    for (const l of ls) {
      if (lines++ > 40) break
      box.append(h('div', { class: 'dl ' + (p.added ? 'add' : 'del') }, h('span', { class: 'sig' }, p.added ? '+' : '-'), l))
    }
  }
  if (lines > 40) box.append(h('div', { class: 'dl ctx' }, '…'))
  return box
}
