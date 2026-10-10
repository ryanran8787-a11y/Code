// E2E: approval policy (allowlist auto-run, denylist reject) + settings roundtrip.
// Uses the built-in mock model. Expects a running server: BASE (default http://localhost:3105).
// Settings are backed up and restored.
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3105'
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
    if (Date.now() - t0 > timeoutMs) throw new Error('ASSERT: agent ' + id + ' timed out in ' + a.status)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

try {
  console.log('1. settings roundtrip')
  await api('/api/settings', 'PUT', {
    baseUrl: 'mock', commandAllowlist: ['^node --version(\\s|$)'], commandDenylist: ['rm\\s+-rf'], fallbackModels: [], retryBudget: 1,
  })
  const s = await api('/api/settings')
  ok(s.baseUrl === 'mock', 'baseUrl persisted')
  ok(JSON.stringify(s.commandAllowlist) === JSON.stringify(['^node --version(\\s|$)']), 'allowlist persisted')
  ok(JSON.stringify(s.commandDenylist) === JSON.stringify(['rm\\s+-rf']), 'denylist persisted')
  ok(s.retryBudget === 1, 'retryBudget persisted')

  console.log('2. allowlisted command runs without approval')
  let created = await api('/api/agents', 'POST', { prompt: 'Please run `node --version`' })
  let a = await waitDone(created.id)
  ok(a.status === 'done', 'agent finished done')
  const tool = (a.timeline || []).find((t) => t.type === 'tool' && t.name === 'run_terminal_command')
  ok(tool && tool.status === 'done', 'command auto-ran (no approval gate hit)')
  ok(tool.result && tool.result.includes('v'), 'command output recorded')
  await api('/api/agents/' + created.id, 'DELETE')

  console.log('3. denylisted command is rejected without running')
  created = await api('/api/agents', 'POST', { prompt: 'Please run `rm -rf /`' })
  a = await waitDone(created.id)
  const blocked = (a.timeline || []).find((t) => t.type === 'tool' && t.name === 'run_terminal_command')
  ok(blocked && blocked.status === 'rejected', 'command rejected by denylist')
  ok(!((blocked.result || '') + (blocked.output || '')).includes('total '), 'denied command never executed')
  await api('/api/agents/' + created.id, 'DELETE')

  console.log('RELIABILITY-E2E-OK')
} finally {
  try {
    if (hadSettings) fs.writeFileSync(settingsFile, settingsBak)
    else fs.rmSync(settingsFile, { force: true })
  } catch {}
}
