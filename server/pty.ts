// Interactive terminals: node-pty sessions bridged to xterm.js over WebSocket.
// Sessions survive page reloads (scrollback replayed on reconnect).
import * as nodePty from 'node-pty'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import { WORKSPACE_ROOT } from './workspace'
import { publish } from './events'
import { interactiveShell, shellTitle } from './shell'

type Session = { id: string; title: string; cwd: string; pty: nodePty.IPty; buffer: string; clients: Set<WebSocket>; exited: boolean; createdAt: number }
const sessions = new Map<string, Session>()
let counter = 0
const SCROLLBACK = 200_000

export function listTerminals() {
  return [...sessions.values()].map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, exited: s.exited, createdAt: s.createdAt }))
}

export function createTerminal(cwd = WORKSPACE_ROOT, cols = 100, rows = 24) {
  const id = 't' + ++counter + Math.random().toString(36).slice(2, 5)
  const { shell, args } = interactiveShell()
  const pty = nodePty.spawn(shell, args, {
    name: 'xterm-256color', cols, rows, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'CursorWeb' } as any,
  })
  const s: Session = { id, title: `${shellTitle(shell)} ${counter}`, cwd, pty, buffer: '', clients: new Set(), exited: false, createdAt: Date.now() }
  pty.onData((d) => {
    s.buffer = (s.buffer + d).slice(-SCROLLBACK)
    for (const c of s.clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ t: 'o', d }))
  })
  pty.onExit(({ exitCode }) => {
    s.exited = true
    for (const c of s.clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ t: 'x', code: exitCode }))
    publish({ kind: 'terminals' })
    publish({ kind: 'fs', scope: 'main', change: 'unknown', path: '', source: 'terminal' })
  })
  sessions.set(id, s)
  publish({ kind: 'terminals' })
  return { id, title: s.title }
}

export function killTerminal(id: string) {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty.kill() } catch { /* already dead */ }
  for (const c of s.clients) c.close()
  sessions.delete(id)
  publish({ kind: 'terminals' })
}

export function attachTerminalServer(server: Server, authorize: (req: IncomingMessage) => boolean) {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x')
    const m = /^\/api\/terminals\/([^/]+)\/ws$/.exec(url.pathname)
    if (!m || !authorize(req)) { socket.destroy(); return }
    const s = sessions.get(m[1])
    if (!s) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      s.clients.add(ws)
      ws.send(JSON.stringify({ t: 'o', d: s.buffer }))
      if (s.exited) ws.send(JSON.stringify({ t: 'x', code: 0 }))
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw))
          if (msg.t === 'i' && !s.exited) s.pty.write(msg.d)
          else if (msg.t === 'r' && msg.cols > 0 && msg.rows > 0 && !s.exited) s.pty.resize(Math.min(500, msg.cols), Math.min(200, msg.rows))
        } catch { /* ignore */ }
      })
      ws.on('close', () => s.clients.delete(ws))
    })
  })
}

process.on('exit', () => { for (const s of sessions.values()) try { s.pty.kill() } catch { /* ignore */ } })
