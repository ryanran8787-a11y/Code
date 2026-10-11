// Approval policy + retry classification (pure functions, unit-tested).
// The agent loop (agent.ts) calls decideApproval() before running terminal /
// background commands, and isRetryable()/backoffMs() around model requests.

export type Decision = 'allow' | 'ask' | 'deny'

/** Compile user patterns; an invalid regex degrades to a literal substring match. */
export function compileList(patterns: string[]): RegExp[] {
  return (patterns || []).map((p) => {
    try {
      return new RegExp(p)
    } catch {
      const literal = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(literal)
    }
  })
}

/**
 * Precedence: deny > allow > global autoRun > ask.
 * Only terminal/background commands go through here; file edits are
 * guarded by snapshots (local) / worktree review instead.
 */
export function decideApproval(
  command: string,
  opts: { autoRun: boolean; allow: RegExp[]; deny: RegExp[] },
): Decision {
  const cmd = String(command || '')
  if (opts.deny.some((re) => re.test(cmd))) return 'deny'
  if (opts.autoRun || opts.allow.some((re) => re.test(cmd))) return 'allow'
  return 'ask'
}

/** Retryable: rate limits, overloaded/bad gateway, timeouts, connection resets. */
export function isRetryable(err: any): boolean {
  if (!err) return false
  const status = err.status ?? err.statusCode ?? err.code
  if (status === 429) return true
  if (typeof status === 'number' && status >= 500 && status < 600) return true
  const msg = String(err?.error?.message || err?.message || '')
  if (/timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|overloaded|try again/i.test(msg)) return true
  return false
}

/** Never retry: auth, bad request (after compat fallback), not found, abort. */
export function isFatal(err: any): boolean {
  if (!err) return false
  if (err.name === 'AbortError') return true
  const status = err.status ?? err.statusCode
  return status === 400 || status === 401 || status === 403 || status === 404
}

/** 1s, 2s, 4s … capped at 15s, with ±20% jitter. */
export function backoffMs(attempt: number): number {
  const base = Math.min(15_000, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
    signal?.addEventListener('abort', onAbort)
  })
}
