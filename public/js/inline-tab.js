// Tab ghost completion: one Monaco InlineCompletionsProvider backed by
// POST /api/complete. Conservative by design — the server returns null
// instead of guessing, so ghost text only appears when confident.
// Accept: Tab (full) · partial word: editor.action.inlineSuggest.acceptNextWord.
let enabled = localStorage.getItem('tab.enabled') !== '0'
let debounceMs = +(localStorage.getItem('tab.debounceMs') || 250) || 250
let seq = 0

export function isTabEnabled() { return enabled }
export function setTabEnabled(v) {
  enabled = !!v
  localStorage.setItem('tab.enabled', enabled ? '1' : '0')
}

const LANGS = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
  'php', 'ruby', 'css', 'scss', 'less', 'html', 'json', 'yaml', 'toml', 'markdown',
  'shell', 'powershell', 'sql', 'lua', 'swift', 'kotlin', 'dart']

function pathOf(model) {
  return (model.uri.path || '').replace(/^\/+/, '')
}

async function fetchCompletion(path, language, prefix, suffix, signal) {
  const r = await fetch('/api/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, language, prefix: prefix.slice(-6000), suffix: suffix.slice(0, 2000) }),
    signal,
  })
  if (!r.ok) return null
  return (await r.json()).completion || null
}

export function setupTabCompletion() {
  const provider = {
    async provideInlineCompletions(model, position, context, token) {
      if (!enabled) return { items: [] }
      const my = ++seq
      await new Promise((res) => setTimeout(res, debounceMs))
      if (my !== seq || token.isCancellationRequested) return { items: [] }
      const ctrl = new AbortController()
      const off = token.onCancellationRequested(() => ctrl.abort())
      try {
        const full = model.getValue()
        const offset = model.getOffsetAt(position)
        const prefix = full.slice(0, offset)
        const suffix = full.slice(offset)
        if (!prefix.trim()) return { items: [] }
        const text = await fetchCompletion(pathOf(model), model.getLanguageId(), prefix, suffix, ctrl.signal)
        if (!text || my !== seq || token.isCancellationRequested) return { items: [] }
        if (suffix.startsWith(text) || prefix.endsWith(text)) return { items: [] }
        return {
          items: [{
            insertText: text,
            range: {
              startLineNumber: position.lineNumber, startColumn: position.column,
              endLineNumber: position.lineNumber, endColumn: position.column,
            },
          }],
        }
      } catch { return { items: [] } }
      finally { off.dispose() }
    },
    freeInlineCompletions() {},
  }
  for (const lang of LANGS) monaco.languages.registerInlineCompletionsProvider(lang, provider)
}
