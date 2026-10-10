// Long-running background processes (dev servers, watchers…) started by agents
// or the user. Output is kept in a ring buffer; detected localhost ports are
// surfaced so the integrated browser can open them.
import { spawn, ChildProcess, execFileSync } from 'node:child_process'
import { publish } from './events'
import { shellForCommand, killTree, isWindows, powershellExe, netstatExe } from './shell'

export type Proc = {
  id: string
  command: string
  cwd: string
  owner: string // 'user' | agentId
  pid?: number
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
  ports: number[]
  output: string
  child?: ChildProcess
}

const procs = new Map<string, Proc>()
const MAX = 100_000

const uid = () => 'p' + Math.random().toString(36).slice(2, 8)

function summary(p: Proc) {
  const { child, output, ...rest } = p
  return { ...rest, tail: output.slice(-2000) }
}

export function list() { return [...procs.values()].sort((a, b) => b.startedAt - a.startedAt).map(summary) }
export function get(id: string) { return procs.get(id) }

export function start(command: string, cwd: string, owner = 'user') {
  const p: Proc = { id: uid(), command, cwd, owner, status: 'running', exitCode: null, startedAt: Date.now(), ports: [], output: '' }
  const { cmd, args } = shellForCommand(command)
  // NOTE: detached:true breaks stdout pipes on Windows (child gets its own
  // console and output is lost), so only detach on POSIX where group-kill
  // needs it. Windows tree-kill is handled by taskkill /T in killTree.
  const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none', CI: '1' }, detached: !isWindows, windowsHide: true })
  p.child = child
  p.pid = child.pid
  const onData = (d: Buffer) => {
    const s = d.toString()
    p.output = (p.output + s).slice(-MAX)
    for (const m of s.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})|(?:port|PORT)\s*:?\s*(\d{4,5})|\(https?:\/\/[\w.\[\]:]+:(\d{2,5})/g)) {
      const port = +(m[1] || m[2] || m[3])
      if (port !== +(process.env.PORT || 3000) && !p.ports.includes(port)) { p.ports.push(port); publish({ kind: 'proc', proc: summary(p) }) }
    }
    publish({ kind: 'proc.output', id: p.id, data: s })
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  // also discover ports by scanning the process tree's listening sockets
  // (Linux: /proc/net/tcp, Windows: netstat -ano; other platforms: log regex only)
  const scan = setInterval(() => { if (p.status !== 'running') return clearInterval(scan); for (const port of listeningPorts(p.pid!)) if (!p.ports.includes(port)) { p.ports.push(port); publish({ kind: 'proc', proc: summary(p) }) } }, 1500)
  child.on('exit', (code) => { p.status = 'exited'; p.exitCode = code; p.child = undefined; publish({ kind: 'proc', proc: summary(p) }) })
  child.on('error', (e) => { p.output += String(e); p.status = 'exited'; publish({ kind: 'proc', proc: summary(p) }) })
  procs.set(p.id, p)
  publish({ kind: 'proc', proc: summary(p) })
  return p
}

export function stop(id: string) {
  const p = procs.get(id)
  if (!p) throw new Error('No such process: ' + id)
  if (p.child && p.pid) {
    killTree(p.pid, p.child, 'SIGTERM')
    setTimeout(() => { if (p.status === 'running') killTree(p.pid, p.child, 'SIGKILL' as any) }, 3000)
  }
  return summary(p)
}

export function remove(id: string) {
  const p = procs.get(id)
  if (p?.status === 'running') stop(id)
  procs.delete(id)
  publish({ kind: 'proc.removed', id })
}

export function waitFor(id: string, ms: number) {
  return new Promise<void>((res) => {
    const p = procs.get(id)
    if (!p) return res()
    const t = setTimeout(res, ms)
    p.child?.once('exit', () => { clearTimeout(t); res() })
  })
}

  process.on('exit', () => { for (const p of procs.values()) if (p.pid && p.status === 'running') killTree(p.pid, p.child, 'SIGKILL' as any) })

import fs from 'node:fs'
function descendants(pid: number): number[] {
  const out = [pid]
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; if (out.includes(ppid) && !out.includes(+d)) out.push(+d) } catch { /* gone */ }
    }
  } catch { /* no procfs */ }
  return out
}
function listeningPorts(pid: number): number[] {
  if (!pid) return []
  if (process.platform === 'win32') return listeningPortsWindows(pid)
  if (process.platform !== 'linux') return []
  const inodes = new Set<string>()
  for (const p of descendants(pid)) {
    try { for (const fd of fs.readdirSync(`/proc/${p}/fd`)) { try { const l = fs.readlinkSync(`/proc/${p}/fd/${fd}`); const m = /^socket:\[(\d+)\]$/.exec(l); if (m) inodes.add(m[1]) } catch { /* */ } } } catch { /* */ }
  }
  const ports: number[] = []
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c[3] === '0A' && inodes.has(c[9])) { const port = parseInt(c[1].split(':').pop()!, 16); if (port !== +(process.env.PORT || 3000) && !ports.includes(port)) ports.push(port) }
      }
    } catch { /* */ }
  }
  return ports
}

// ---- Windows: netstat -ano + Win32_Process tree ---------------------------
// netstat localizes the state column (LISTENING) on non-English systems, so a
// listening TCP socket is identified locale-independently by its foreign
// address being 0.0.0.0:0 / [::]:0 (only listeners have a zero foreign port).
function descendantsWindows(pid: number): number[] {
  const out = [pid]
  try {
    const raw = execFileSync(powershellExe(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { timeout: 8000, windowsHide: true }).toString()
    const parsed = JSON.parse(raw)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const kids = new Map<number, number[]>()
    for (const p of arr) {
      const c = +p.ProcessId, par = +p.ParentProcessId
      if (!kids.has(par)) kids.set(par, [])
      kids.get(par)!.push(c)
    }
    const queue = [pid]
    while (queue.length) {
      const cur = queue.pop()!
      for (const k of kids.get(cur) || []) if (!out.includes(k)) { out.push(k); queue.push(k) }
    }
  } catch { /* fall back to just pid */ }
  return out
}

function listeningPortsWindows(pid: number): number[] {
  const tree = new Set(descendantsWindows(pid))
  const ports: number[] = []
  const appPort = +(process.env.PORT || 3000)
  try {
    const raw = execFileSync(netstatExe(), ['-ano', '-p', 'TCP'], { timeout: 8000, windowsHide: true }).toString()
    for (const line of raw.split('\n')) {
      const c = line.trim().split(/\s+/)
      // columns: PROTO LOCAL FOREIGN STATE PID (STATE text varies by locale)
      if (c.length < 5 || c[0] !== 'TCP') continue
      const owner = +c[c.length - 1]
      if (!Number.isInteger(owner) || !tree.has(owner)) continue
      const foreign = c[c.length - 3]
      if (!/:(0|\*)$/.test(foreign)) continue // only listeners have a zero foreign port
      const local = c[1]
      const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 10)
      if (!port || port === appPort || ports.includes(port)) continue
      ports.push(port)
    }
  } catch { /* netstat unavailable */ }
  return ports
}
