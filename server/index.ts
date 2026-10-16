import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'
import { logger } from 'hono/logger'
import * as ws from './workspace'
import * as agents from './agent'
import { subscribe } from './events'
import { getSettings, publicSettings, updateSettings } from './settings'
import { getTheme } from './theme'
import { mock } from './mock'
import OpenAI from 'openai'
import path from 'node:path'
import * as git from './git'
import * as procs from './processes'
import * as pty from './pty'
import { proxy } from './browser'
import { workspaceSymbols } from './symbols'
import { tabComplete, inlineEdit } from './complete'
import { searchCodebase } from './codebase'
const app = new Hono()
if (process.env.LOG) app.use('*', logger())

app.onError((err, c) => {
  const status = err instanceof ws.PathError ? 400 : (err as any).code === 'ENOENT' ? 404 : 500
  return c.json({ error: err.message }, status)
})

// Optional protection: set ACCESS_TOKEN to require ?token=... once (stored in a cookie).
const ACCESS_TOKEN = process.env.ACCESS_TOKEN
if (ACCESS_TOKEN) {
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/mock/')) return next()
    const q = c.req.query('token')
    const cookie = /(?:^|;\s*)cw_token=([^;]+)/.exec(c.req.header('cookie') || '')?.[1]
    if (q === ACCESS_TOKEN) { c.header('Set-Cookie', `cw_token=${ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax`); return next() }
    if (cookie === ACCESS_TOKEN) return next()
    return c.text('Unauthorized — open this URL with ?token=<ACCESS_TOKEN>', 401)
  })
}

app.route('/mock', mock)

// ---------- workspace / files ----------
app.get('/api/workspace', (c) => c.json({ root: ws.WORKSPACE_ROOT, name: path.basename(ws.WORKSPACE_ROOT) }))
app.get('/api/tree', async (c) => c.json(await ws.readTree(c.req.query('path') || '')))
app.get('/api/files', async (c) => c.json(await ws.listFilesFlat()))
app.get('/api/file', async (c) => c.json({ path: c.req.query('path'), content: await ws.readFile(c.req.query('path') || '') }))
app.put('/api/file', async (c) => {
  const { path: p, content } = await c.req.json()
  await ws.writeFile(p, content ?? '', 'user')
  return c.json({ ok: true })
})
app.post('/api/fs/mkdir', async (c) => { await ws.makeDir((await c.req.json()).path); return c.json({ ok: true }) })
app.post('/api/fs/delete', async (c) => { await ws.deletePath((await c.req.json()).path); return c.json({ ok: true }) })
app.post('/api/fs/rename', async (c) => { const { from, to } = await c.req.json(); await ws.renamePath(from, to); return c.json({ ok: true }) })
app.get('/api/search', async (c) => {
  const q = c.req.query('q') || ''
  return c.json(await ws.searchText(q, { regex: c.req.query('regex') === '1', caseSensitive: c.req.query('case') === '1', include: c.req.query('include') || undefined }))
})
app.get('/api/search-backend', (c) => c.json({ backend: ws.searchBackend() }))

// ---------- terminal (non-interactive, streamed) ----------
app.post('/api/terminal/run', async (c) => {
  const { command, cwd } = await c.req.json()
  return streamSSE(c, async (s) => {
    const ctrl = new AbortController()
    s.onAbort(() => ctrl.abort())
    const r = await ws.runCommand(command, { cwd, timeoutMs: 120_000, signal: ctrl.signal, onData: (d) => { s.writeSSE({ event: 'data', data: JSON.stringify(d) }) } })
    await s.writeSSE({ event: 'exit', data: JSON.stringify({ code: r.exitCode, timedOut: r.timedOut }) })
  })
})

// ---------- settings / theme ----------
app.get('/api/settings', (c) => c.json(publicSettings()))
app.put('/api/settings', async (c) => c.json(updateSettings(await c.req.json())))
app.post('/api/settings/test', async (c) => {
  const s = getSettings()
  const baseURL = s.baseUrl.startsWith('mock') ? `http://127.0.0.1:${PORT}/mock/v1` : s.baseUrl
  try {
    const r = await new OpenAI({ apiKey: s.apiKey || 'none', baseURL, timeout: 60_000 }).chat.completions.create({
      model: s.defaultModel, messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    })
    return c.json({ ok: true, reply: r.choices[0]?.message?.content })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.error?.message || e?.message || String(e) })
  }
})
app.get('/api/theme', (c) => c.json(getTheme()))

// ---------- agents ----------
app.get('/api/agents', (c) => c.json(agents.listAgents()))
app.post('/api/agents', async (c) => {
  const b = await c.req.json()
  if (!b.prompt?.trim()) return c.json({ error: 'prompt required' }, 400)
  const a = await agents.createAgent({ prompt: b.prompt, model: b.model, mode: b.mode, env: b.env || getSettings().defaultEnv })
  return c.json(agents.summary(a))
})
app.get('/api/agents/:id', (c) => {
  const a = agents.getAgent(c.req.param('id'))
  if (!a) return c.json({ error: 'not found' }, 404)
  return c.json({ ...agents.summary(a), timeline: a.timeline, changes: a.changes, usage: a.usage })
})
app.post('/api/agents/:id/messages', async (c) => {
  const b = await c.req.json()
  const a = agents.sendMessage(c.req.param('id'), b.text, b.model, b.mode)
  return c.json(agents.summary(a))
})
app.post('/api/agents/:id/stop', (c) => { agents.stopAgent(c.req.param('id')); return c.json({ ok: true }) })
app.post('/api/agents/:id/read', (c) => { agents.markRead(c.req.param('id')); return c.json({ ok: true }) })
app.patch('/api/agents/:id', async (c) => { agents.renameAgent(c.req.param('id'), (await c.req.json()).title); return c.json({ ok: true }) })
app.delete('/api/agents/:id', async (c) => { await agents.deleteAgent(c.req.param('id')); return c.json({ ok: true }) })
app.post('/api/agents/:id/compact', async (c) => c.json(await agents.compactAgent(c.req.param('id'))))
app.post('/api/agents/:id/worktree/:action', async (c) => {
  const action = c.req.param('action') as any
  if (!['commit', 'merge', 'discard'].includes(action)) return c.json({ error: 'bad action' }, 400)
  const b = await c.req.json().catch(() => ({}))
  return c.json(await agents.worktreeAction(c.req.param('id'), action, b.message))
})
// Read files from an agent's worktree (for browsing isolated changes)
app.get('/api/agents/:id/tree', async (c) => {
  const a = agents.getAgent(c.req.param('id')); if (!a) return c.json({ error: 'not found' }, 404)
  return c.json(await agents.agentWorkspace(a).readTree(''))
})

// ---------- source control ----------
app.get('/api/git/status', async (c) => c.json(await git.status()))
app.post('/api/git/init', async (c) => { await git.ensureRepo(); return c.json(await git.status()) })
app.get('/api/git/show', async (c) => c.json({ content: await git.showFile(c.req.query('path') || '', c.req.query('ref') || 'HEAD') }))
app.post('/api/git/stage', async (c) => { await git.stage((await c.req.json()).paths); return c.json({ ok: true }) })
app.post('/api/git/unstage', async (c) => { await git.unstage((await c.req.json()).paths); return c.json({ ok: true }) })
app.post('/api/git/discard', async (c) => { await git.discard((await c.req.json()).paths); return c.json({ ok: true }) })
app.post('/api/git/commit', async (c) => { const b = await c.req.json(); return c.json({ output: await git.commit(b.message, !!b.all) }) })
app.get('/api/git/branches', async (c) => c.json(await git.branches()))
app.post('/api/git/checkout', async (c) => { const b = await c.req.json(); await git.checkout(b.branch, !!b.create); return c.json({ ok: true }) })

// ---------- background processes ----------
app.get('/api/processes', (c) => c.json(procs.list()))
app.post('/api/processes', async (c) => { const b = await c.req.json(); const p = procs.start(b.command, ws.resolvePath(b.cwd || ''), 'user'); return c.json({ id: p.id }) })
app.get('/api/processes/:id', (c) => { const p = procs.get(c.req.param('id')); return p ? c.json({ id: p.id, status: p.status, ports: p.ports, output: p.output }) : c.json({ error: 'not found' }, 404) })
app.post('/api/processes/:id/stop', (c) => c.json(procs.stop(c.req.param('id'))))
app.delete('/api/processes/:id', (c) => { procs.remove(c.req.param('id')); return c.json({ ok: true }) })

// ---------- interactive terminals ----------
app.get('/api/terminals', (c) => c.json(pty.listTerminals()))
app.post('/api/terminals', async (c) => { const b = await c.req.json().catch(() => ({})); return c.json(pty.createTerminal(ws.resolvePath(b.cwd || ''), b.cols, b.rows)) })
app.delete('/api/terminals/:id', (c) => { pty.killTerminal(c.req.param('id')); return c.json({ ok: true }) })

// ---------- symbols / mentions ----------
app.get('/api/symbols', async (c) => c.json(await workspaceSymbols(c.req.query('q') || '', 100)))
app.get('/api/dirs', async (c) => c.json((await ws.listFilesFlat(5000, true)).filter((p) => p.endsWith('/'))))

// ---------- tab completion (ghost text) ----------
app.post('/api/complete', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  return c.json({ completion: await tabComplete({ path: String(b.path || ''), language: String(b.language || ''), prefix: String(b.prefix || ''), suffix: String(b.suffix || '') }) })
})

// ---------- codebase search (@codebase:<query>) ----------
app.post('/api/codebase', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  return c.json(await searchCodebase(String(b.query || ''), { maxFiles: +(b.maxFiles || 8), maxChars: +(b.maxChars || 12000) }))
})

// ---------- inline edit (Ctrl+K) ----------
app.post('/api/inline-edit', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  return c.json({
    replacement: await inlineEdit({
      path: String(b.path || ''), language: String(b.language || ''),
      context: String(b.context || ''), selection: String(b.selection || ''),
      instruction: String(b.instruction || ''),
    }),
  })
})

// ---------- integrated browser (proxy local dev servers) ----------
app.all('/preview/:port{[0-9]+}', (c) => c.redirect(`/preview/${c.req.param('port')}/`))
app.all('/preview/:port{[0-9]+}/*', proxy)
app.post('/api/agents/:id/approve', async (c) => {
  const { toolId, approve } = await c.req.json()
  agents.approveTool(c.req.param('id'), toolId, !!approve)
  return c.json({ ok: true })
})
app.get('/api/agents/:id/changes', async (c) => c.json(await agents.changeDetails(c.req.param('id'))))
app.post('/api/agents/:id/changes/resolve', async (c) => {
  const { path: p, accept, force } = await c.req.json()
  try {
    return c.json(await agents.resolveChange(c.req.param('id'), p ?? null, !!accept, !!force))
  } catch (e: any) {
    if (e.conflicts) return c.json({ error: e.message, conflicts: e.conflicts }, 409)
    throw e
  }
})

// ---------- live events ----------
app.get('/api/events', (c) =>
  streamSSE(c, async (s) => {
    let open = true
    const unsub = subscribe((e) => { if (open) s.writeSSE({ data: JSON.stringify(e) }).catch(() => {}) })
    s.onAbort(() => { open = false; unsub() })
    await s.writeSSE({ data: JSON.stringify({ kind: 'hello' }) })
    while (open) { await s.sleep(15000); if (open) await s.writeSSE({ event: 'ping', data: '' }).catch(() => {}) }
  }),
)

// ---------- static frontend ----------
app.use('/vendor/monaco/*', serveStatic({ root: './node_modules/monaco-editor/min', rewriteRequestPath: (p) => p.replace(/^\/vendor\/monaco/, '') }))
app.use('/vendor/codicons/*', serveStatic({ root: './node_modules/@vscode/codicons/dist', rewriteRequestPath: (p) => p.replace(/^\/vendor\/codicons/, '') }))
app.use('/vendor/xterm/*', serveStatic({ root: './node_modules/@xterm', rewriteRequestPath: (p) => p.replace(/^\/vendor\/xterm/, '') }))
app.use('/vendor/marked.js', serveStatic({ path: './node_modules/marked/lib/marked.umd.js' }))
app.use('/vendor/purify.js', serveStatic({ path: './node_modules/dompurify/dist/purify.min.js' }))
app.use('/vendor/diff.js', serveStatic({ path: './node_modules/diff/dist/diff.min.js' }))
app.use('/*', serveStatic({ root: './public' }))
app.get('*', serveStatic({ path: './public/index.html' }))

const PORT = Number(process.env.PORT || 3000)
const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`CursorWeb running on http://localhost:${PORT}  workspace=${ws.WORKSPACE_ROOT}`)
})

pty.attachTerminalServer(server as any, (req) => {
  if (!ACCESS_TOKEN) return true
  return new RegExp(`(?:^|;\\s*)cw_token=${ACCESS_TOKEN}(?:;|$)`).test(req.headers.cookie || '')
})
