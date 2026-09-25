// Simple command terminal panel (non-interactive; each command runs in a fresh
// bash in the workspace and streams output). Also mirrors agent commands.
import { postSSE } from './api.js'
import { h, icon } from './util.js'

export class TerminalPanel {
  constructor() {
    this.history = JSON.parse(localStorage.getItem('term.history') || '[]')
    this.hi = this.history.length
    this.out = h('div', { class: 'term-output' })
    this.input = h('input', { class: 'term-input', spellcheck: 'false', placeholder: 'Type a command and press Enter…' })
    this.cwd = ''
    this.running = null
    this.el = h('div', { class: 'terminal', onclick: (e) => { if (!window.getSelection()?.toString()) this.input.focus() } },
      this.out, h('div', { class: 'term-line' }, h('span', { class: 'term-prompt' }, '❯'), this.input))
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const c = this.input.value; this.input.value = ''; this.run(c) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (this.hi > 0) this.input.value = this.history[--this.hi] || '' }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.hi = Math.min(this.history.length, this.hi + 1); this.input.value = this.history[this.hi] || '' }
      else if (e.key === 'c' && e.ctrlKey && this.running) { this.running.abort(); this.print('^C\n', 'muted') }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); this.out.replaceChildren() }
    })
    this.print('CursorWeb terminal — commands run with bash in the workspace root.\n', 'muted')
  }
  print(text, cls = '') {
    const last = this.out.lastElementChild
    if (last && last.dataset.cls === cls && !cls.includes('cmd')) last.textContent += text
    else this.out.append(h('span', { class: cls, dataset: { cls } }, text))
    if (this.out.childElementCount > 2000) this.out.firstElementChild.remove()
    this.out.parentElement && (this.el.scrollTop = this.el.scrollHeight)
  }
  async run(cmd) {
    cmd = cmd.trim()
    if (!cmd) return
    if (this.running) { this.print('A command is already running (Ctrl+C to cancel).\n', 'err'); return }
    this.history.push(cmd); this.history = this.history.slice(-100); this.hi = this.history.length
    localStorage.setItem('term.history', JSON.stringify(this.history))
    if (cmd === 'clear') { this.out.replaceChildren(); return }
    this.print(`❯ ${cmd}\n`, 'cmd')
    const ctrl = new AbortController()
    this.running = ctrl
    try {
      await postSSE('/api/terminal/run', { command: cmd, cwd: this.cwd }, (ev, data) => {
        if (ev === 'data') this.print(data)
        if (ev === 'exit') { if (data.code) this.print(`[exit ${data.code}${data.timedOut ? ', timed out' : ''}]\n`, 'err') }
      }, ctrl.signal)
    } catch (e) { if (e.name !== 'AbortError') this.print(String(e) + '\n', 'err') }
    this.running = null
  }
  focus() { this.input.focus() }
}
