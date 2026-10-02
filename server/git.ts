// Git integration: Source Control (status / diff / stage / commit / branches)
// and per-agent worktrees for isolated parallel work.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WORKSPACE_ROOT, Workspace, main } from './workspace'
import { publish } from './events'

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
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir') } catch { /* ignore */ }
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
  const out: { path: string; status: string }[] = []
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i]
    if (st.startsWith('R')) { out.push({ path: parts[i + 2], status: 'R' }); i += 2 } else { out.push({ path: parts[i + 1], status: st[0] }); i += 1 }
  }
  return out.filter((c) => c.path !== 'node_modules')
}

/** Commit the agent's work on its branch and apply the patch to the main working tree. */
export async function applyWorktree(info: WorktreeInfo, files?: string[], opts: { writeConflicts?: boolean } = {}) {
  const changes = await worktreeChanges(info)
  const pick = changes.filter((c) => !files || files.includes(c.path))
  if (!pick.length) return { applied: [] as string[], conflicts: [] as string[] }
  const applied: string[] = []
  const conflicts: string[] = []
  const os = await import('node:os')
  for (const c of pick) {
    const dest = path.join(WORKSPACE_ROOT, c.path)
    const src = path.join(info.dir, c.path)
    const baseContent = await showFile(c.path, info.base, info.dir)
    const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
    const mainContent = read(dest)
    const wtContent = c.status === 'D' ? null : read(src)
    if (mainContent === wtContent) { applied.push(c.path); continue } // already identical
    // main unchanged since the agent forked -> take the agent version directly
    if (mainContent === baseContent) {
      if (wtContent === null) fs.rmSync(dest, { force: true })
      else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest) }
      applied.push(c.path); continue
    }
    // both sides changed: real 3-way merge of text files
    if (mainContent !== null && wtContent !== null) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merge-'))
      const [fo, fb, ft] = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n))
      fs.writeFileSync(fo, mainContent); fs.writeFileSync(fb, baseContent ?? ''); fs.writeFileSync(ft, wtContent)
      const r = await git(['merge-file', '-p', '-L', 'workspace', '-L', 'base', '-L', `agent (${info.branch})`, fo, fb, ft], tmp)
      fs.rmSync(tmp, { recursive: true, force: true })
      if (r.code === 0) { fs.writeFileSync(dest, r.stdout); applied.push(c.path); continue }
      if (r.code > 0 && opts.writeConflicts) { fs.writeFileSync(dest, r.stdout); conflicts.push(c.path); continue } // leave <<<<<<< markers
    }
    conflicts.push(c.path)
  }
  for (const p of applied) main.emit({ change: 'changed', path: p, source: `agent:${info.agentId}` })
  publish({ kind: 'git' })
  return { applied, conflicts }
}

/** Throw away selected (or all) agent changes inside the worktree. */
export async function revertWorktree(info: WorktreeInfo, files?: string[]) {
  const ws = worktreeWorkspace(info)
  const changes = await worktreeChanges(info)
  for (const c of changes.filter((c) => !files || files.includes(c.path))) {
    const orig = await showFile(c.path, info.base, info.dir)
    if (orig === null) await ws.deletePath(c.path, 'git').catch(() => {})
    else await ws.writeFile(c.path, orig, 'git')
  }
  await git(['add', '-A'], info.dir)
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
