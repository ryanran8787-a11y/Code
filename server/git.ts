// Git integration: Source Control (status / diff / stage / commit / branches)
// and per-agent worktrees for isolated parallel work.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE_ROOT, Workspace, main } from './workspace'
import { publish } from './events'
import { symlinkType } from './shell'

export function git(args: string[], cwd = WORKSPACE_ROOT, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
    if (input !== undefined) { child.stdin?.write(input); child.stdin?.end() }
  })
}

async function must(args: string[], cwd = WORKSPACE_ROOT, input?: string) {
  const r = await git(args, cwd, input)
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`)
  return r.stdout
}

export async function isRepo(cwd = WORKSPACE_ROOT) {
  const r = await git(['rev-parse', '--show-toplevel'], cwd)
  return r.code === 0 && path.resolve(r.stdout.trim()) === path.resolve(cwd)
}

const IDENT = ['-c', 'user.name=CursorWeb', '-c', 'user.email=agent@cursorweb.local']

/** Make sure the workspace is a git repo with at least one commit (needed for worktrees). */
export async function ensureRepo() {
  if (!(await isRepo())) {
    await must(['init', '-b', 'main'])
    publish({ kind: 'git' })
  }
  ensureExclude()
  const head = await git(['rev-parse', '--verify', 'HEAD'])
  if (head.code !== 0) {
    await must(['add', '-A'])
    await must([...IDENT, 'commit', '--allow-empty', '-m', 'Initial commit'])
    publish({ kind: 'git' })
  }
}

function ensureExclude() {
  try {
    const f = path.join(WORKSPACE_ROOT, '.git', 'info', 'exclude')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    if (!cur.includes('.cursorweb-worktrees')) fs.appendFileSync(f, '\n.cursorweb-worktrees/\n')
  } catch { /* not a repo yet */ }
}

// ---------------------------------------------------------------- status
export type StatusEntry = { path: string; from?: string; index: string; work: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean }

export async function status(cwd = WORKSPACE_ROOT) {
  if (!(await isRepo(cwd))) return { repo: false as const }
  const r = await must(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], cwd)
  const parts = r.split('\0')
  let branch = '', ahead = 0, behind = 0, upstream = ''
  const entries: StatusEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?,? ?(?:behind (\d+))?\])?/.exec(p)
      branch = m?.[1] || ''; upstream = m?.[2] || ''; ahead = +(m?.[3] || 0); behind = +(m?.[4] || 0)
      continue
    }
    const x = p[0], y = p[1]
    const file = p.slice(3)
    let from: string | undefined
    if (x === 'R' || x === 'C') { from = parts[++i] }
    if (file.startsWith('.cursorweb-worktrees/')) continue
    const untracked = x === '?'
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    entries.push({ path: file, from, index: x, work: y, untracked, conflicted, staged: !untracked && x !== ' ' && !conflicted, unstaged: untracked || (y !== ' ' && !conflicted) })
  }
  const log = await git(['log', '-n', '15', '--pretty=format:%h%x09%an%x09%ar%x09%s'], cwd)
  const commits = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map((l) => { const [hash, author, when, ...s] = l.split('\t'); return { hash, author, when, subject: s.join('\t') } }) : []
  return { repo: true as const, branch, upstream, ahead, behind, entries, commits }
}

/** Content of a file at HEAD (or index with ':'), '' if it doesn't exist there. */
export async function showFile(p: string, ref = 'HEAD', cwd = WORKSPACE_ROOT) {
  const r = await git(['show', `${ref}:${p}`], cwd)
  return r.code === 0 ? r.stdout : null
}

export async function stage(paths: string[]) { await must(['add', '-A', '--', ...paths]); publish({ kind: 'git' }) }
export async function unstage(paths: string[]) {
  const head = await git(['rev-parse', '--verify', 'HEAD'])
  if (head.code === 0) await must(['reset', '-q', 'HEAD', '--', ...paths])
  else await must(['rm', '--cached', '-r', '-q', '--', ...paths])
  publish({ kind: 'git' })
}
export async function discard(paths: string[]) {
  const st = await status()
  if (!st.repo) return
  for (const p of paths) {
    const e = st.entries.find((x) => x.path === p)
    if (e?.untracked || e?.index === 'A') { await main.deletePath(p, 'git').catch(() => {}); if (e.index === 'A') await git(['rm', '--cached', '-q', '--', p]) }
    else await must(['checkout', 'HEAD', '--', p])
    main.emit({ change: 'changed', path: p, source: 'git' })
  }
  publish({ kind: 'git' })
}
export async function commit(message: string, all = false) {
  if (!message.trim()) throw new Error('Commit message required')
  if (all) await must(['add', '-A'])
  const out = await must([...IDENT, 'commit', '-m', message])
  publish({ kind: 'git' })
  return out
}
export async function branches() {
  const r = await git(['branch', '--format=%(refname:short)%09%(HEAD)'])
  return r.stdout.split('\n').filter(Boolean).map((l) => { const [name, head] = l.split('\t'); return { name, current: head === '*' } })
}
export async function checkout(branch: string, create = false) {
  await must(create ? ['checkout', '-b', branch] : ['checkout', branch])
  main.emit({ change: 'unknown', path: '', source: 'git' })
  publish({ kind: 'git' })
}

/** Raw bytes of a file at a ref; null when absent. Binary-safe (unlike showFile). */
export function gitBytes(args: string[], cwd = WORKSPACE_ROOT): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err: any, stdout) => {
      if (err) return resolve(null)
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as any))
    })
  })
}

async function showFileBytes(p: string, ref: string, cwd = WORKSPACE_ROOT): Promise<Buffer | null> {
  return gitBytes(['show', `${ref}:${p}`], cwd)
}

/** Heuristic binary check: NUL byte in the first 8KB. */
export function isBinary(buf: Buffer | null): boolean {
  if (!buf) return false
  return buf.subarray(0, 8000).includes(0)
}

// Serialize apply/revert per agent so parallel resolves can't interleave (TOCTOU).
const mergeLocks = new Map<string, Promise<any>>()
function withWorktreeLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = mergeLocks.get(agentId) || Promise.resolve()
  const next = (prev as Promise<any>).then(fn, fn)
  mergeLocks.set(agentId, next.catch(() => {}))
  return next
}

// ---------------------------------------------------------------- worktrees
const WT_DIR = path.join(WORKSPACE_ROOT, '.cursorweb-worktrees')

export type WorktreeInfo = { agentId: string; dir: string; branch: string; base: string }

export async function createWorktree(agentId: string, slug: string): Promise<WorktreeInfo> {
  await ensureRepo()
  const base = (await must(['rev-parse', 'HEAD'])).trim()
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task'
  const branch = `agent/${safe}-${agentId.slice(0, 6)}`
  const dir = path.join(WT_DIR, agentId)
  fs.mkdirSync(WT_DIR, { recursive: true })
  await must(['worktree', 'add', '-b', branch, dir, base])
  // carry over the user's uncommitted work so the agent starts from what they see
  const diff = await git(['diff', 'HEAD', '--binary'])
  if (diff.stdout.trim()) await git(['apply', '--whitespace=nowarn'], dir, diff.stdout)
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter((f) => f && !f.startsWith('.cursorweb-worktrees/'))
  for (const f of untracked) {
    try { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.copyFileSync(path.join(WORKSPACE_ROOT, f), path.join(dir, f)) } catch { /* skip */ }
  }
  // snapshot starting point so later we can diff only the agent's changes
  await git(['add', '-A'], dir)
  const hasChanges = (await git(['diff', '--cached', '--quiet'], dir)).code !== 0
  if (hasChanges) await must([...IDENT, 'commit', '-q', '-m', 'CursorWeb: snapshot of workspace before agent run'], dir)
  const start = (await must(['rev-parse', 'HEAD'], dir)).trim()
  // symlink node_modules so builds/tests work without reinstalling
  const nm = path.join(WORKSPACE_ROOT, 'node_modules')
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), symlinkType()) } catch { /* ignore */ }
  publish({ kind: 'git' })
  return { agentId, dir, branch, base: start }
}

export function worktreeWorkspace(info: WorktreeInfo) { return new Workspace(info.dir, `wt:${info.agentId}`) }

/** Files changed by the agent in its worktree relative to its starting snapshot. */
export async function worktreeChanges(info: WorktreeInfo) {
  if (!fs.existsSync(info.dir)) return []
  await git(['add', '-A', '--', '.', ':!node_modules'], info.dir)
  const r = await git(['diff', '--cached', '--name-status', '-z', info.base], info.dir)
  const parts = r.stdout.split('\0').filter(Boolean)
  const out: { path: string; from?: string; status: string }[] = []
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i]
    if (st.startsWith('R')) { out.push({ from: parts[i + 1], path: parts[i + 2], status: 'R' }); i += 2 } else { out.push({ path: parts[i + 1], status: st[0] }); i += 1 }
  }
  return out.filter((c) => c.path !== 'node_modules')
}

type MergeOp =
  | { kind: 'skip'; path: string }
  | { kind: 'write'; path: string; content: Buffer }
  | { kind: 'remove'; path: string }
  | { kind: 'merged'; path: string; content: Buffer }
  | { kind: 'conflict'; path: string; merged?: Buffer }

/** Copy bytes, preserving symlink-ness and permission bits. */
function copyWithMeta(src: string, dest: string) {
  const st = fs.lstatSync(src)
  fs.rmSync(dest, { recursive: true, force: true })
  if (st.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.symlinkSync(fs.readlinkSync(src), dest, symlinkType())
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  try { fs.chmodSync(dest, st.mode) } catch { /* best effort */ }
}

function readBytes(f: string): Buffer | null {
  try {
    if (fs.lstatSync(f).isSymbolicLink()) return Buffer.from('symlink:' + fs.readlinkSync(f))
    return fs.readFileSync(f)
  } catch {
    return null
  }
}

const sameBytes = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b))

// --- line-ending handling -------------------------------------------------
// Windows checkouts often materialize CRLF while git blobs (and agent-written
// files) are LF. Comparing raw bytes would flag every line as changed, so
// TEXT comparisons and merges run on LF-normalized content, while writes keep
// the main working file's prevailing style (no full-file EOL churn).
function detectEol(s: string): '\r\n' | '\n' {
  const crlf = (s.match(/\r\n/g) || []).length
  const lf = (s.match(/(?<!\r)\n/g) || []).length
  return crlf > lf ? '\r\n' : '\n'
}
const toLF = (s: string) => s.replace(/\r\n/g, '\n')
const toEol = (s: string, eol: '\r\n' | '\n') => (eol === '\r\n' ? s.replace(/(?<!\r)\n/g, '\r\n') : s)
type TextDoc = { lf: string; eol: '\r\n' | '\n' }
function asText(b: Buffer | null): TextDoc | null {
  if (b === null) return null
  const s = b.toString('utf8')
  return { lf: toLF(s), eol: detectEol(s) }
}

/** Commit the agent's work on its branch and apply the patch to the main working tree. */
export async function applyWorktree(info: WorktreeInfo, files?: string[], opts: { writeConflicts?: boolean } = {}) {
  return withWorktreeLock(info.agentId, async () => {
    const changes = await worktreeChanges(info)
    const pick = changes.filter((c) => !files || files.includes(c.path))
    if (!pick.length) return { applied: [] as string[], conflicts: [] as string[] }

    // Phase 1 (read-only): decide every file first so one bad file can't
    // leave a half-applied workspace.
    const ops: MergeOp[] = []
    const tmps: string[] = []
    try {
      const os = await import('node:os')
      for (const c of pick) {
        const dest = path.join(WORKSPACE_ROOT, c.path)
        const src = path.join(info.dir, c.path)
        const baseContent = await showFileBytes(c.from ?? c.path, info.base, info.dir)
        const mainContent = readBytes(dest)
        const wtContent = c.status === 'D' ? null : readBytes(src)
        if (sameBytes(mainContent, wtContent)) { ops.push({ kind: 'skip', path: c.path }); continue }
        const mainBase = readBytes(path.join(WORKSPACE_ROOT, c.from ?? c.path))
        const binaryLane = isBinary(mainContent) || isBinary(wtContent) || isBinary(baseContent) || isBinary(mainBase)
        if (!binaryLane) {
          // ---- text lane: compare/merge on LF, write back in main's style ----
          const mainT = asText(mainContent)
          const wtT = asText(wtContent)
          const baseT = asText(baseContent)
          const mainBaseT = asText(mainBase)
          if ((mainT?.lf ?? null) === (wtT?.lf ?? null)) { ops.push({ kind: 'skip', path: c.path }); continue }
          if ((mainBaseT?.lf ?? null) === (baseT?.lf ?? null)) {
            if (wtT === null) ops.push({ kind: 'remove', path: c.path })
            else {
              // fast-forwarding a creation (new file or rename target) while
              // main independently created the same path -> real conflict.
              const isCreate = baseT === null || (c.status === 'R' && c.from && c.from !== c.path)
              if (isCreate && mainT !== null) { ops.push({ kind: 'conflict', path: c.path }); continue }
              if (c.status === 'R' && c.from && c.from !== c.path) ops.push({ kind: 'remove', path: c.from }) // drop the old name on rename
              ops.push({ kind: 'write', path: c.path, content: Buffer.from(toEol(wtT.lf, mainT?.eol ?? wtT.eol), 'utf8') })
            }
            continue
          }
          if (mainT !== null && wtT !== null) {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merge-'))
            tmps.push(tmp)
            const [fo, fb, ft] = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n))
            fs.writeFileSync(fo, mainT.lf)
            fs.writeFileSync(fb, baseT?.lf ?? '')
            fs.writeFileSync(ft, wtT.lf)
            const r = await git(['merge-file', '-p', '-L', 'workspace', '-L', 'base', '-L', `agent (${info.branch})`, fo, fb, ft], tmp)
            const out = Buffer.from(toEol(r.stdout, mainT.eol), 'utf8')
            if (r.code === 0) { ops.push({ kind: 'merged', path: c.path, content: out }); continue }
            if (r.code > 0 && opts.writeConflicts) { ops.push({ kind: 'conflict', path: c.path, merged: out }); continue }
          }
          ops.push({ kind: 'conflict', path: c.path })
          continue
        }
        // ---- binary lane: byte-exact, fast-forward or conflict, never merged ----
        if (sameBytes(mainBase, baseContent)) {
          if (wtContent === null) ops.push({ kind: 'remove', path: c.path })
          else {
            const isCreate = baseContent === null || (c.status === 'R' && c.from && c.from !== c.path)
            if (isCreate && mainContent !== null && !sameBytes(mainContent, wtContent)) { ops.push({ kind: 'conflict', path: c.path }); continue }
            if (c.status === 'R' && c.from && c.from !== c.path) ops.push({ kind: 'remove', path: c.from })
            ops.push({ kind: 'write', path: c.path, content: wtContent })
          }
          continue
        }
        ops.push({ kind: 'conflict', path: c.path })
      }
    } finally {
      for (const t of tmps) fs.rmSync(t, { recursive: true, force: true })
    }

    // Phase 2: snapshot main versions so a mid-apply failure rolls back.
    type Snap = { existed: boolean; buf: Buffer | null; mode: number; link: string | null }
    const snaps = new Map<string, Snap>()
    const snap = (p: string) => {
      if (snaps.has(p)) return
      try {
        const st = fs.lstatSync(path.join(WORKSPACE_ROOT, p))
        snaps.set(p, {
          existed: true, mode: st.mode,
          link: st.isSymbolicLink() ? fs.readlinkSync(path.join(WORKSPACE_ROOT, p)) : null,
          buf: st.isSymbolicLink() ? null : fs.readFileSync(path.join(WORKSPACE_ROOT, p)),
        })
      } catch {
        snaps.set(p, { existed: false, buf: null, mode: 0o644, link: null })
      }
    }
    const applied: string[] = []
    const conflicts: string[] = []
    const restore = () => {
      for (const [p, s] of snaps) {
        const dest = path.join(WORKSPACE_ROOT, p)
        try {
          fs.rmSync(dest, { recursive: true, force: true })
          if (!s.existed) continue
          if (s.link !== null) fs.symlinkSync(s.link, dest, symlinkType())
          else {
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, s.buf!)
            try { fs.chmodSync(dest, s.mode) } catch { /* best effort */ }
          }
        } catch { /* best effort rollback */ }
      }
    }
    try {
      for (const op of ops) {
        if (op.kind === 'skip') { applied.push(op.path); continue }
        if (op.kind === 'conflict' && !op.merged) { conflicts.push(op.path); continue }
        snap(op.path)
        if (op.kind === 'remove') {
          fs.rmSync(path.join(WORKSPACE_ROOT, op.path), { recursive: true, force: true })
          applied.push(op.path)
        } else if (op.kind === 'write') {
          const src = path.join(info.dir, op.path)
          try {
            const st = fs.lstatSync(src)
            if (st.isSymbolicLink()) {
              const dest = path.join(WORKSPACE_ROOT, op.path)
              fs.rmSync(dest, { recursive: true, force: true })
              fs.mkdirSync(path.dirname(dest), { recursive: true })
              fs.symlinkSync(fs.readlinkSync(src), dest, symlinkType())
            } else copyWithMeta(src, path.join(WORKSPACE_ROOT, op.path))
          } catch {
            // worktree file vanished mid-apply: fall back to buffered bytes
            const dest = path.join(WORKSPACE_ROOT, op.path)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, (op as { content: Buffer }).content)
          }
          applied.push(op.path)
        } else {
          // merged / conflict-with-markers
          const dest = path.join(WORKSPACE_ROOT, op.path)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, (op as { content?: Buffer; merged?: Buffer }).content ?? (op as any).merged)
          if (op.kind === 'conflict') conflicts.push(op.path)
          else applied.push(op.path)
        }
      }
    } catch (e) {
      restore()
      throw e
    }
    for (const p of applied) main.emit({ change: 'changed', path: p, source: `agent:${info.agentId}` })
    publish({ kind: 'git' })
    return { applied, conflicts }
  })
}

/** Throw away selected (or all) agent changes inside the worktree. */
export async function revertWorktree(info: WorktreeInfo, files?: string[]) {
  return withWorktreeLock(info.agentId, async () => {
    const w = worktreeWorkspace(info)
    const changes = await worktreeChanges(info)
    for (const c of changes.filter((c) => !files || files.includes(c.path))) {
      // renames: drop the new name, restore under the old one
      if (c.status === 'R' && c.from && c.from !== c.path) await w.deletePath(c.path, 'git').catch(() => {})
      const target = c.status === 'R' && c.from ? c.from : c.path
      const orig = await showFileBytes(c.from ?? c.path, info.base, info.dir)
      if (orig === null) await w.deletePath(target, 'git').catch(() => {})
      else {
        // byte-exact restore (the old string-based write corrupted binaries)
        const dest = path.join(info.dir, target)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, orig)
        w.emit({ change: 'changed', path: target, source: 'git' })
      }
    }
    await git(['add', '-A'], info.dir)
  })
}

export async function removeWorktree(info: WorktreeInfo, deleteBranch = true) {
  await git(['worktree', 'remove', '--force', info.dir])
  if (fs.existsSync(info.dir)) fs.rmSync(info.dir, { recursive: true, force: true })
  await git(['worktree', 'prune'])
  if (deleteBranch) await git(['branch', '-D', info.branch])
  publish({ kind: 'git' })
}

/** Commit the agent's changes on its own branch (keeps the worktree). */
export async function commitWorktree(info: WorktreeInfo, message: string) {
  await git(['add', '-A', '--', '.', ':!node_modules'], info.dir)
  const r = await git([...IDENT, 'commit', '-m', message], info.dir)
  publish({ kind: 'git' })
  return r.code === 0
}
