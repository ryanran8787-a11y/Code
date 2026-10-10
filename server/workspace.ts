import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { publish } from './events'
import { shellForCommand } from './shell'

export const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE || path.join(process.cwd(), 'workspace'))
// First run without an explicit WORKSPACE: seed ./workspace from the bundled example project.
if (!process.env.WORKSPACE && !fss.existsSync(WORKSPACE_ROOT)) {
  const tpl = path.join(process.cwd(), 'examples', 'todo-app')
  if (fss.existsSync(tpl)) fss.cpSync(tpl, WORKSPACE_ROOT, { recursive: true })
  else fss.mkdirSync(WORKSPACE_ROOT, { recursive: true })
}

export const IGNORED = new Set(['node_modules', '.git', '.DS_Store', 'dist', '.wrangler', '.next', '__pycache__', '.cursorweb-worktrees'])

export class PathError extends Error {}

export type TreeNode = { name: string; path: string; type: 'file' | 'dir'; children?: TreeNode[] }
export type SearchHit = { path: string; line: number; text: string }
export type ExecResult = { exitCode: number | null; output: string; timedOut: boolean }

/**
 * A file-system root the IDE / an agent operates on. The main workspace is one
 * instance; every agent running in an isolated git worktree gets its own.
 * `scope` is attached to fs events so clients know which tree changed
 * ('main' or 'wt:<agentId>').
 */
export class Workspace {
  constructor(public root: string, public scope = 'main') {}

  resolve(rel: string): string {
    const clean = (rel || '').replace(/^\/+/, '')
    const abs = path.resolve(this.root, clean)
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new PathError(`Path escapes workspace: ${rel}`)
    return abs
  }

  toRel(abs: string) { return path.relative(this.root, abs).split(path.sep).join('/') }

  emit(e: any) { publish({ kind: 'fs', scope: this.scope, ...e }) }

  async readTree(rel = '', depth = 20): Promise<TreeNode[]> {
    const abs = this.resolve(rel)
    let entries: fss.Dirent[] = []
    try { entries = await fs.readdir(abs, { withFileTypes: true }) } catch { return [] }
    entries = entries.filter((e) => !IGNORED.has(e.name))
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    const out: TreeNode[] = []
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) out.push({ name: e.name, path: p, type: 'dir', children: depth > 0 ? await this.readTree(p, depth - 1) : [] })
      else out.push({ name: e.name, path: p, type: 'file' })
    }
    return out
  }

  async listFilesFlat(limit = 5000, dirs = false): Promise<string[]> {
    const res: string[] = []
    const walk = async (rel: string) => {
      if (res.length >= limit) return
      let entries: fss.Dirent[] = []
      try { entries = await fs.readdir(this.resolve(rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (IGNORED.has(e.name)) continue
        const p = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (dirs) res.push(p + '/'); await walk(p) } else res.push(p)
        if (res.length >= limit) return
      }
    }
    await walk('')
    return res
  }

  async readFile(rel: string): Promise<string> {
    const abs = this.resolve(rel)
    const st = await fs.stat(abs)
    if (st.isDirectory()) throw new Error(`${rel} is a directory`)
    if (st.size > 2_000_000) throw new Error(`${rel} is too large (${st.size} bytes)`)
    return fs.readFile(abs, 'utf8')
  }

  async fileExists(rel: string) {
    try { await fs.access(this.resolve(rel)); return true } catch { return false }
  }

  async writeFile(rel: string, content: string, source = 'user') {
    const abs = this.resolve(rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const existed = fss.existsSync(abs)
    await fs.writeFile(abs, content, 'utf8')
    this.emit({ change: existed ? 'changed' : 'created', path: rel, source })
  }

  async deletePath(rel: string, source = 'user') {
    const abs = this.resolve(rel)
    if (abs === this.root) throw new Error('Refusing to delete workspace root')
    await fs.rm(abs, { recursive: true, force: true })
    this.emit({ change: 'deleted', path: rel, source })
  }

  async makeDir(rel: string, source = 'user') {
    await fs.mkdir(this.resolve(rel), { recursive: true })
    this.emit({ change: 'created', path: rel, source })
  }

  async renamePath(from: string, to: string, source = 'user') {
    const a = this.resolve(from), b = this.resolve(to)
    await fs.mkdir(path.dirname(b), { recursive: true })
    await fs.rename(a, b)
    this.emit({ change: 'renamed', path: to, from, source })
  }

  /** Content search. Uses ripgrep when available, falls back to a JS scan. */
  async searchText(query: string, opts: { regex?: boolean; caseSensitive?: boolean; include?: string; max?: number } = {}): Promise<SearchHit[]> {
    const max = opts.max ?? 200
    if (!query) return []
    const hits = await new Promise<SearchHit[] | null>((resolve) => {
      const args = ['--json', '--max-count', '50', '-g', '!node_modules', '-g', '!.git', '-g', '!.cursorweb-worktrees']
      if (!opts.regex) args.push('-F')
      if (!opts.caseSensitive) args.push('-i')
      if (opts.include) args.push('-g', opts.include)
      args.push('--', query, '.')
      let child
      try { child = spawn('rg', args, { cwd: this.root }) } catch { return resolve(null) }
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
    const files = await this.listFilesFlat()
    const res: SearchHit[] = []
    const re = opts.regex ? new RegExp(query, opts.caseSensitive ? '' : 'i') : null
    for (const f of files) {
      let text = ''
      try { text = await this.readFile(f) } catch { continue }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        const ok = re ? re.test(l) : (opts.caseSensitive ? l.includes(query) : l.toLowerCase().includes(query.toLowerCase()))
        if (ok) { res.push({ path: f, line: i + 1, text: l.slice(0, 300) }); if (res.length >= max) return res }
      }
    }
    return res
  }

  /** Run a shell command (non-interactive). */
  runCommand(command: string, opts: { cwd?: string; timeoutMs?: number; onData?: (chunk: string) => void; signal?: AbortSignal } = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const cwd = this.resolve(opts.cwd || '')
      const { cmd, args } = shellForCommand(command)
      const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
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
        this.emit({ change: 'unknown', path: '', source: 'terminal' })
        resolve({ exitCode: code, output, timedOut })
      })
      child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: -1, output: String(err), timedOut }) })
    })
  }
}

export const main = new Workspace(WORKSPACE_ROOT, 'main')

// ---- backwards-compatible function exports bound to the main workspace ----
export const resolvePath = (rel: string) => main.resolve(rel)
export const toRel = (abs: string) => main.toRel(abs)
export const readTree = (rel = '', depth = 20) => main.readTree(rel, depth)
export const listFilesFlat = (limit = 5000, dirs = false) => main.listFilesFlat(limit, dirs)
export const readFile = (rel: string) => main.readFile(rel)
export const fileExists = (rel: string) => main.fileExists(rel)
export const writeFile = (rel: string, content: string, source = 'user') => main.writeFile(rel, content, source)
export const deletePath = (rel: string, source = 'user') => main.deletePath(rel, source)
export const makeDir = (rel: string, source = 'user') => main.makeDir(rel, source)
export const renamePath = (from: string, to: string, source = 'user') => main.renamePath(from, to, source)
export const searchText = (q: string, o?: any) => main.searchText(q, o)
export const runCommand = (c: string, o?: any) => main.runCommand(c, o)
