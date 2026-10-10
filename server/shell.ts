// Cross-platform shell helpers (S1: Windows usability).
// Linux/mac keep bash -lc; Windows uses PowerShell. Centralized here so
// workspace.runCommand, background processes and PTY stay in sync.
import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'

export const isWindows = process.platform === 'win32'

/** Absolute inbox paths so a stripped PATH can't break us. Falls back to bare name. */
function sysBin(exe: string, sub = ''): string {
  if (!isWindows) return exe
  const root = process.env.SystemRoot || 'C:\\Windows'
  const abs = sub ? `${root}\\System32\\${sub}\\${exe}` : `${root}\\System32\\${exe}`
  try { if (fs.existsSync(abs)) return abs } catch { /* fall through */ }
  return exe
}

export function powershellExe(): string {
  // inbox Windows PowerShell 5.1; falls back to PATH (PowerShell 7 pwsh users keep working via -Command compat)
  return sysBin('powershell.exe', 'WindowsPowerShell\\v1.0')
}
export function netstatExe(): string { return sysBin('netstat.exe') }
export function taskkillExe(): string { return sysBin('taskkill.exe') }

/** Non-interactive command: returns argv to spawn. */
export function shellForCommand(command: string): { cmd: string; args: string[] } {
  if (isWindows) {
    // -NonInteractive avoids prompts hanging the agent loop.
    return { cmd: powershellExe(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
  }
  return { cmd: 'bash', args: ['-lc', command] }
}

/** Interactive terminal shell for node-pty. */
export function interactiveShell(): { shell: string; args: string[] } {
  if (isWindows) {
    const comspec = process.env.COMSPEC || 'powershell.exe'
    // powershell.exe works with no login flag; cmd needs no args either.
    return { shell: comspec, args: [] }
  }
  const sh = process.env.SHELL && !process.env.SHELL.endsWith('nologin') ? process.env.SHELL : 'bash'
  return { shell: sh, args: ['-l'] }
}

/** Short display name for terminal titles (handles both / and \ separators). */
export function shellTitle(shell: string): string {
  return shell.split(/[/\\]/).pop() || shell
}

/** Kill a process tree. Unix uses negative-pid group kill; Windows uses taskkill. */
export function killTree(pid: number | undefined, child?: ChildProcess, sig: NodeJS.Signals = 'SIGTERM') {
  if (!pid && !child) return
  if (isWindows) {
    if (pid) {
      const r = spawnSync(taskkillExe(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      if (r.status === 0) return
    }
    try { child?.kill('SIGTERM') } catch { /* gone */ }
    return
  }
  if (pid) {
    try { process.kill(-pid, sig); return } catch { /* fall through */ }
  }
  try { child?.kill(sig) } catch { /* gone */ }
}

/** symlink type for node_modules into worktrees: Windows needs junction without admin. */
export function symlinkType(): 'junction' | 'dir' {
  return isWindows ? 'junction' : 'dir'
}

/** Human-readable shell label for prompts / tool descriptions. */
export function shellLabel(): string {
  return isWindows ? 'PowerShell on Windows (use `;` to chain, not `&&`; `ls` alias exists)' : 'bash on Linux/macOS'
}
