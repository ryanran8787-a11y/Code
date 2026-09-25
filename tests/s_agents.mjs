export default async (p) => {
  await p.waitForSelector('.composer-input')
  await p.fill('.aw-pane .composer-input', 'Explain the project and read README.md')
  await p.keyboard.press('Enter')
  await p.waitForSelector('.msg-assistant', { timeout: 15000 })
  await p.waitForFunction(() => document.querySelector('.aw-item .st-done'), null, { timeout: 20000 })
  await p.waitForTimeout(300)
}
