// VS Code style Quick Input: used for Quick Open (Ctrl+P), Command Palette
// (Ctrl+Shift+P, '>' prefix) and generic pickers.
import { h, icon } from './util.js'

function score(label, q) {
  if (!q) return 1
  label = label.toLowerCase(); q = q.toLowerCase()
  const idx = label.indexOf(q)
  if (idx >= 0) return 1000 - idx - label.length * 0.01
  // fuzzy subsequence
  let i = 0, s = 0, last = -1
  for (const ch of q) {
    const j = label.indexOf(ch, i)
    if (j < 0) return 0
    s += j === last + 1 ? 5 : 1
    last = j; i = j + 1
  }
  return s
}

let active = null

/**
 * @param {Array<{label:string, description?:string, detail?:string, value:any, icon?:Node, keybinding?:string}>|((q:string)=>any[])} items
 */
export function quickPick(items, { placeholder = '', value = '', onChangeValue } = {}) {
  active?.close(undefined)
  return new Promise((resolve) => {
    const input = h('input', { class: 'qi-input', placeholder, spellcheck: 'false', value })
    const list = h('div', { class: 'qi-list', role: 'listbox' })
    const box = h('div', { class: 'quick-input' }, h('div', { class: 'qi-head' }, input), list)
    const overlay = h('div', { class: 'qi-overlay', onmousedown: (e) => { if (e.target === overlay) close(undefined) } }, box)
    document.body.append(overlay)
    let sel = 0
    let shown = []
    function render() {
      const q = input.value
      const src = typeof items === 'function' ? items(q) : items
      const query = typeof items === 'function' ? '' : q
      shown = src.map((it) => ({ it, s: score(it.label + ' ' + (it.description || ''), query) })).filter((x) => x.s > 0)
      if (query) shown.sort((a, b) => b.s - a.s)
      shown = shown.slice(0, 200).map((x) => x.it)
      sel = Math.min(sel, Math.max(0, shown.length - 1))
      list.replaceChildren(...(shown.length ? shown.map((it, i) => h('div', {
        class: 'qi-item' + (i === sel ? ' selected' : '') + (it.separator ? ' sep' : ''),
        onmousemove: () => { if (sel !== i) { sel = i; mark() } },
        onclick: () => close(it.value),
      }, it.icon || null, h('span', { class: 'qi-label' }, it.label), it.description ? h('span', { class: 'qi-desc' }, it.description) : null,
      h('span', { class: 'flex1' }), it.keybinding ? h('span', { class: 'qi-kb' }, ...it.keybinding.split('+').map((k) => h('kbd', {}, k))) : null)) : [h('div', { class: 'qi-empty' }, 'No matching results')]))
    }
    function mark() {
      ;[...list.children].forEach((c, i) => c.classList.toggle('selected', i === sel))
      list.children[sel]?.scrollIntoView({ block: 'nearest' })
    }
    function close(v) { overlay.remove(); active = null; resolve(v) }
    input.addEventListener('input', () => { sel = 0; onChangeValue?.(input.value, { close, setItems: (n) => { items = n; render() } }); render() })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark() }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) close(shown[sel].value) }
      else if (e.key === 'Escape') { e.preventDefault(); close(undefined) }
    })
    active = { close }
    render()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
}

export function inputBox({ placeholder = '', value = '', prompt = '' } = {}) {
  active?.close(undefined)
  return new Promise((resolve) => {
    const input = h('input', { class: 'qi-input', placeholder, value, spellcheck: 'false' })
    const box = h('div', { class: 'quick-input' }, h('div', { class: 'qi-head' }, input), prompt ? h('div', { class: 'qi-prompt' }, prompt) : null)
    const overlay = h('div', { class: 'qi-overlay', onmousedown: (e) => { if (e.target === overlay) close(undefined) } }, box)
    document.body.append(overlay)
    function close(v) { overlay.remove(); active = null; resolve(v) }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value) }
      else if (e.key === 'Escape') { e.preventDefault(); close(undefined) }
    })
    active = { close }
    input.focus(); input.select()
  })
}

export function isQuickOpen() { return !!active }
