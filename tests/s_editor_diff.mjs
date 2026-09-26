export default async (p) => {
  await fetch('http://localhost:3000/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: 'mock' }) })
  await p.click('.auxbar button[title^="New Agent"]')
  await p.fill('.auxbar .composer-input', 'Please edit src/todo.js and add a todo plan')
  await p.keyboard.press('Enter')
  await p.waitForSelector('.auxbar .changes-bar:not(.hidden)', { timeout: 20000 })
  await p.waitForFunction(() => document.querySelector('.auxbar .st-done, .auxbar-done') || !document.querySelector('.auxbar .composer-send.stop'), null, { timeout: 20000 })
  await p.click('.auxbar .changes-head button:has-text("Review")')
  await p.waitForTimeout(1200)
}
