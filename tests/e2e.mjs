// End-to-end verification of the core loop (uses the built-in mock model).
import { chromium } from 'playwright'
import fsTok from 'node:fs'
const TOKEN = process.env.ACCESS_TOKEN || (/ACCESS_TOKEN=(.*)/.exec(fsTok.existsSync('.env.local') ? fsTok.readFileSync('.env.local','utf8') : '') || [])[1] || ''
import fs from 'node:fs'
const BASE = process.env.BASE || 'http://localhost:3000'
const WS = 'sample-workspace'
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓ ' + m) }
const api = (path, method = 'GET', body) => fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie: 'cw_token=' + TOKEN }, body: body && JSON.stringify(body) }).then(r => r.json())

await api('/api/settings', 'PUT', { baseUrl: 'mock', autoRunCommands: false })
for (const a of await api('/api/agents')) await api('/api/agents/' + a.id, 'DELETE')
const original = fs.readFileSync(`${WS}/src/utils.js`, 'utf8')

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 860 } })
const errors = []
p.on('pageerror', e => errors.push(e.message))
await p.addInitScript(() => { if (!sessionStorage.getItem('x')) { localStorage.clear(); sessionStorage.setItem('x', '1') } })
await p.goto(BASE + '/?token=' + TOKEN + '#editor')
await p.waitForSelector('.app')

console.log('1. Editor Window')
ok(await p.isVisible('.editor-window'), 'editor window visible')
if (!(await p.$('.tree-row[data-path="src/utils.js"]'))) await p.click('.tree-row[data-path="src"]')
await p.dblclick('.tree-row[data-path="src/utils.js"]')
await p.waitForSelector('.tab.active:has-text("utils.js")')
ok((await p.textContent('.monaco-editor .view-lines')).includes('formatDate'), 'utils.js content rendered in Monaco')

console.log('2. Agent from Editor Window side panel edits the open file')
await p.fill('.auxbar .composer-input', 'Please edit src/utils.js')
await p.keyboard.press('Enter')
await p.waitForSelector('.auxbar .edit-card', { timeout: 20000 })
await p.waitForFunction(() => window.cursorWeb.editor.group.editor.getValue().includes('Edited by the mock agent'), null, { timeout: 10000 })
ok(fs.readFileSync(`${WS}/src/utils.js`, 'utf8').startsWith('// Edited by the mock agent'), 'file changed on disk')
ok(true, 'open editor model live-reloaded with agent edit')
await p.waitForSelector('.auxbar .changes-bar:not(.hidden)', { timeout: 10000 })
ok(true, 'pending changes bar shown')

console.log('3. Undo restores original, file tree / editor follow')
await p.click('.auxbar .changes-head button:has-text("Undo all")')
await p.waitForFunction(() => !window.cursorWeb.editor.group.editor.getValue().includes('Edited by the mock agent'), null, { timeout: 10000 })
ok(fs.readFileSync(`${WS}/src/utils.js`, 'utf8') === original, 'undo restored original content on disk and in editor')

console.log('4. Switch to Agents Window, agent is listed and opens')
await p.keyboard.press('Control+Shift+A')
await p.waitForSelector('.agents-window:not(.hidden)')
ok(await p.isVisible('.aw-item'), 'agent created in editor appears in Agents Window sidebar')
await p.click('.aw-item')
await p.waitForSelector('.aw-pane .edit-card')
ok(true, 'agent timeline rendered in Agents Window')

console.log('5. Parallel agents in grid layout')
await p.click('button[title="Grid (4 agents)"]')
for (const prompt of ['Create src/a.js please', 'Create src/b.js please']) {
  await p.click('.aw-tab-add'); await p.waitForTimeout(150)
  await p.fill('.aw-pane.focused .composer-input', prompt); await p.keyboard.press('Enter')
}
await p.waitForFunction(() => document.querySelectorAll('.aw-pane').length >= 3, null, { timeout: 5000 })
await p.waitForFunction(() => document.querySelectorAll('.aw-item .st-done').length >= 3, null, { timeout: 30000 })
ok(fs.existsSync(`${WS}/src/a.js`) && fs.existsSync(`${WS}/src/b.js`), 'two agents ran concurrently and created files')
await p.screenshot({ path: 'tests/screens/e2e-grid.png' })

console.log('6. Approval flow for terminal commands')
await p.click('button[title="Single agent"]')
await p.click('.aw-new')
await p.fill('.aw-pane .composer-input', 'run `echo hello-from-agent`')
await p.keyboard.press('Enter')
await p.waitForSelector('.needs-approval', { timeout: 15000 })
ok(await p.isVisible('.aw-item .st-await'), 'sidebar shows "needs approval" state')
await p.click('.needs-approval .btn-primary')
await p.waitForSelector('.term-out:has-text("hello-from-agent")', { timeout: 15000 })
ok(true, 'command output streamed into chat')

console.log('7. Keep changes & review in Editor Window via Open in Editor')
const aid = (await api('/api/agents')).find(a => a.title.includes('src/a.js')).id
await api(`/api/agents/${aid}/changes/resolve`, 'POST', { accept: true })
await p.keyboard.press('Control+Shift+E')
await p.waitForSelector('.editor-window:not(.hidden)')
await p.waitForSelector('.tree-row[data-path="src/a.js"]', { timeout: 5000 })
ok(true, 'file tree shows agent-created file after switching back')
await p.keyboard.press('Control+P')
await p.keyboard.type('b.js')
await p.keyboard.press('Enter')
await p.waitForSelector('.tab.active:has-text("b.js")')
ok(true, 'Quick Open (Ctrl+P) opens file')
await p.keyboard.press('Control+Shift+P')
await p.keyboard.type('Open Agents Window')
await p.keyboard.press('Enter')
await p.waitForSelector('.agents-window:not(.hidden)')
ok(true, 'Command Palette "Open Agents Window" switches windows')
await p.screenshot({ path: 'tests/screens/e2e-final.png' })

ok(errors.length === 0, 'no page errors ' + errors.join('; '))
await b.close()
// cleanup workspace
for (const f of ['src/a.js', 'src/b.js']) fs.rmSync(`${WS}/${f}`, { force: true })
fs.writeFileSync(`${WS}/src/utils.js`, original)
console.log('\nALL E2E CHECKS PASSED')
