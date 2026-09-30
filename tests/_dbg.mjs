import { chromium } from 'playwright'
import fs from 'node:fs'
const TOKEN = (/ACCESS_TOKEN=(.*)/.exec(fs.readFileSync('.env.local','utf8'))||[])[1]
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 860 } })
p.on('console', m => console.log('console', m.type(), m.text()))
p.on('pageerror', e => console.log('PAGEERR', e.message))
await p.goto('http://localhost:3000/?token=' + TOKEN + '#agents'); await p.waitForSelector('.app'); await p.waitForTimeout(800)
await p.click('.aw-item')
if (await p.isHidden('.aw-review')) await p.click('.aw-layout-btns button[title^="Toggle Review Panel"]')
await p.waitForTimeout(1000)
console.log(await p.evaluate(async () => { try { await window.cursorWeb.agents.renderReviewList(); return document.querySelector('.aw-review-list').outerHTML.slice(0, 500) } catch (e) { return 'ERR ' + e.stack } }))
await b.close()
