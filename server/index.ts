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
  const a = agents.createAgent({ prompt: b.prompt, model: b.model, mode: b.mode })
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
app.delete('/api/agents/:id', (c) => { agents.deleteAgent(c.req.param('id')); return c.json({ ok: true }) })
app.post('/api/agents/:id/approve', async (c) => {
  const { toolId, approve } = await c.req.json()
  agents.approveTool(c.req.param('id'), toolId, !!approve)
  return c.json({ ok: true })
})
app.get('/api/agents/:id/changes', async (c) => c.json(await agents.changeDetails(c.req.param('id'))))
app.post('/api/agents/:id/changes/resolve', async (c) => {
  const { path: p, accept } = await c.req.json()
  return c.json(await agents.resolveChange(c.req.param('id'), p ?? null, !!accept))
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
app.use('/vendor/marked.js', serveStatic({ path: './node_modules/marked/lib/marked.umd.js' }))
app.use('/vendor/purify.js', serveStatic({ path: './node_modules/dompurify/dist/purify.min.js' }))
app.use('/vendor/diff.js', serveStatic({ path: './node_modules/diff/dist/diff.min.js' }))
app.use('/*', serveStatic({ root: './public' }))
app.get('*', serveStatic({ path: './public/index.html' }))

const PORT = Number(process.env.PORT || 3000)
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`CursorWeb running on http://localhost:${PORT}  workspace=${ws.WORKSPACE_ROOT}`)
})
