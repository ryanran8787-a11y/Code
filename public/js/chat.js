// AgentChatView: renders an agent conversation (messages, tool calls, diffs,
// terminal output, approvals, todos) plus the composer. Used by the Agents
// Window main pane and by the Editor Window's secondary side bar.
import { agentStore, STATUS } from './agent-store.js'
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
}

export class Composer {
  constructor({ placeholder = 'Plan, search, build anything…', onSubmit, onStop, compact = false, autofocus = false }) {
    this.onSubmit = onSubmit
    this.onStop = onStop
    this.mode = localStorage.getItem('composer.mode') || 'agent'
    this.model = localStorage.getItem('composer.model') || agentStore.settings?.defaultModel || ''
    this.busy = false
    this.input = h('textarea', { class: 'composer-input', rows: 1, placeholder, spellcheck: 'false' })
    this.input.addEventListener('input', () => this.autosize())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit() }
      if (e.key === 'Escape' && this.busy) { e.preventDefault(); this.onStop?.() }
    })
    this.modeBtn = h('button', { class: 'composer-pill', title: 'Mode (Agent can edit files & run commands, Ask is read-only)', onclick: () => this.toggleMode() })
    this.modelSel = h('select', { class: 'composer-model', title: 'Model' })
    this.modelSel.addEventListener('change', () => { this.model = this.modelSel.value; localStorage.setItem('composer.model', this.model) })
    this.sendBtn = h('button', { class: 'composer-send', title: 'Send (Enter)', onclick: () => (this.busy ? this.onStop?.() : this.submit()) })
    this.mentionBtn = h('button', { class: 'composer-icon-btn', title: 'Add file context (@)', onclick: () => this.pickFile() }, icon('mention'))
    this.chips = h('div', { class: 'composer-chips' })
    this.context = []
    this.el = h('div', { class: 'composer' + (compact ? ' compact' : '') },
      this.chips,
      this.input,
      h('div', { class: 'composer-bar' }, this.modeBtn, this.modelSel, h('div', { class: 'flex1' }), this.mentionBtn, this.sendBtn),
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
  renderMode() {
    this.modeBtn.replaceChildren(icon(this.mode === 'agent' ? 'infinity' : 'comment-discussion'), h('span', {}, this.mode === 'agent' ? 'Agent' : 'Ask'), icon('chevron-down', 'small'))
  }
  setBusy(b) {
    this.busy = b
    this.sendBtn.replaceChildren(icon(b ? 'debug-stop' : 'arrow-up'))
    this.sendBtn.classList.toggle('stop', b)
    this.sendBtn.title = b ? 'Stop (Esc)' : 'Send (Enter)'
  }
  autosize() { this.input.style.height = 'auto'; this.input.style.height = Math.min(this.input.scrollHeight, 260) + 'px' }
  addContext(path) {
    if (this.context.includes(path)) return
    this.context.push(path)
    this.renderChips()
  }
  renderChips() {
    this.chips.replaceChildren(...this.context.map((p) => h('span', { class: 'chip', title: p }, fileIcon(p), basename(p),
      h('button', { class: 'chip-x', onclick: () => { this.context = this.context.filter((x) => x !== p); this.renderChips() } }, icon('close')))))
  }
  async pickFile() {
    const { quickPick } = await import('./palette.js')
    const p = await quickPick(files.flat.map((f) => ({ label: basename(f), description: f, value: f, icon: fileIcon(f) })), { placeholder: 'Add file to context' })
    if (p) this.addContext(p)
    this.input.focus()
  }
  submit() {
    let text = this.input.value.trim()
    if (!text || this.busy) return
    if (this.context.length) text += '\n\nContext files: ' + this.context.map((p) => '`' + p + '`').join(', ')
    this.onSubmit?.(text, { mode: this.mode, model: this.model })
    this.input.value = ''
    this.context = []
    this.renderChips()
    this.autosize()
  }
  focus() { this.input.focus() }
}

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
    this.header.replaceChildren()
    if (a) {
      const st = STATUS[a.status] || STATUS.idle
      this.header.append(
        h('span', { class: `status-dot ${st.cls}` }, icon(st.icon, a.status === 'running' ? 'codicon-modifier-spin' : '')),
        h('span', { class: 'chat-title', title: a.title }, a.title),
        h('span', { class: 'chat-sub' }, a.model),
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
        h('button', { class: 'btn-ghost', onclick: (e) => { e.stopPropagation(); agentStore.resolve(this.agentId, null, false) } }, 'Undo all'),
        h('button', { class: 'btn-primary small', onclick: (e) => { e.stopPropagation(); agentStore.resolve(this.agentId, null, true) } }, 'Keep all'),
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
