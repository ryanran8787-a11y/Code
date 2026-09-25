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
  usage: { prompt: number; completion: number }
  unread?: boolean
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
    todos: a.todos, unread: !!a.unread,
    pendingChanges: changes.filter((c) => c.status === 'pending').length,
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
async function systemPrompt(mode: 'agent' | 'ask') {
  const tree = (await ws.listFilesFlat(300)).join('\n')
  return `You are an autonomous AI coding agent working inside a web IDE (a Cursor-like tool built on VS Code technology).
You operate on the user's workspace through tools. Workspace root: "${path.basename(ws.WORKSPACE_ROOT)}" (all paths are relative to it).

${mode === 'ask' ? 'ASK MODE: you may only read and search files. Do not modify files or run commands; answer the question.' : `Guidelines:
- Work autonomously until the task is fully done. Explore with list_dir / file_search / grep_search, read_file before editing.
- Prefer edit_file with a small unique old_string for existing files; use write_file for new files.
- Use run_terminal_command to run builds/tests or inspect the environment. Never start long-running servers.
- For multi-step tasks keep a todo list with update_todos.
- Make minimal, focused changes that match the existing code style.`}
- When finished, reply with a concise summary (Markdown) of what you did and which files changed.

Current workspace files (truncated):
${tree || '(empty workspace)'}`
}

// ---- lifecycle --------------------------------------------------------------
export function createAgent(opts: { prompt: string; model?: string; mode?: 'agent' | 'ask'; title?: string }) {
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
  }
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

export function deleteAgent(id: string) {
  stopAgent(id)
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
export async function resolveChange(agentId: string, filePath: string | null, accept: boolean) {
  const a = agents.get(agentId); if (!a) throw new Error('Agent not found')
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

export async function changeDetails(agentId: string) {
  const a = agents.get(agentId); if (!a) throw new Error('Agent not found')
  const out: any[] = []
  for (const c of Object.values(a.changes)) {
    let current: string | null = null
    try { current = await ws.readFile(c.path) } catch { current = null }
    out.push({ ...c, current })
  }
  return out
}

// ---- the loop ---------------------------------------------------------------
function client() {
  const s = getSettings()
  let baseURL = s.baseUrl
  if (baseURL.startsWith('mock')) baseURL = `http://127.0.0.1:${process.env.PORT || 3000}/mock/v1`
  return new OpenAI({ apiKey: s.apiKey || 'none', baseURL, timeout: 180_000, maxRetries: 1 })
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

const MUTATING = new Set(['edit_file', 'write_file', 'delete_file', 'run_terminal_command'])

async function run(a: Agent) {
  const ctrl = new AbortController()
  controllers.set(a.id, ctrl)
  setStatus(a, 'running')
  const settings = getSettings()
  try {
    for (let step = 0; step < settings.maxSteps; step++) {
      if (ctrl.signal.aborted) return
      const tools = a.mode === 'ask' ? TOOL_SCHEMAS.filter((t) => !MUTATING.has(t.function.name)) : TOOL_SCHEMAS
      const messages = [{ role: 'system', content: await systemPrompt(a.mode) }, ...sanitize(a.messages)]
      const body: any = { model: a.model, messages, tools, stream: true, stream_options: { include_usage: true } }
      if (settings.temperature !== null && settings.temperature !== undefined) body.temperature = settings.temperature

      const stream: any = await client().chat.completions.create(body, { signal: ctrl.signal })
      const textItem: TimelineItem = { id: uid(), type: 'assistant', text: '', ts: Date.now(), streaming: true }
      let textPushed = false
      let reasoning = ''
      const calls: { id: string; name: string; args: string }[] = []
      for await (const chunk of stream) {
        if (chunk.usage) { a.usage.prompt += chunk.usage.prompt_tokens || 0; a.usage.completion += chunk.usage.completion_tokens || 0 }
        const d = chunk.choices?.[0]?.delta
        if (!d) continue
        const r = d.reasoning_content || d.reasoning
        if (typeof r === 'string') reasoning += r
        if (d.content) {
          ;(textItem as any).text += d.content
          if (!textPushed) { pushItem(a, textItem); textPushed = true }
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
        if (c.name === 'run_terminal_command' && !getSettings().autoRunCommands) {
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

        let outBuf = ''
        let flush: NodeJS.Timeout | null = null
        try {
          const r = await executeTool(c.name, args, {
            agentId: a.id,
            signal: ctrl.signal,
            snapshot: async (p) => {
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
          if (r.meta?.path && a.changes[r.meta.path]) publish({ kind: 'agent.changes', agentId: a.id })
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
