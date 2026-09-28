// Lightweight workspace symbol index (regex based, multi-language) used for
// @-mentions of symbols in the composer and "Go to Symbol in Workspace".
import { main } from './workspace'

export type Sym = { name: string; kind: string; path: string; line: number }

const PATTERNS: [RegExp, string][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
  [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'variable'],
  [/^ {2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, 'method'],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
  [/^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, 'class'],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/, 'function'],
  [/^#{1,3}\s+(.+)$/, 'heading'],
]
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor'])

let cache: { at: number; syms: Sym[] } | null = null

export async function workspaceSymbols(query = '', limit = 200): Promise<Sym[]> {
  if (!cache || Date.now() - cache.at > 5000) {
    const syms: Sym[] = []
    const files = (await main.listFilesFlat(3000)).filter((f) => /\.(m?[jt]sx?|py|go|rs|java|kt|rb|php|cs|md)$/.test(f))
    for (const f of files) {
      let text = ''
      try { text = await main.readFile(f) } catch { continue }
      if (text.length > 400_000) continue
      const md = f.endsWith('.md')
      text.split('\n').forEach((line, i) => {
        for (const [re, kind] of PATTERNS) {
          if (md !== (kind === 'heading')) continue
          const m = re.exec(line)
          if (m && !KEYWORDS.has(m[1])) { syms.push({ name: m[1].trim().slice(0, 80), kind, path: f, line: i + 1 }); break }
        }
      })
    }
    cache = { at: Date.now(), syms }
  }
  const q = query.toLowerCase()
  const res = q ? cache.syms.filter((s) => s.name.toLowerCase().includes(q)) : cache.syms
  return res.sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)).slice(0, limit)
}
