// E2E: Plan mode — read-only planning, approve & execute, composer mode cycle.
// Expects a running server: BASE (default http://localhost:3111) with WS workspace
// dir seeded from examples/todo-app. Settings are backed up and restored.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:3111'
const WS = process.env.WS || 'workspace-e2e4'
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓ ' + m) }
const api = (pp, method = 'GET', body) =>
  fetch(BASE + pp, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())

const READONLY = new Set(['list_dir', 'read_file', 'grep_search', 'file_search', 'update_todos', 'fetch_url', 'read_process_output'])
async function waitDone(id, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    const a = await api('/api/agents/' + id)
    if (['done', 'error', 'stopped'].includes(a.status)) return a
    if (Date.now() - t0 > timeoutMs) throw new Error('ASSERT: agent timed out in ' + a.status)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const settingsFile = '.cursorweb/settings.json'
const hadSettings = fs.existsSync(settingsFile)
const settingsBak = hadSettings ? fs.readFileSync(settingsFile, 'utf8') : null
const todoPath = path.join(WS, 'src', 'todo.js')
const todoBak = fs.readFileSync(todoPath, 'utf8')
const b = await chromium.launch(process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE } : {})
const p = await b.newPage({ viewport: { width: 1440, height: 860 } })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
try {
  await api('/api/settings', 'PUT', { baseUrl: 'mock', autoRunCommands: true })
  for (const a of await api('/api/agents')) await api('/api/agents/' + a.id, 'DELETE')
  const before = fs.readFileSync(path.join(WS, 'src', 'todo.js'), 'utf8')

  console.log('1. plan run is read-only')
  let created = await api('/api/agents', 'POST', { prompt: 'Add a `remove(id)` method to src/todo.js', mode: 'plan' })
  let a = await waitDone(created.id)
  ok(a.mode === 'plan', 'mode stored as plan')
  const tools = (a.timeline || []).filter((t) => t.type === 'tool')
  ok(tools.length > 0, 'plan explored with tools')
  ok(tools.every((t) => READONLY.has(t.name)), `only read tools used (${tools.map((t) => t.name).join(',')})`)
  ok(fs.readFileSync(path.join(WS, 'src', 'todo.js'), 'utf8') === before, 'plan changed no files')

  console.log('2. approve switches to agent and executes')
  await api(`/api/agents/${created.id}/messages`, 'POST', { text: 'Approved — now add the remove method to src/todo.js', mode: 'agent' })
  a = await waitDone(created.id)
  ok(a.mode === 'agent', 'mode flipped to agent')
  const tools2 = (a.timeline || []).filter((t) => t.type === 'tool')
  ok(tools2.some((t) => t.name === 'edit_file' && t.status === 'done'), 'execution edited the file')
  ok(fs.readFileSync(path.join(WS, 'src', 'todo.js'), 'utf8').includes('Edited by the mock agent'), 'edit on disk')
  await api('/api/agents/' + created.id, 'DELETE')

  console.log('3. composer mode cycle + approve button')
  await p.goto(BASE + '/#editor')
  await p.waitForSelector('.app')
  const pill = '.auxbar .composer-pill'
  await p.waitForSelector(pill)
  const t0 = await p.textContent(pill)
  ok((t0 || '').includes('Agent'), `starts at Agent (got: ${t0})`)
  await p.click(pill)
  ok(((await p.textContent(pill)) || '').includes('Plan'), 'cycles to Plan')
  await p.click(pill)
  ok(((await p.textContent(pill)) || '').includes('Ask'), 'cycles to Ask')
  await p.click(pill)
  ok(((await p.textContent(pill)) || '').includes('Agent'), 'cycles back to Agent')

  created = await api('/api/agents', 'POST', { prompt: 'List src files', mode: 'plan' })
  await waitDone(created.id)
  await p.evaluate((id) => window.cursorWeb.editor.showAgent(id), created.id)
  await p.waitForSelector('.auxbar .plan-bar:not(.hidden)', { timeout: 10000 })
  ok(true, 'approve bar shown')
  await p.waitForSelector('.auxbar button[title="Approve plan & execute"]', { timeout: 10000 })
  await p.click('.auxbar button[title="Approve plan & execute"]')
  const a2 = await waitDone(created.id)
  ok(a2.mode === 'agent' && a2.status === 'done', 'approve button executed the plan')
  await api('/api/agents/' + created.id, 'DELETE')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  console.log('PLAN-E2E-OK')
} finally {
  try {
    fs.writeFileSync(todoPath, todoBak)
    if (hadSettings) fs.writeFileSync(settingsFile, settingsBak)
    else fs.rmSync(settingsFile, { force: true })
  } catch {}
  await b.close()
}
