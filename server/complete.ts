// Tab (ghost-text) completion + Ctrl+K inline edit backend. Both are
// single-shot, low-temperature calls; both return null instead of guessing.
import { getSettings } from './settings'
import { client } from './agent'
import { commentFor } from './mock'

export type CompleteOpts = { path: string; language: string; prefix: string; suffix: string }

/** Remove ``` fences some models wrap completions in; cap size. */
export function cleanCompletion(text: string): string | null {
  let t = (text || '').replace(/\r\n/g, '\n')
  const fence = /^```[\w+-]*\n([\s\S]*?)\n```\s*$/.exec(t.trim())
  if (fence) t = fence[1]
  // drop leading blank lines the model sometimes adds
  t = t.replace(/^(?:[ \t]*\n)+/, '').replace(/[ \t]+$/gm, (m) => (m.includes('\n') ? m : ''))
  t = t.trimEnd()
  if (!t) return null
  const lines = t.split('\n')
  if (lines.length > 20) t = lines.slice(0, 20).join('\n')
  if (t.length > 1500) t = t.slice(0, 1500)
  return t || null
}

function lastLine(prefix: string): string {
  const i = prefix.lastIndexOf('\n')
  return i < 0 ? prefix : prefix.slice(i + 1)
}

/** Offline heuristic for Base URL "mock": only fires on high-confidence patterns. */
export function mockComplete(prefix: string): string | null {
  const line = lastLine(prefix)
  if (/console\.$/.test(line)) return 'log();'
  if (/(?:^|[\s=(,])print\($/.test(line)) return ')'
  // unclosed call on this line, e.g. `foo(bar` -> `)`
  const opens = (line.match(/\(/g) || []).length
  const closes = (line.match(/\)/g) || []).length
  if (/[(\[{,]\s*$/.test(line) && opens <= closes) return null
  if (/[^\s(]\($/.test(line)) return ')'
  return null
}

export async function tabComplete(opts: CompleteOpts): Promise<string | null> {
  const s = getSettings()
  const pre = opts.prefix.slice(-6000)
  const suf = opts.suffix.slice(0, 2000)
  if (!pre.trim()) return null
  if (s.baseUrl.startsWith('mock')) return mockComplete(pre)
  const lang = opts.language || 'text'
  try {
    const r: any = await client().chat.completions.create({
      model: s.defaultModel,
      temperature: 0,
      max_tokens: 256,
      messages: [
        {
          role: 'system',
          content:
            'You are a code completion engine. Output ONLY the exact text that should be inserted at <cursor> — no explanations, no code fences, no leading/trailing commentary. Complete at most one logical block. If no confident completion exists, output nothing.',
        },
        {
          role: 'user',
          content: `File: ${opts.path || '(untitled)'}\nLanguage: ${lang}\n\n<before>\n${pre}\n</before>\n<cursor/>\n<after>\n${suf}\n</after>`,
        },
      ],
    })
    return cleanCompletion(r.choices?.[0]?.message?.content ?? '')
  } catch {
    return null
  }
}

export type EditOpts = { path: string; language: string; context: string; selection: string; instruction: string }

/** Ctrl+K inline edit: rewrite `selection` per `instruction`. Returns replacement or null. */
export async function inlineEdit(opts: EditOpts): Promise<string | null> {
  const sel = opts.selection || ''
  if (!opts.instruction.trim() || !sel.trim()) return null
  const s = getSettings()
  if (s.baseUrl.startsWith('mock')) {
    const cm = commentFor(opts.path)
    return cm ? `${sel.trimEnd()}\n${cm}` : null
  }
  try {
    const r: any = await client().chat.completions.create({
      model: s.defaultModel,
      temperature: 0,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'You are an inline code editor. Output ONLY the replacement code for <selection> — no explanations, no code fences. Preserve the existing style and indentation. Keep the change minimal and confined to the selection.',
        },
        {
          role: 'user',
          content: `File: ${opts.path || '(untitled)'}\nLanguage: ${opts.language || 'text'}\n\n<context>\n${opts.context.slice(-4000)}\n</context>\n<selection>\n${sel.slice(0, 4000)}\n</selection>\n\nInstruction: ${opts.instruction}`,
        },
      ],
    })
    return cleanCompletion(r.choices?.[0]?.message?.content ?? '')
  } catch {
    return null
  }
}
