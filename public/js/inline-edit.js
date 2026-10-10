// Ctrl+K inline edit: prompt widget at the cursor, replacement applied with
// pushEditOperations (undo stack preserved — Ctrl+Z reverts).
import { toast } from './util.js'

function pathOf(model) {
  return (model.uri.path || '').replace(/^\/+/, '')
}

function surrounding(model, range) {
  const start = Math.max(1, range.startLineNumber - 40)
  const end = Math.min(model.getLineCount(), range.endLineNumber + 40)
  return model.getValueInRange({
    startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end),
  })
}

export function setupInlineEdit(group) {
  const editor = group.editor
  let widget = null

  function close() {
    if (widget) { editor.removeContentWidget(widget); widget = null }
  }

  async function submit(instruction) {
    const w = widget
    if (!w || !instruction.trim()) { close(); editor.focus(); return }
    const model = editor.getModel()
    const tab = group.activeTab()
    if (!model || !tab || tab.kind !== 'file') { close(); return }
    const sel = editor.getSelection()
    const range = sel && !sel.isEmpty() ? sel : {
      startLineNumber: sel.startLineNumber, startColumn: 1,
      endLineNumber: sel.startLineNumber, endColumn: model.getLineMaxColumn(sel.startLineNumber),
    }
    const selection = model.getValueInRange(range)
    w.setLoading(true)
    try {
      const r = await fetch('/api/inline-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: tab.path, language: model.getLanguageId(),
          context: surrounding(model, range), selection, instruction: instruction.trim(),
        }),
      })
      const replacement = r.ok ? (await r.json()).replacement : null
      if (!replacement || replacement === selection) {
        toast(replacement === selection ? 'No change suggested.' : 'Inline edit failed (no result).', replacement === selection ? 'info' : 'error')
      } else {
        const startOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn })
        model.pushEditOperations([], [{ range, text: replacement }], () => null)
        const end = model.getPositionAt(startOffset + replacement.length)
        editor.setSelection({ startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: end.lineNumber, endColumn: end.column })
        editor.revealRangeInCenter({ startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: end.lineNumber, endColumn: end.column })
        toast('Applied — Ctrl+Z to undo.', 'info', 2500)
      }
    } catch (e) {
      toast('Inline edit failed: ' + e.message, 'error')
    } finally {
      close(); editor.focus()
    }
  }

  editor.addAction({
    id: 'cursor.inlineEdit',
    label: 'Inline Edit with AI (Ctrl+K)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1,
    run: () => {
      close()
      const sel = editor.getSelection()
      const pos = sel ? { lineNumber: sel.endLineNumber, column: sel.endColumn } : editor.getPosition()
      const input = document.createElement('input')
      input.className = 'inline-edit-input'
      input.placeholder = 'Describe the edit, Enter to apply, Esc to cancel…'
      input.spellcheck = false
      const hint = document.createElement('span')
      hint.className = 'inline-edit-status'
      const box = document.createElement('div')
      box.className = 'inline-edit-box'
      box.append(input, hint)
      widget = {
        getId: () => 'cursor.inlineEditWidget',
        getDomNode: () => box,
        getPosition: () => ({ position: pos, preference: [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE] }),
        setLoading: (on) => { hint.textContent = on ? 'Working…' : ''; input.disabled = on },
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') submit(input.value)
        else if (e.key === 'Escape') { close(); editor.focus() }
      })
      editor.addContentWidget(widget)
      editor.layoutContentWidget(widget)
      editor.revealPositionInCenter(pos)
      input.focus()
    },
  })
}
