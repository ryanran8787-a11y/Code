// E2E: @codebase:<query> chip -> submit -> agent receives packed snippets.
// Expects a running server: BASE (default http://localhost:3109) with WS workspace dir
// seeded from examples/todo-app. Settings are backed up and restored.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3109'
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓ ' + m) }
const api = (path, method = 'GET', body) =>
  fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())

const settingsFile = '.cursorweb/settings.json'
const hadSettings = fs.existsSync(settingsFile)
const settingsBak = hadSettings ? fs.readFileSync(settingsFile, 'utf8') : null

async function waitDone(id, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    const a = await api('/api/agents/' + id)
    if (['done', 'error', 'stopped'].includes(a.status)) return a
    if (Date.now() - t0 > timeoutMs) throw new Error('ASSERT: agent timed out in ' + a.status)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const b = await chromium.launch(process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE } : {})
const p = await b.newPage({ viewport: { width: 1440, height: 860 } })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
try {
  await api('/api/settings', 'PUT', { baseUrl: 'mock', autoRunCommands: true })
  for (const a of await api('/api/agents')) await api('/api/agents/' + a.id, 'DELETE')

  await p.goto(BASE + '/#editor')
  await p.waitForSelector('.app')
  await p.click('.auxbar .composer-input')
  await p.keyboard.type('@codebase:todo')
  await p.waitForSelector('.mention-menu .mm-item', { timeout: 8000 })
  const label = await p.textContent('.mention-menu .mm-item')
  ok((label || '').includes('Codebase: todo'), `codebase menu item shown (got: ${JSON.stringify(label)})`)
  await p.keyboard.press('Enter')
  await p.waitForSelector('.chip-codebase', { timeout: 5000 })
  ok(true, 'codebase chip added to composer')

  await p.keyboard.type('What does this code do?')
  await p.keyboard.press('Enter')
  await p.waitForFunction(() => window.cursorWeb.editor.group !== undefined, null, { timeout: 5000 })
  // find the agent created by this submit
  let agent = null
  for (let i = 0; i < 30; i++) {
    const list = await api('/api/agents')
    if (list.length) { agent = list[0]; break }
    await new Promise((r) => setTimeout(r, 1000))
  }
  ok(!!agent, 'submit created an agent')
  const full = await waitDone(agent.id)
  const userMsg = (full.timeline || []).find((t) => t.type === 'user')
  ok(!!userMsg && userMsg.text.includes('Codebase search for `todo`'), 'agent got expanded codebase context')
  ok(!!userMsg && userMsg.text.includes('src/todo.js'), 'expansion includes ranked file')
  await api('/api/agents/' + agent.id, 'DELETE')

  console.log('2. multi-word query keeps the menu open')
  await p.click('.auxbar .composer-input')
  await p.keyboard.type('@codebase:todo list')
  await p.waitForSelector('.mention-menu .mm-item', { timeout: 8000 })
  const label2 = await p.textContent('.mention-menu .mm-item')
  ok((label2 || '').includes('Codebase: todo list'), `multi-word item shown (got: ${JSON.stringify(label2)})`)
  await p.keyboard.press('Enter')
  await p.waitForSelector('.chip-codebase[title="todo list"]', { timeout: 5000 })
  ok(true, 'multi-word chip added')
  // composer busy flag follows agent status over SSE; wait until it clears
  await p.waitForFunction(() => !document.querySelector('.auxbar .composer-send.stop'), null, { timeout: 15000 })
  await p.keyboard.type('Explain.')
  await p.keyboard.press('Enter')
  let agent2 = null
  for (let i = 0; i < 30; i++) {
    const list = await api('/api/agents')
    if (list.length) { agent2 = list[0]; break }
    await new Promise((r) => setTimeout(r, 1000))
  }
  ok(!!agent2, 'second submit created an agent')
  const full2 = await waitDone(agent2.id)
  const userMsg2 = (full2.timeline || []).find((t) => t.type === 'user')
  ok(!!userMsg2 && userMsg2.text.includes('Codebase search for `todo list`'), 'multi-term expansion reached the agent')
  await api('/api/agents/' + agent2.id, 'DELETE')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  console.log('CODEBASE-E2E-OK')
} finally {
  try {
    if (hadSettings) fs.writeFileSync(settingsFile, settingsBak)
    else fs.rmSync(settingsFile, { force: true })
  } catch {}
  await b.close()
}
