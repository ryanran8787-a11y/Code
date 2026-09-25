import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { publish } from './events'

export const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE || path.join(process.cwd(), 'sample-workspace'))

const IGNORED = new Set(['node_modules', '.git', '.DS_Store', 'dist', '.wrangler', '.next', '__pycache__'])

export class PathError extends Error {}

/** Resolve a workspace-relative path and make sure it cannot escape the root. */
export function resolvePath(rel: string, root = WORKSPACE_ROOT): string {
  const clean = (rel || '').replace(/^\/+/, '')
  const abs = path.resolve(root, clean)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new PathError(`Path escapes workspace: ${rel}`)
  return abs
}

export function toRel(abs: string, root = WORKSPACE_ROOT) {
  return path.relative(root, abs).split(path.sep).join('/')
}

export type TreeNode = { name: string; path: string; type: 'file' | 'dir'; children?: TreeNode[] }

export async function readTree(rel = '', depth = 20): Promise<TreeNode[]> {
  const abs = resolvePath(rel)
  let entries: fss.Dirent[] = []
  try { entries = await fs.readdir(abs, { withFileTypes: true }) } catch { return [] }
  entries = entries.filter((e) => !IGNORED.has(e.name))
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
  const out: TreeNode[] = []
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push({ name: e.name, path: p, type: 'dir', children: depth > 0 ? await readTree(p, depth - 1) : [] })
    else out.push({ name: e.name, path: p, type: 'file' })
  }
  return out
}

export async function listFilesFlat(limit = 5000): Promise<string[]> {
  const res: string[] = []
  async function walk(rel: string) {
    if (res.length >= limit) return
    let entries: fss.Dirent[] = []
    try { entries = await fs.readdir(resolvePath(rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(p)
      else res.push(p)
      if (res.length >= limit) return
    }
  }
  await walk('')
  return res
}

export async function readFile(rel: string): Promise<string> {
  const abs = resolvePath(rel)
  const st = await fs.stat(abs)
  if (st.isDirectory()) throw new Error(`${rel} is a directory`)
  if (st.size > 2_000_000) throw new Error(`${rel} is too large (${st.size} bytes)`)
  return fs.readFile(abs, 'utf8')
}

export async function fileExists(rel: string) {
  try { await fs.access(resolvePath(rel)); return true } catch { return false }
}

export async function writeFile(rel: string, content: string, source = 'user') {
  const abs = resolvePath(rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const existed = fss.existsSync(abs)
  await fs.writeFile(abs, content, 'utf8')
  publish({ kind: 'fs', change: existed ? 'changed' : 'created', path: rel, source })
}

export async function deletePath(rel: string, source = 'user') {
  const abs = resolvePath(rel)
  if (abs === WORKSPACE_ROOT) throw new Error('Refusing to delete workspace root')
  await fs.rm(abs, { recursive: true, force: true })
  publish({ kind: 'fs', change: 'deleted', path: rel, source })
}

export async function makeDir(rel: string, source = 'user') {
  await fs.mkdir(resolvePath(rel), { recursive: true })
  publish({ kind: 'fs', change: 'created', path: rel, source })
}

export async function renamePath(from: string, to: string, source = 'user') {
  const a = resolvePath(from), b = resolvePath(to)
  await fs.mkdir(path.dirname(b), { recursive: true })
  await fs.rename(a, b)
  publish({ kind: 'fs', change: 'renamed', path: to, from, source })
}

export type SearchHit = { path: string; line: number; text: string }

/** Content search. Uses ripgrep when available, falls back to a JS scan. */
export async function searchText(query: string, opts: { regex?: boolean; caseSensitive?: boolean; include?: string; max?: number } = {}): Promise<SearchHit[]> {
  const max = opts.max ?? 200
  if (!query) return []
  const hits = await new Promise<SearchHit[] | null>((resolve) => {
    const args = ['--json', '--max-count', '50', '-g', '!node_modules', '-g', '!.git']
    if (!opts.regex) args.push('-F')
    if (!opts.caseSensitive) args.push('-i')
    if (opts.include) args.push('-g', opts.include)
    args.push('--', query, '.')
    let child
    try { child = spawn('rg', args, { cwd: WORKSPACE_ROOT }) } catch { return resolve(null) }
    const out: SearchHit[] = []
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try {
          const j = JSON.parse(line)
          if (j.type === 'match' && out.length < max) {
            out.push({ path: j.data.path.text.replace(/^\.\//, ''), line: j.data.line_number, text: (j.data.lines.text || '').replace(/\n$/, '').slice(0, 300) })
          }
        } catch { /* ignore */ }
      }
    })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(out))
  })
  if (hits) return hits
  // Fallback
  const files = await listFilesFlat()
  const res: SearchHit[] = []
  const re = opts.regex ? new RegExp(query, opts.caseSensitive ? '' : 'i') : null
  for (const f of files) {
    let text = ''
    try { text = await readFile(f) } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const ok = re ? re.test(l) : (opts.caseSensitive ? l.includes(query) : l.toLowerCase().includes(query.toLowerCase()))
      if (ok) { res.push({ path: f, line: i + 1, text: l.slice(0, 300) }); if (res.length >= max) return res }
    }
  }
  return res
}

export type ExecResult = { exitCode: number | null; output: string; timedOut: boolean }

/** Run a shell command in the workspace (non-interactive). */
export function runCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; onData?: (chunk: string) => void; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const cwd = resolvePath(opts.cwd || '')
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
    let output = ''
    let timedOut = false
    const LIMIT = 200_000
    const onChunk = (d: Buffer) => {
      const s = d.toString()
      if (output.length < LIMIT) output += s
      opts.onData?.(s)
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeoutMs ?? 60_000)
    const abort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', abort)
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      publish({ kind: 'fs', change: 'unknown', path: '', source: 'terminal' })
      resolve({ exitCode: code, output, timedOut })
    })
    child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: -1, output: String(err), timedOut }) })
  })
}
