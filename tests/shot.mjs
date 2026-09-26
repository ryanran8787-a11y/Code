// usage: node tests/shot.mjs <name> [hash] [script.js]
import { chromium } from 'playwright'
import fsTok from 'node:fs'
const TOKEN = process.env.ACCESS_TOKEN || (/ACCESS_TOKEN=(.*)/.exec(fsTok.existsSync('.env.local') ? fsTok.readFileSync('.env.local','utf8') : '') || [])[1] || ''
const [name='s', hash='agents', script] = process.argv.slice(2)
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 860 } })
const logs = []
p.on('console', m => { if (m.type() === 'error' || m.type()==='warning') logs.push(m.type()+': '+m.text()) })
p.on('pageerror', e => logs.push('PAGEERROR: ' + e.message))
await p.goto('http://localhost:3000/?token=' + TOKEN + '#' + hash)
await p.waitForSelector('.app', { timeout: 20000 })
await p.waitForTimeout(800)
if (script) { const fn = (await import(script)).default; try { await fn(p) } catch (e) { logs.push('SCRIPT FAIL: ' + e.message.split('\n')[0]) } }
await p.screenshot({ path: `tests/screens/${name}.png` })
console.log(logs.join('\n') || 'no console errors')
await b.close()
