import { api, connectEvents, bus } from './api.js'
import { files } from './files.js'
import { agentStore, STATUS } from './agent-store.js'
import { EditorWindow } from './editor-window.js'
import { AgentsWindow } from './agents-window.js'
import { quickPick } from './palette.js'
import { setupTabCompletion } from './inline-tab.js'
import { setupInlineEdit } from './inline-edit.js'
import { h, icon, fileIcon, basename, toast, timeAgo } from './util.js'

const app = {}
window.cursorWeb = app // handy for debugging / e2e tests

async function boot() {
  const [monaco, theme, workspace] = await Promise.all([window.monacoReady, api.get('/api/theme'), api.get('/api/workspace')])
  // Apply VS Code 2026 Dark theme (from microsoft/vscode theme-defaults) to chrome + Monaco
  for (const [k, v] of Object.entries(theme.cssVars)) document.documentElement.style.setProperty(k, v)
  monaco.editor.defineTheme('cursor-dark', theme.monaco)
  monaco.editor.setTheme('cursor-dark')
  // JS/TS: we have no project config; keep diagnostics light
  monaco.languages.typescript?.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  monaco.languages.typescript?.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

  connectEvents()
  await Promise.all([agentStore.init(), files.refreshTree()])
  setupTabCompletion()
  app.workspace = workspace
  document.title = `${workspace.name} — CursorWeb`

  const root = h('div', { class: 'app' })
  const title = h('div', { class: 'titlebar' })
  app.editor = new EditorWindow({ workspace })
  app.agents = new AgentsWindow({ workspace })
  root.append(title, h('div', { class: 'windows' }, app.agents.el, app.editor.el))
  document.getElementById('boot').remove()
  document.body.append(root)
  setupInlineEdit(app.editor.group)

  for (const w of [app.editor, app.agents]) {
    w.on('switch', (to, agentId) => switchWindow(to, agentId))
    w.on('settings', () => openSettings())
    w.on('quickOpen', () => quickOpen())
  }
  app.title = title
  renderTitle()
  agentStore.on('list', renderTitle)
  bus.on('connection', (ok) => document.body.classList.toggle('offline', !ok))

  const initial = location.hash === '#editor' ? 'editor' : location.hash === '#agents' ? 'agents' : localStorage.getItem('window') || 'agents'
  switchWindow(initial)
  window.addEventListener('hashchange', () => { const w = location.hash.slice(1); if (w === 'editor' || w === 'agents') switchWindow(w) })
  window.addEventListener('beforeunload', (e) => { if ([...files.docs.values()].some((d) => d.dirty)) { e.preventDefault(); e.returnValue = '' } })
  window.addEventListener('keydown', onKey, true)
  if (!agentStore.settings.hasApiKey && !agentStore.settings.baseUrl.startsWith('mock')) setTimeout(() => toast('No API key configured. Open Settings to configure an OpenAI-compatible endpoint.', 'warn', 8000), 600)
}

function renderTitle() {
  const w = document.body.dataset.window
  const running = agentStore.list.filter((a) => a.status === 'running' || a.status === 'awaiting_approval').length
  app.title.replaceChildren(
    h('div', { class: 'title-left' }, h('div', { class: 'brand-logo small' }),
      h('div', { class: 'window-switch', role: 'tablist' },
        h('button', { class: 'ws-btn' + (w === 'agents' ? ' active' : ''), onclick: () => switchWindow('agents'), title: 'Agents Window (Ctrl+Shift+A)' }, icon('hubot'), 'Agents', running ? h('span', { class: 'ws-badge' }, running) : null),
        h('button', { class: 'ws-btn' + (w === 'editor' ? ' active' : ''), onclick: () => switchWindow('editor'), title: 'Editor Window (Ctrl+Shift+E)' }, icon('code'), 'Editor'))),
    h('button', { class: 'title-search', onclick: () => quickOpen() }, icon('search'), h('span', {}, app.workspace.name), h('span', { class: 'flex1' }), h('kbd', {}, 'Ctrl'), h('kbd', {}, 'P')),
    h('div', { class: 'title-right' },
      h('button', { class: 'icon-btn', title: 'Command Palette (Ctrl+Shift+P)', onclick: () => commandPalette() }, icon('terminal-cmd')),
      h('button', { class: 'icon-btn', title: 'Settings', onclick: () => openSettings() }, icon('settings-gear'))),
  )
}

function switchWindow(to, agentId) {
  document.body.dataset.window = to
  localStorage.setItem('window', to)
  if (location.hash !== '#' + to) history.replaceState(null, '', '#' + to)
  app.editor.el.classList.toggle('hidden', to !== 'editor')
  app.agents.el.classList.toggle('hidden', to !== 'agents')
  if (to === 'editor') {
    if (agentId !== undefined) app.editor.showAgent(agentId)
    requestAnimationFrame(() => app.editor.layout())
  } else {
    if (agentId) app.agents.openAgent(agentId)
    requestAnimationFrame(() => { app.agents.layout(); app.agents.focusComposer() })
  }
  renderTitle()
}
app.switchWindow = switchWindow
app.openPreview = (port, path = '') => {
  const url = `localhost:${port}${path || ''}`
  if (document.body.dataset.window === 'agents') app.agents.openBrowser(url)
  else app.editor.openBrowser(url)
}

async function quickOpen(initial = '') {
  const recent = JSON.parse(localStorage.getItem('recentFiles') || '[]').filter((p) => files.flat.includes(p))
  const ordered = [...recent, ...files.flat.filter((p) => !recent.includes(p))]
  const v = await quickPick((q) => {
    if (q.startsWith('>')) return commands().filter((c) => !q.slice(1).trim() || fuzzy(c.label, q.slice(1).trim())).map((c) => ({ ...c, value: { cmd: c } }))
    return ordered.filter((p) => !q || fuzzy(p, q)).map((p) => ({ label: basename(p), description: p, value: { file: p }, icon: fileIcon(p) }))
  }, { placeholder: 'Search files by name (append > for commands)', value: initial })
  if (!v) return
  if (v.cmd) return v.cmd.run()
  openFileAnywhere(v.file)
}

function openFileAnywhere(p) {
  const recent = JSON.parse(localStorage.getItem('recentFiles') || '[]').filter((x) => x !== p)
  localStorage.setItem('recentFiles', JSON.stringify([p, ...recent].slice(0, 20)))
  if (document.body.dataset.window === 'agents') app.agents.openFile(p)
  else app.editor.openFile(p, { preview: false })
}

function fuzzy(s, q) {
  s = s.toLowerCase(); q = q.toLowerCase()
  let i = 0
  for (const ch of q) { if (ch === ' ') continue; i = s.indexOf(ch, i); if (i < 0) return false; i++ }
  return true
}

function commands() {
  const inEditor = document.body.dataset.window === 'editor'
  return [
    { label: 'Open Agents Window', keybinding: 'Ctrl+Shift+A', run: () => switchWindow('agents'), icon: icon('hubot') },
    { label: 'Open Editor Window', keybinding: 'Ctrl+Shift+E', run: () => switchWindow('editor'), icon: icon('code') },
    { label: 'Agents: New Agent', keybinding: 'Ctrl+N', run: () => newAgent(), icon: icon('add') },
    { label: 'Agents: Switch to Agent…', run: () => pickAgent(), icon: icon('list-selection') },
    { label: 'Agents: Stop All Running Agents', run: () => agentStore.list.filter((a) => a.status === 'running' || a.status === 'awaiting_approval').forEach((a) => agentStore.stop(a.id)), icon: icon('debug-stop') },
    { label: 'Agents Window: Single Layout', run: () => { switchWindow('agents'); app.agents.setLayout('single') }, icon: icon('window') },
    { label: 'Agents Window: Side-by-Side Layout', run: () => { switchWindow('agents'); app.agents.setLayout('split') }, icon: icon('split-horizontal') },
    { label: 'Agents Window: Grid Layout', run: () => { switchWindow('agents'); app.agents.setLayout('grid') }, icon: icon('layout') },
    { label: 'Agents Window: Toggle Review Panel', run: () => { switchWindow('agents'); app.agents.toggleReview() }, icon: icon('diff') },
    { label: 'View: Toggle Agent Panel', keybinding: 'Ctrl+L', run: () => { switchWindow('editor'); app.editor.toggleAux() }, icon: icon('layout-sidebar-right') },
    { label: 'View: Toggle Terminal', keybinding: 'Ctrl+`', run: () => { switchWindow('editor'); app.editor.togglePanel() }, icon: icon('terminal') },
    { label: 'View: Toggle Primary Side Bar', keybinding: 'Ctrl+B', run: () => { switchWindow('editor'); app.editor.toggleSidebar() }, icon: icon('layout-sidebar-left') },
    { label: 'View: Show Explorer', run: () => { switchWindow('editor'); app.editor.setView('explorer') }, icon: icon('files') },
    { label: 'Source Control: Show', keybinding: 'Ctrl+Shift+G', run: () => { switchWindow('editor'); app.editor.setView('scm') }, icon: icon('source-control') },
    { label: 'Terminal: Create New Terminal', keybinding: 'Ctrl+Shift+`', run: () => { switchWindow('editor'); app.editor.togglePanel(true, 'terminal'); app.editor.terminal.create() }, icon: icon('terminal') },
    { label: 'View: Show Ports / Background Processes', run: () => { switchWindow('editor'); app.editor.togglePanel(true, 'ports') }, icon: icon('radio-tower') },
    { label: 'Browser: Open Integrated Browser', run: () => document.body.dataset.window === 'agents' ? app.agents.openBrowser() : app.editor.openBrowser(), icon: icon('globe') },
    { label: 'Browser: Toggle Design Mode', run: () => { const b = document.body.dataset.window === 'agents' ? (app.agents.openBrowser(), app.agents.browser) : (app.editor.openBrowser(), app.editor.browser); b.toggleDesign() }, icon: icon('inspect') },
    { label: 'Go to Symbol in Workspace…', keybinding: 'Ctrl+T', run: () => goToSymbol(), icon: icon('symbol-method') },
    { label: 'Agents: New Agent in Worktree (isolated)', run: () => { localStorage.setItem('composer.env', 'worktree'); newAgent(); toast('New agents will run in isolated git worktrees') }, icon: icon('git-branch') },
    { label: 'Agents: New Agent Locally', run: () => { localStorage.setItem('composer.env', 'local'); newAgent() }, icon: icon('device-desktop') },
    { label: 'Search: Find in Files', keybinding: 'Ctrl+Shift+F', run: () => { switchWindow('editor'); app.editor.setView('search') }, icon: icon('search') },
    { label: 'Go to File…', keybinding: 'Ctrl+P', run: () => quickOpen(), icon: icon('go-to-file') },
    { label: 'File: New File…', run: () => { switchWindow('editor'); app.editor.setView('explorer'); app.editor.explorer.newFile('') }, icon: icon('new-file') },
    { label: 'File: Save', keybinding: 'Ctrl+S', run: () => app.editor.group.saveActive(), icon: icon('save') },
    { label: 'File: Save All', run: () => files.saveAll(), icon: icon('save-all') },
    inEditor ? { label: 'View: Close All Editors', run: () => app.editor.group.closeAll(), icon: icon('close-all') } : null,
    { label: 'Preferences: Open Settings (Model / API)', keybinding: 'Ctrl+,', run: () => openSettings(), icon: icon('settings-gear') },
  ].filter(Boolean)
}

function commandPalette() { return quickOpen('>') }

async function goToSymbol() {
  const v = await quickPick(() => [], {
    placeholder: 'Type to search symbols in the workspace',
    onChangeValue: async (q, { setItems }) => {
      const syms = await api.get('/api/symbols?q=' + encodeURIComponent(q))
      setItems(syms.map((s) => ({ label: s.name, description: `${s.kind} · ${s.path}:${s.line}`, value: s, icon: icon(s.kind === 'class' ? 'symbol-class' : 'symbol-method') })))
    },
  })
  if (!v) return
  switchWindow('editor')
  app.editor.openFile(v.path, { preview: false, line: v.line })
}

function newAgent() {
  if (document.body.dataset.window === 'agents') app.agents.newAgent()
  else app.editor.newChat()
}

async function pickAgent() {
  const id = await quickPick(agentStore.list.map((a) => ({ label: a.title, description: `${STATUS[a.status]?.label} · ${a.model} · ${timeAgo(a.updatedAt)}`, value: a.id, icon: icon(STATUS[a.status]?.icon || 'circle') })), { placeholder: 'Switch to agent' })
  if (!id) return
  if (document.body.dataset.window === 'agents') app.agents.openAgent(id)
  else app.editor.showAgent(id)
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  const inMonaco = e.target.closest?.('.monaco-editor')
  if (e.shiftKey && k === 'p') { e.preventDefault(); e.stopPropagation(); commandPalette() }
  else if (!e.shiftKey && k === 'p') { e.preventDefault(); e.stopPropagation(); quickOpen() }
  else if (e.shiftKey && k === 'a') { e.preventDefault(); e.stopPropagation(); switchWindow('agents') }
  else if (e.shiftKey && k === 'e') { e.preventDefault(); e.stopPropagation(); switchWindow('editor'); app.editor.setView('explorer') }
  else if (e.shiftKey && k === 'g') { e.preventDefault(); e.stopPropagation(); switchWindow('editor'); app.editor.setView('scm') }
  else if (!e.shiftKey && k === 't' && !inMonaco) { e.preventDefault(); goToSymbol() }
  else if (e.shiftKey && (k === '`' || k === '~')) { e.preventDefault(); switchWindow('editor'); app.editor.togglePanel(true, 'terminal'); app.editor.terminal.create() }
  else if (e.shiftKey && k === 'f') { e.preventDefault(); e.stopPropagation(); switchWindow('editor'); app.editor.setView('search') }
  else if (k === ',') { e.preventDefault(); openSettings() }
  else if (k === '`') { e.preventDefault(); switchWindow('editor'); app.editor.togglePanel() }
  else if (k === 'b' && !inMonaco && document.body.dataset.window === 'editor') { e.preventDefault(); app.editor.toggleSidebar() }
  else if (k === 'l' && !inMonaco && document.body.dataset.window === 'editor') { e.preventDefault(); app.editor.toggleAux() }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newAgent() }
  else if (k === 's' && !inMonaco) { e.preventDefault(); app.editor.group.saveActive() }
  else if (k === 'w' && document.body.dataset.window === 'editor') { e.preventDefault(); const t = app.editor.group.activeTab(); if (t) app.editor.group.closeTab(t.key) }
}

async function openSettings() {
  const s = await api.get('/api/settings')
  const f = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null)
  const baseUrl = h('input', { value: s.baseUrl, spellcheck: 'false' })
  const apiKey = h('input', { value: s.apiKey, type: 'password', placeholder: s.hasApiKey ? '(unchanged)' : 'sk-…', spellcheck: 'false' })
  const models = h('input', { value: s.models.join(', '), spellcheck: 'false' })
  const def = h('input', { value: s.defaultModel, spellcheck: 'false' })
  const steps = h('input', { value: s.maxSteps, type: 'number', min: 1, max: 200 })
  const auto = h('input', { type: 'checkbox', checked: s.autoRunCommands })
  const ctxw = h('input', { value: s.contextWindow || 128000, type: 'number', min: 4000 })
  const wtDef = h('input', { type: 'checkbox', checked: s.defaultEnv === 'worktree' })
  const result = h('div', { class: 'settings-result' })
  const collect = () => ({ baseUrl: baseUrl.value.trim(), apiKey: apiKey.value, models: models.value.split(',').map((x) => x.trim()).filter(Boolean), defaultModel: def.value.trim(), maxSteps: +steps.value || 40, autoRunCommands: auto.checked, contextWindow: +ctxw.value || 128000, defaultEnv: wtDef.checked ? 'worktree' : 'local' })
  const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (e.target === overlay) overlay.remove() } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, icon('settings-gear'), h('span', {}, 'Settings — AI Model'), h('div', { class: 'flex1' }), h('button', { class: 'icon-btn', onclick: () => overlay.remove() }, icon('close'))),
      h('div', { class: 'modal-body' },
        f('Base URL', baseUrl, 'Any OpenAI-compatible endpoint, e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), https://api.deepseek.com/v1. Use "mock" for the built-in offline mock model.'),
        f('API Key', apiKey, 'Stored on the server only; never sent to the browser.'),
        f('Models', models, 'Comma separated list shown in the model picker.'),
        f('Default model', def),
        f('Max agent steps', steps, 'Maximum tool-call iterations per request.'),
        f('Context window (tokens)', ctxw, 'Used for the context meter; older turns are summarized automatically at 80%.'),
        h('label', { class: 'field row' }, wtDef, h('span', {}, 'Run new agents in isolated git worktrees by default (parallel-safe)')),
        h('label', { class: 'field row' }, auto, h('span', {}, 'Auto-run terminal commands (YOLO mode) — otherwise every command needs approval')),
        result),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn-ghost', onclick: async () => { await api.put('/api/settings', collect()); result.textContent = 'Testing…'; const r = await api.post('/api/settings/test'); result.className = 'settings-result ' + (r.ok ? 'ok' : 'bad'); result.textContent = r.ok ? `✓ Connected. Model replied: ${r.reply}` : `✗ ${r.error}` } }, 'Test Connection'),
        h('div', { class: 'flex1' }),
        h('button', { class: 'btn-ghost', onclick: () => overlay.remove() }, 'Cancel'),
        h('button', { class: 'btn-primary', onclick: async () => { agentStore.settings = await api.put('/api/settings', collect()); overlay.remove(); toast('Settings saved'); document.querySelectorAll('.composer').forEach(() => {}); refreshComposers() } }, 'Save'))))
  document.body.append(overlay)
  baseUrl.focus()
}

function refreshComposers() {
  for (const p of app.agents.panes) p.composer.refreshModels()
  app.editor.chat.composer.refreshModels()
}

boot().catch((e) => {
  console.error(e)
  document.getElementById('boot').textContent = 'Failed to start: ' + e.message
})
