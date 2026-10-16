// @codebase search: query-weighted file retrieval without embeddings.
// Combines filename matches, regex symbol hits and ripgrep content hits into
// a ranked, char-budgeted pack of snippets for the composer's context chips.
// Triggered from the composer with @codebase:<query> (spaces allowed).
import { main } from './workspace'
import { workspaceSymbols } from './symbols'

export type CodeSnippet = { line: number; text: string }
export type CodeFile = { path: string; score: number; snippets: CodeSnippet[] }

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'are', 'you',
  'your', 'all', 'any', 'our', 'out', 'use', 'used', 'using', 'how', 'what', 'where',
  'when', 'which', 'have', 'has', 'does', 'into', 'code', 'file', 'files',
])

export function tokenize(query: string): string[] {
  const out: string[] = []
  for (const t of String(query || '').toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length >= 2 && !STOP.has(t) && !out.includes(t)) out.push(t)
    if (out.length >= 8) break
  }
  return out
}

export async function searchCodebase(
  query: string,
  opts: { maxFiles?: number; maxChars?: number } = {},
): Promise<{ query: string; terms: string[]; files: CodeFile[]; truncated: boolean }> {
  const maxFiles = opts.maxFiles ?? 8
  const maxChars = opts.maxChars ?? 12000
  const terms = tokenize(query)
  if (!terms.length) return { query, terms, files: [], truncated: false }

  const scores = new Map<string, number>()
  const hitLines = new Map<string, Set<number>>()
  const bump = (p: string, n: number) => scores.set(p, (scores.get(p) || 0) + n)
  const hit = (p: string, line: number) => {
    if (!hitLines.has(p)) hitLines.set(p, new Set())
    hitLines.get(p)!.add(line)
  }

  const allFiles = await main.listFilesFlat(5000)
  for (const f of allFiles) {
    const base = f.split('/').pop()!.toLowerCase()
    for (const t of terms) {
      if (base.includes(t)) bump(f, 5)
      else if (f.toLowerCase().includes(t)) bump(f, 2)
    }
  }
  for (const t of terms) {
    try {
      for (const s of await workspaceSymbols(t, 50)) bump(s.path, 4)
    } catch { /* index unavailable */ }
  }
  for (const t of terms) {
    try {
      let perTerm = 0
      for (const h of await main.searchText(t, { max: 40 })) {
        if (perTerm >= 6) break
        bump(h.path, 1)
        perTerm++
        hit(h.path, h.line)
      }
    } catch { /* unreadable files */ }
  }

  const ranked = [...scores.entries()]
    .map(([p, s]) => {
      let score = s - 0.3 * (p.split('/').length - 1) // prefer shallow files
      if (/(^|\/)(test|tests|spec|__tests__)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p)) score *= 0.8
      return { path: p, score: Math.max(0, Math.round(score * 10) / 10) }
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)

  const files: CodeFile[] = []
  let used = 0
  let truncated = false
  for (const e of ranked) {
    let text = ''
    try {
      text = await main.readFile(e.path)
    } catch {
      continue
    }
    if (text.length > 200_000) continue
    const lines = text.split('\n')
    const wanted = [...(hitLines.get(e.path) || [])].sort((a, b) => a - b).slice(0, 6)
    const picked: number[] = []
    for (const ln of wanted) {
      if (picked.some((p) => Math.abs(p - ln) <= 4)) continue // overlapping context
      picked.push(ln)
      if (picked.length >= 3) break
    }
    if (!picked.length) picked.push(1)
    const snippets: CodeSnippet[] = []
    for (const ln of picked) {
      for (let i = Math.max(1, ln - 2); i <= Math.min(lines.length, ln + 2); i++) {
        snippets.push({ line: i, text: (lines[i - 1] || '').slice(0, 200) })
      }
    }
    const cost = e.path.length + snippets.reduce((n, s) => n + s.text.length + 8, 0)
    if (used + cost > maxChars) {
      truncated = true
      break
    }
    used += cost
    files.push({ path: e.path, score: e.score, snippets })
  }
  return { query, terms, files, truncated }
}
