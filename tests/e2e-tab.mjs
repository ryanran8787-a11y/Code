// E2E: Tab ghost completion + Ctrl+K inline edit (uses the built-in mock model).
// Expects a running server: BASE (default http://localhost:3104) with WS workspace dir.
// Does not touch ./workspace or user settings: settings are backed up and restored.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3104'
const WS = process.env.WS || 'workspace'
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓ ' + m) }
const api = (path, method = 'GET', body) =>
  fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())

const settingsFile = '.cursorweb/settings.json'
const hadSettings = fs.existsSync(settingsFile)
const settingsBak = hadSettings ? fs.readFileSync(settingsFile, 'utf8') : null

const b = await chromium.launch(process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE } : {})
const p = await b.newPage({ viewport: { width: 1440, height: 860 } })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
try {
  await api('/api/settings', 'PUT', { baseUrl: 'mock' })
  await api('/api/file', 'PUT', { path: 'tabtest.js', content: 'console.' })

  await p.goto(BASE + '/#editor')
  await p.waitForSelector('.app')
  await p.waitForSelector('.tree-row[data-path="tabtest.js"]', { timeout: 10000 })
  await p.dblclick('.tree-row[data-path="tabtest.js"]')
  await p.waitForSelector('.tab.active:has-text("tabtest.js")')

  console.log('1. Tab ghost completion')
  await p.click('.monaco-editor .view-lines')
  await p.keyboard.press('End')
  await p.keyboard.type(' ') // trigger provider
  await p.keyboard.press('Backspace')
  await p.waitForSelector('.monaco-editor .ghost-text-decoration', { timeout: 15000 })
  const ghost = await p.textContent('.monaco-editor .ghost-text-decoration')
  ok((ghost || '').includes('log();'), `ghost text shows mock completion (got: ${JSON.stringify(ghost)})`)
  await p.keyboard.press('Tab')
  await p.waitForFunction(() => window.cursorWeb.editor.group.editor.getValue().includes('console.log();'), null, { timeout: 5000 })
  ok(true, 'Tab accepted ghost text into model')

  console.log('2. Ctrl+K inline edit')
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Control+K')
  await p.waitForSelector('.inline-edit-box', { timeout: 5000 })
  ok(true, 'inline edit widget opened')
  await p.fill('.inline-edit-input', 'add comment')
  await p.keyboard.press('Enter')
  await p.waitForFunction(() => window.cursorWeb.editor.group.editor.getValue().includes('Edited by the mock agent'), null, { timeout: 15000 })
  ok(true, 'mock inline edit applied to model')
  await p.evaluate(() => window.cursorWeb.editor.group.saveActive())
  await p.waitForTimeout(800)
  ok(fs.readFileSync(`${WS}/tabtest.js`, 'utf8').includes('Edited by the mock agent'), 'edit saved to disk')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  console.log('TAB-E2E-OK')
} finally {
  try { await api('/api/fs/delete', 'POST', { path: 'tabtest.js' }) } catch {}
  try {
    if (hadSettings) fs.writeFileSync(settingsFile, settingsBak)
    else fs.rmSync(settingsFile, { force: true })
  } catch {}
  await b.close()
}
