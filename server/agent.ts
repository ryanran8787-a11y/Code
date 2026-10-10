// Agent runtime: an autonomous tool-calling loop against any OpenAI-compatible
// chat.completions endpoint. Many agents can run concurrently; every state
// change is broadcast on the event bus so all windows stay in sync.
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import { publish } from './events'
import { getSettings, DATA_DIR } from './settings'
import { TOOL_SCHEMAS, executeTool } from './tools'
import * as ws from './workspace'
import * as git from './git'
import * as procs from './processes'
import { shellLabel, isWindows } from './shell'
import { decideApproval, compileList, isRetryable, isFatal, backoffMs, sleep } from './policy'

export type AgentStatus = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'stopped'

export type TimelineItem =
  | { id: string; type: 'user'; text: string; ts: number }
  | { id: string; type: 'assistant'; text: string; ts: number; streaming?: boolean }
  | { id: string; type: 'reasoning'; text: string; ts: number }
  | {
      id: string
      type: 'tool'
      name: string
      args: any
      status: 'pending_approval' | 'running' | 'done' | 'error' | 'rejected'
      result?: string
      output?: string
      meta?: any
      ts: number
    }
  | { id: string; type: 'error'; text: string; ts: number }

export type FileChange = { path: string; original: string | null; status: 'pending' | 'accepted' | 'rejected' }

export type Agent = {
  id: string
  title: string
  model: string
  mode: 'agent' | 'ask'
  status: AgentStatus
  createdAt: number
  updatedAt: number
  messages: any[]
  timeline: TimelineItem[]
  changes: Record<string, FileChange>
  todos: { content: string; status: string }[]
  usage: { prompt: number; completion: number; lastPrompt?: number }
  unread?: boolean
  /** 'local' edits the main workspace directly; 'worktree' works in an isolated git worktree */
  env: 'local' | 'worktree'
  worktree?: git.WorktreeInfo
  /** how many leading messages have been folded into `summary` */
  compacted?: number
  summary?: string
}

export function agentWorkspace(a: Agent): ws.Workspace {
  return a.env === 'worktree' && a.worktree ? git.worktreeWorkspace(a.worktree) : ws.main
}

const AGENT_DIR = path.join(DATA_DIR, 'agents')
fs.mkdirSync(AGENT_DIR, { recursive: true })

const agents = new Map<string, Agent>()
const controllers = new Map<string, AbortController>()
const approvals = new Map<string, (ok: boolean) => void>()

// ---- persistence -----------------------------------------------------------
for (const f of fs.readdirSync(AGENT_DIR)) {
  if (!f.endsWith('.json')) continue
  try {
    const a: Agent = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, f), 'utf8'))
    if (a.status === 'running' || a.status === 'awaiting_approval') a.status = 'stopped'
    if (!a.env) a.env = 'local'
    agents.set(a.id, a)
  } catch { /* ignore corrupt */ }
}
const saveTimers = new Map<string, NodeJS.Timeout>()
function save(a: Agent, immediate = false) {
  const write = () => { saveTimers.delete(a.id); fs.writeFile(path.join(AGENT_DIR, a.id + '.json'), JSON.stringify(a), () => {}) }
  if (immediate) return write()
  if (!saveTimers.has(a.id)) saveTimers.set(a.id, setTimeout(write, 400))
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export function summary(a: Agent) {
  const changes = Object.values(a.changes)
  return {
    id: a.id, title: a.title, model: a.model, mode: a.mode, status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt,
    env: a.env, branch: a.worktree?.branch, usage: a.usage, contextTokens: a.usage.lastPrompt || 0, contextWindow: getSettings().contextWindow,
    todos: a.todos, unread: !!a.unread,
    pendingChanges: a.env === 'worktree' ? (a as any)._wtPending ?? 0 : changes.filter((c) => c.status === 'pending').length,
    lastMessage: [...a.timeline].reverse().find((t) => t.type === 'assistant' || t.type === 'user')?.['text']?.slice(0, 140) || '',
  }
}

export function listAgents() {
  return [...agents.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary)
}
export function getAgent(id: string) { return agents.get(id) }

function touch(a: Agent) {
  a.updatedAt = Date.now()
  publish({ kind: 'agent.summary', agent: summary(a) })
  save(a)
}
function setStatus(a: Agent, s: AgentStatus) {
  a.status = s
  if (s === 'done' || s === 'error') a.unread = true
  touch(a)
}
function pushItem(a: Agent, item: TimelineItem) {
  a.timeline.push(item)
  publish({ kind: 'agent.item', agentId: a.id, item })
  touch(a)
}
function updateItem(a: Agent, item: TimelineItem) {
  publish({ kind: 'agent.item', agentId: a.id, item })
  save(a)
}

// ---- system prompt ----------------------------------------------------------
async function systemPrompt(a: Agent) {
  const mode = a.mode
  const w = agentWorkspace(a)
  const tree = (await w.listFilesFlat(300)).join('\n')
  const bg = procs.list().filter((p) => p.status === 'running')
  return `You are an autonomous AI coding agent working inside a web IDE (a Cursor-like tool built on VS Code technology).
You operate on the user's workspace through tools. Workspace root: "${path.basename(ws.WORKSPACE_ROOT)}" (all paths are relative to it). Host OS: ${process.platform}; shell: ${shellLabel()}.${a.env === 'worktree' ? `
You are running in an ISOLATED GIT WORKTREE on branch "${a.worktree?.branch}". Other agents may work in parallel in their own worktrees; your changes are reviewed and merged by the user.` : ''}${isWindows ? `
Windows shell notes: chain commands with \`;\` (not \`&&\`); prefer \`node --version; npm test\` style; avoid bash-only syntax (\`ls -la\`, \`cat\`, \`grep\`) — use PowerShell equivalents (\`Get-ChildItem\`, \`Get-Content\`).` : ''}
Terminal / background commands: denied patterns (${(getSettings().commandDenylist || []).join(' | ') || 'none'}) are blocked outright. These run without asking: (${(getSettings().commandAllowlist || []).join(' | ') || 'none'})${getSettings().autoRunCommands ? ' — plus auto-run is ON, so everything else runs too' : ' — anything else needs the user\'s approval in the UI, so batch reads before writes and avoid surprise long-running commands'}.

${mode === 'ask' ? 'ASK MODE: you may only read and search files. Do not modify files or run commands; answer the question.' : `Guidelines:
- Work autonomously until the task is fully done. Explore with list_dir / file_search / grep_search, read_file before editing.
- Prefer edit_file with a small unique old_string for existing files; use write_file for new files.
- Use run_terminal_command for short commands (builds, tests). For dev servers / watchers use start_background_process, then verify pages or APIs with fetch_url (e.g. http://localhost:PORT/) and stop_process when done.
- For multi-step tasks keep a todo list with update_todos.
- Make minimal, focused changes that match the existing code style.`}
- When finished, reply with a concise summary (Markdown) of what you did and which files changed.

${bg.length ? `\nRunning background processes:\n${bg.map((p) => `- ${p.id}: ${p.command} (ports: ${p.ports.join(',') || '?'})`).join('\n')}\n` : ''}
Current workspace files (truncated):
${tree || '(empty workspace)'}${a.summary ? `\n\n## Summary of earlier conversation (older messages were compacted)\n${a.summary}` : ''}`
}

// ---- lifecycle --------------------------------------------------------------
export async function createAgent(opts: { prompt: string; model?: string; mode?: 'agent' | 'ask'; title?: string; env?: 'local' | 'worktree' }) {
  const s = getSettings()
  const a: Agent = {
    id: uid(),
    title: opts.title || opts.prompt.split('\n')[0].slice(0, 60) || 'New Agent',
    model: opts.model || s.defaultModel,
    mode: opts.mode || 'agent',
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    timeline: [],
    changes: {},
    todos: [],
    usage: { prompt: 0, completion: 0 },
    env: opts.env === 'worktree' ? 'worktree' : 'local',
  }
  if (a.env === 'worktree') a.worktree = await git.createWorktree(a.id, a.title)
  agents.set(a.id, a)
  publish({ kind: 'agent.created', agent: summary(a) })
  sendMessage(a.id, opts.prompt)
  return a
}

export function sendMessage(id: string, text: string, model?: string, mode?: 'agent' | 'ask') {
  const a = agents.get(id)
  if (!a) throw new Error('Agent not found')
  if (a.status === 'running' || a.status === 'awaiting_approval') throw new Error('Agent is busy')
  if (model) a.model = model
  if (mode) a.mode = mode
  a.messages.push({ role: 'user', content: text })
  pushItem(a, { id: uid(), type: 'user', text, ts: Date.now() })
  run(a).catch((e) => console.error('agent crashed', e))
  return a
}

export function stopAgent(id: string) {
  const a = agents.get(id)
  if (!a) return
  controllers.get(id)?.abort()
  for (const [k, fn] of approvals) if (k.startsWith(id + ':')) fn(false)
  if (a.status === 'running' || a.status === 'awaiting_approval') setStatus(a, 'stopped')
}

export async function deleteAgent(id: string) {
  stopAgent(id)
  const a = agents.get(id)
  for (const p of procs.list()) if (p.owner === id && p.status === 'running') procs.stop(p.id)
  if (a?.worktree) await git.removeWorktree(a.worktree).catch(() => {})
  agents.delete(id)
  fs.rm(path.join(AGENT_DIR, id + '.json'), { force: true }, () => {})
  publish({ kind: 'agent.deleted', agentId: id })
}

export function renameAgent(id: string, title: string) {
  const a = agents.get(id); if (!a) return
  a.title = title; touch(a)
}

export function markRead(id: string) {
  const a = agents.get(id); if (!a || !a.unread) return
  a.unread = false; touch(a)
}

export function approveTool(agentId: string, toolId: string, ok: boolean) {
  const fn = approvals.get(`${agentId}:${toolId}`)
  if (fn) fn(ok)
}

// ---- change review (Keep / Undo) --------------------------------------------
export async function resolveChange(agentId: string, filePath: string | null, accept: boolean, force = false) {
  const a = agents.get(agentId); if (!a) throw new Error('Agent not found')
  if (a.env === 'worktree' && a.worktree) {
    const files = filePath === null ? undefined : [filePath]
    let result: any = {}
    if (accept) result = await git.applyWorktree(a.worktree, files, { writeConflicts: force })
    else await git.revertWorktree(a.worktree, files)
    // record decisions so the UI can show accepted / rejected state
    for (const c of (await git.worktreeChanges(a.worktree)).filter((c) => !files || files.includes(c.path))) {
      if (!accept || result.applied?.includes(c.path)) a.changes[c.path] = { path: c.path, original: null, status: accept ? 'accepted' : 'rejected' }
    }
    if (!accept) for (const f of files || Object.keys(a.changes)) if (a.changes[f]?.status === 'pending') a.changes[f].status = 'rejected'
    await refreshWtPending(a)
    touch(a)
    publish({ kind: 'agent.changes', agentId: a.id })
    if (result.conflicts?.length) throw Object.assign(new Error(force ? `Merged with conflict markers in: ${result.conflicts.join(', ')} — resolve them in the editor` : `Conflicts with your workspace edits in: ${result.conflicts.join(', ')}`), { conflicts: result.conflicts })
    return a.changes
  }
  const targets = Object.values(a.changes).filter((c) => c.status === 'pending' && (filePath === null || c.path === filePath))
  for (const c of targets) {
    if (!accept) {
      if (c.original === null) await ws.deletePath(c.path, `agent:${a.id}`).catch(() => {})
      else await ws.writeFile(c.path, c.original, `agent:${a.id}`)
    }
    c.status = accept ? 'accepted' : 'rejected'
  }
  touch(a)
  publish({ kind: 'agent.changes', agentId: a.id })
  return a.changes
}

async function refreshWtPending(a: Agent) {
  if (!a.worktree) return
  const ch = await git.worktreeChanges(a.worktree)
  let n = 0
  for (const c of ch) {
    const mainContent = await ws.main.readFile(c.path).catch(() => null)
    const wtContent = await agentWorkspace(a).readFile(c.path).catch(() => null)
    if (mainContent !== wtContent) n++
  }
  ;(a as any)._wtPending = n
}

export async function changeDetails(agentId: string) {
  const a = agents.get(agentId); if (!a) throw new Error('Agent not found')
  const out: any[] = []
  if (a.env === 'worktree' && a.worktree) {
    const w = agentWorkspace(a)
    for (const c of await git.worktreeChanges(a.worktree)) {
      const original = await git.showFile(c.path, a.worktree.base, a.worktree.dir)
      const current = await w.readFile(c.path).catch(() => null)
      const mainContent = await ws.main.readFile(c.path).catch(() => null)
      // pending = the main workspace doesn't have this version yet
      const status = mainContent === current ? 'accepted' : (a.changes[c.path]?.status === 'rejected' && original === current ? 'rejected' : 'pending')
      out.push({ path: c.path, original, current, status, worktree: true })
    }
    for (const c of Object.values(a.changes)) if (!out.find((o) => o.path === c.path) && c.status === 'rejected') out.push({ ...c, current: c.original, worktree: true })
    return out
  }
  for (const c of Object.values(a.changes)) {
    let current: string | null = null
    try { current = await ws.readFile(c.path) } catch { current = null }
    out.push({ ...c, current })
  }
  return out
}

// ---- the loop ---------------------------------------------------------------
export function client() {
  const s = getSettings()
  let baseURL = s.baseUrl
  if (baseURL.startsWith('mock')) baseURL = `http://127.0.0.1:${process.env.PORT || 3000}/mock/v1`
  return new OpenAI({ apiKey: s.apiKey || 'none', baseURL, timeout: 180_000, maxRetries: 1 })
}

export function estimateTokens(msgs: any[]) {
  let chars = 0
  for (const m of msgs) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.ceil(chars / 3.6)
}

/**
 * Context compaction: when the conversation approaches the context window, fold
 * the oldest messages into a running summary (written by the model itself),
 * keeping the most recent turns verbatim. Cuts only at user-message boundaries
 * so tool_call / tool pairs are never split.
 */
async function maybeCompact(a: Agent, signal: AbortSignal, force = false) {
  const s = getSettings()
  const live = a.messages.slice(a.compacted || 0)
  const est = Math.max(estimateTokens(live), a.usage.lastPrompt || 0)
  if (!force && est < s.contextWindow * s.compactAt) return false
  // keep the last ~35% of the budget verbatim, cut at a user message
  const keepBudget = s.contextWindow * 0.35
  let keepFrom = live.length
  let acc = 0
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateTokens([live[i]])
    if (acc > keepBudget) break
    if (live[i].role === 'user') keepFrom = i
  }
  if (keepFrom <= 1 && !force) {
    // can't cut on a user boundary: trim huge tool outputs instead
    for (const m of live) if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 4000) m.content = m.content.slice(0, 1500) + '\n…[output trimmed during context compaction]…\n' + m.content.slice(-1500)
    return true
  }
  if (keepFrom === 0) keepFrom = live.length
  const toFold = live.slice(0, keepFrom)
  if (!toFold.length) return false
  const transcript = toFold.map((m) => {
    if (m.role === 'tool') return `[tool result] ${String(m.content).slice(0, 1500)}`
    if (m.tool_calls) return `[assistant] ${m.content || ''}\n[tool calls] ${m.tool_calls.map((t: any) => `${t.function.name}(${t.function.arguments.slice(0, 300)})`).join('; ')}`
    return `[${m.role}] ${String(m.content).slice(0, 4000)}`
  }).join('\n')
  let summary = ''
  try {
    const r: any = await client().chat.completions.create({
      model: a.model,
      messages: [
        { role: 'system', content: 'You compress coding-agent conversations. Write a dense Markdown summary preserving: the user goals and constraints, decisions made, files read/changed (with key details), commands run and their results, open problems and next steps. Max 400 words.' },
        { role: 'user', content: (a.summary ? `Previous summary:\n${a.summary}\n\n` : '') + `Conversation to summarize:\n${transcript.slice(0, 60000)}` },
      ],
    }, { signal })
    summary = r.choices?.[0]?.message?.content || ''
  } catch { /* fall through to mechanical summary */ }
  if (!summary.trim()) summary = (a.summary ? a.summary + '\n' : '') + toFold.filter((m) => m.role === 'user').map((m) => `- User asked: ${String(m.content).slice(0, 200)}`).join('\n')
  a.summary = summary.trim()
  a.compacted = (a.compacted || 0) + keepFrom
  a.usage.lastPrompt = estimateTokens(a.messages.slice(a.compacted))
  pushItem(a, { id: uid(), type: 'reasoning', text: `Context compacted: ${toFold.length} earlier messages were summarized to stay within the context window.\n\n${a.summary}`, ts: Date.now() })
  return true
}

export async function compactAgent(id: string) {
  const a = agents.get(id); if (!a) throw new Error('Agent not found')
  if (a.status === 'running') throw new Error('Agent is busy')
  await maybeCompact(a, new AbortController().signal, true)
  touch(a)
  return summary(a)
}

/** Every assistant tool_call must be followed by a tool message; patch holes left by stops/crashes. */
function sanitize(msgs: any[]) {
  const out: any[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    out.push(m)
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set<string>()
      let j = i + 1
      while (j < msgs.length && msgs[j].role === 'tool') { answered.add(msgs[j].tool_call_id); out.push(msgs[j]); j++ }
      for (const tc of m.tool_calls) if (!answered.has(tc.id)) out.push({ role: 'tool', tool_call_id: tc.id, content: 'Cancelled by user.' })
      i = j - 1
    }
  }
  return out
}

const MUTATING = new Set(['edit_file', 'write_file', 'delete_file', 'run_terminal_command', 'start_background_process', 'stop_process'])

/**
 * Model request with retry + fallback: per model, retry retryable errors
 * (429/5xx/timeout) with exponential backoff; then move to the next model
 * in [primary, ...fallbackModels]. 400s get one compat retry without
 * stream_options/temperature (some servers reject those fields).
 */
async function requestWithFallback(body: any, a: Agent, signal: AbortSignal) {
  const s = getSettings()
  const models = [a.model, ...(s.fallbackModels || []).filter((m) => m && m !== a.model)]
  let lastErr: any = null
  for (const model of models) {
    const attempts = 1 + Math.max(0, s.retryBudget ?? 0)
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await client().chat.completions.create({ ...body, model }, { signal })
        if (model !== a.model) {
          a.model = model
          pushItem(a, { id: uid(), type: 'reasoning', text: `Primary model failed; continuing with fallback model \`${model}\`.`, ts: Date.now() })
        }
        return r
      } catch (e: any) {
        if (signal.aborted) throw e
        if (e?.status === 400) {
          try {
            const slim = { ...body, model }
            delete slim.stream_options
            delete slim.temperature
            return await client().chat.completions.create(slim, { signal })
          } catch (e2) {
            lastErr = e2
            break // next model (400 is fatal for this one)
          }
        }
        if (!isRetryable(e) || isFatal(e)) throw e
        lastErr = e
        if (i < attempts - 1) {
          try {
            await sleep(backoffMs(i), signal)
          } catch {
            throw e
          }
        }
      }
    }
  }
  throw lastErr
}

async function run(a: Agent) {
  const ctrl = new AbortController()
  controllers.set(a.id, ctrl)
  setStatus(a, 'running')
  const settings = getSettings()
  try {
    for (let step = 0; step < settings.maxSteps; step++) {
      if (ctrl.signal.aborted) return
      const tools = a.mode === 'ask' ? TOOL_SCHEMAS.filter((t) => !MUTATING.has(t.function.name)) : TOOL_SCHEMAS
      await maybeCompact(a, ctrl.signal)
      const messages = [{ role: 'system', content: await systemPrompt(a) }, ...sanitize(a.messages.slice(a.compacted || 0))]
      const body: any = { model: a.model, messages, tools, stream: true, stream_options: { include_usage: true } }
      if (settings.temperature !== null && settings.temperature !== undefined) body.temperature = settings.temperature

      let stream: any = await requestWithFallback(body, a, ctrl.signal)
      const textItem: TimelineItem = { id: uid(), type: 'assistant', text: '', ts: Date.now(), streaming: true }
      let textPushed = false
      let reasoning = ''
      const calls: { id: string; name: string; args: string }[] = []
      for await (const chunk of stream) {
        if (chunk.usage) { a.usage.prompt += chunk.usage.prompt_tokens || 0; a.usage.completion += chunk.usage.completion_tokens || 0; a.usage.lastPrompt = chunk.usage.prompt_tokens || a.usage.lastPrompt }
        const d = chunk.choices?.[0]?.delta
        if (!d) continue
        const r = d.reasoning_content || d.reasoning
        if (typeof r === 'string') reasoning += r
        if (d.content) {
          if (!textPushed) { pushItem(a, { ...textItem } as TimelineItem); a.timeline[a.timeline.length - 1] = textItem; textPushed = true }
          ;(textItem as any).text += d.content
          publish({ kind: 'agent.delta', agentId: a.id, itemId: textItem.id, delta: d.content })
        }
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? calls.length
          if (!calls[idx]) calls[idx] = { id: tc.id || uid(), name: '', args: '' }
          if (tc.id) calls[idx].id = tc.id
          if (tc.function?.name) calls[idx].name += tc.function.name
          if (tc.function?.arguments) calls[idx].args += tc.function.arguments
        }
      }
      if (reasoning.trim()) {
        const ri: TimelineItem = { id: uid(), type: 'reasoning', text: reasoning, ts: Date.now() }
        // put reasoning before the text
        if (textPushed) a.timeline.splice(a.timeline.length - 1, 0, ri); else a.timeline.push(ri)
        publish({ kind: 'agent.item', agentId: a.id, item: ri, before: textPushed ? textItem.id : undefined })
      }
      if (textPushed) { delete (textItem as any).streaming; updateItem(a, textItem) }
      if (!a.usage.lastPrompt || a.usage.lastPrompt < 1) a.usage.lastPrompt = estimateTokens(messages)

      const assistantMsg: any = { role: 'assistant', content: (textItem as any).text || null }
      const validCalls = calls.filter(Boolean)
      if (validCalls.length) assistantMsg.tool_calls = validCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
      a.messages.push(assistantMsg)

      if (!validCalls.length) { setStatus(a, 'done'); return }

      for (const c of validCalls) {
        if (ctrl.signal.aborted) return
        let args: any = {}
        try { args = c.args ? JSON.parse(c.args) : {} } catch { args = { _raw: c.args } }
        const item: any = { id: c.id, type: 'tool', name: c.name, args, status: 'running', ts: Date.now() }
        let result: string
        if (c.name === 'run_terminal_command' || c.name === 'start_background_process') {
          const st = getSettings()
          const decision = decideApproval(String(args.command || ''), {
            autoRun: st.autoRunCommands,
            allow: compileList(st.commandAllowlist),
            deny: compileList(st.commandDenylist),
          })
          if (decision === 'deny') {
            item.status = 'rejected'
            item.result = 'Blocked by the workspace command denylist.'
            pushItem(a, item)
            a.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Blocked by the workspace command denylist. Do not retry this command; continue without it or ask the user.' })
            continue
          }
          if (decision === 'ask') {
            item.status = 'pending_approval'
            pushItem(a, item)
            setStatus(a, 'awaiting_approval')
            const ok = await new Promise<boolean>((res) => approvals.set(`${a.id}:${c.id}`, res))
            approvals.delete(`${a.id}:${c.id}`)
            if (ctrl.signal.aborted) { item.status = 'rejected'; updateItem(a, item); return }
            setStatus(a, 'running')
            if (!ok) {
              item.status = 'rejected'
              updateItem(a, item)
              a.messages.push({ role: 'tool', tool_call_id: c.id, content: 'The user rejected running this command. Do not retry it; continue without it or ask the user.' })
              continue
            }
            item.status = 'running'
            updateItem(a, item)
          } else pushItem(a, item)
        } else pushItem(a, item)

        let outBuf = ''
        let flush: NodeJS.Timeout | null = null
        try {
          const r = await executeTool(c.name, args, {
            agentId: a.id,
            ws: agentWorkspace(a),
            signal: ctrl.signal,
            snapshot: async (p) => {
              if (a.env === 'worktree') return // tracked via git in the worktree
              if (a.changes[p] && a.changes[p].status === 'pending') return
              let original: string | null = null
              try { original = await ws.readFile(p) } catch { original = null }
              a.changes[p] = { path: p, original, status: 'pending' }
            },
            onOutput: (chunk) => {
              outBuf += chunk
              if (!flush) flush = setTimeout(() => { flush = null; item.output = outBuf.slice(-20000); updateItem(a, item) }, 150)
            },
            setTodos: (t) => { a.todos = t; touch(a) },
          })
          if (flush) clearTimeout(flush)
          result = r.result
          item.status = 'done'
          item.result = r.result.slice(0, 20000)
          item.meta = r.meta
          if (outBuf) item.output = outBuf.slice(-20000)
          if (r.meta?.path && (a.changes[r.meta.path] || a.env === 'worktree')) { if (a.env === 'worktree') await refreshWtPending(a); publish({ kind: 'agent.changes', agentId: a.id }) }
        } catch (e: any) {
          result = `Error: ${e?.message || e}`
          item.status = 'error'
          item.result = result
        }
        updateItem(a, item)
        a.messages.push({ role: 'tool', tool_call_id: c.id, content: result })
      }
      touch(a)
    }
    pushItem(a, { id: uid(), type: 'error', text: `Stopped after reaching the step limit (${settings.maxSteps}).`, ts: Date.now() })
    setStatus(a, 'done')
  } catch (e: any) {
    if (ctrl.signal.aborted) { setStatus(a, 'stopped'); return }
    const msg = e?.error?.message || e?.message || String(e)
    pushItem(a, { id: uid(), type: 'error', text: `Model request failed: ${msg}`, ts: Date.now() })
    // keep history valid: drop a trailing assistant message with unanswered tool calls
    const last = a.messages[a.messages.length - 1]
    if (last?.role === 'assistant' && last.tool_calls) a.messages.pop()
    setStatus(a, 'error')
  } finally {
    controllers.delete(a.id)
    save(a, true)
  }
}

// ---- worktree actions -------------------------------------------------------
export async function worktreeAction(id: string, action: 'commit' | 'discard' | 'merge', message?: string) {
  const a = agents.get(id); if (!a || !a.worktree) throw new Error('Agent has no worktree')
  if (action === 'commit') await git.commitWorktree(a.worktree, message || `Agent: ${a.title}`)
  else if (action === 'merge') await resolveChange(id, null, true)
  else if (action === 'discard') await resolveChange(id, null, false)
  touch(a)
  return summary(a)
}
