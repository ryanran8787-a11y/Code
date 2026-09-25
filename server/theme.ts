// Converts VS Code's built-in color themes (copied from microsoft/vscode
// extensions/theme-defaults/themes) into (1) a Monaco theme definition and
// (2) a map of CSS variables used to paint the workbench chrome.
import fs from 'node:fs'
import path from 'node:path'

const THEME_DIR = path.join(process.cwd(), 'server', 'themes')

function parseJsonc(text: string) {
  // strip // and /* */ comments that are outside strings, then trailing commas
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += n; i++ } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

type Raw = { colors: Record<string, string>; tokenColors: any[]; type?: string; name?: string }

function loadTheme(file: string): Raw {
  const json = parseJsonc(fs.readFileSync(path.join(THEME_DIR, file), 'utf8'))
  let base: Raw = { colors: {}, tokenColors: [] }
  if (json.include) base = loadTheme(path.basename(json.include))
  return {
    name: json.name,
    type: json.type || base.type,
    colors: { ...base.colors, ...(json.colors || {}) },
    tokenColors: [...base.tokenColors, ...(Array.isArray(json.tokenColors) ? json.tokenColors : [])],
  }
}

function hex(c?: string) {
  if (!c) return undefined
  return c.replace('#', '')
}

let cache: any = null
export function getTheme() {
  if (cache) return cache
  const t = loadTheme('2026-dark.json')
  const rules: any[] = []
  for (const tc of t.tokenColors) {
    const scopes: string[] = Array.isArray(tc.scope) ? tc.scope : typeof tc.scope === 'string' ? tc.scope.split(',').map((s: string) => s.trim()) : ['']
    for (const s of scopes) {
      const r: any = { token: s }
      if (tc.settings?.foreground) r.foreground = hex(tc.settings.foreground)
      if (tc.settings?.fontStyle) r.fontStyle = tc.settings.fontStyle
      rules.push(r)
    }
  }
  // Monaco's monarch tokenizers emit simpler token names than TextMate scopes; map common ones.
  const tm = (scope: string) => {
    let best: any
    for (const tc of t.tokenColors) {
      const scopes: string[] = Array.isArray(tc.scope) ? tc.scope : typeof tc.scope === 'string' ? tc.scope.split(',').map((s: string) => s.trim()) : []
      if (scopes.some((s) => scope === s || scope.startsWith(s + '.'))) best = tc.settings
    }
    return best?.foreground ? hex(best.foreground) : undefined
  }
  const alias: Record<string, string> = {
    comment: 'comment', string: 'string', 'string.key.json': 'support.type.property-name.json', 'string.value.json': 'string',
    keyword: 'keyword.control', 'keyword.json': 'constant.language', number: 'constant.numeric', 'type.identifier': 'entity.name.type',
    type: 'entity.name.type', identifier: 'variable', delimiter: 'punctuation', tag: 'entity.name.tag', 'attribute.name': 'entity.other.attribute-name',
    'attribute.value': 'string', regexp: 'string.regexp', 'variable.predefined': 'variable.language', function: 'entity.name.function',
    'metatag': 'entity.name.tag', 'string.escape': 'constant.character.escape', operator: 'keyword.operator', 'keyword.flow': 'keyword.control',
  }
  for (const [tok, scope] of Object.entries(alias)) {
    const fg = tm(scope)
    if (fg) rules.push({ token: tok, foreground: fg })
  }
  const monacoColors: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.colors)) if (/^(editor|editorLineNumber|editorCursor|editorWidget|editorSuggestWidget|editorHoverWidget|diffEditor|scrollbarSlider|minimap|editorGutter|editorIndentGuide|editorBracket|input|list|focusBorder|widget|peekView|editorError|editorWarning|foreground)/.test(k)) monacoColors[k] = v
  const cssVars: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.colors)) cssVars['--vscode-' + k.replace(/\./g, '-')] = v
  cache = {
    name: t.name,
    monaco: { base: t.type === 'light' ? 'vs' : 'vs-dark', inherit: true, rules, colors: monacoColors },
    cssVars,
  }
  return cache
}
