// Thin REST client + global event bus fed by the server's SSE stream.
async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, data: j })
  return j
}
export const api = {
  get: (u) => req('GET', u),
  post: (u, b = {}) => req('POST', u, b),
  put: (u, b) => req('PUT', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
}

export class Emitter {
  constructor() { this.m = new Map() }
  on(ev, fn) { if (!this.m.has(ev)) this.m.set(ev, new Set()); this.m.get(ev).add(fn); return () => this.m.get(ev).delete(fn) }
  emit(ev, ...a) { for (const fn of this.m.get(ev) || []) { try { fn(...a) } catch (e) { console.error(e) } } }
}

export const bus = new Emitter()

export function connectEvents() {
  let es
  const open = () => {
    es = new EventSource('/api/events')
    es.onmessage = (m) => {
      try { const e = JSON.parse(m.data); bus.emit(e.kind, e); bus.emit('*', e) } catch { /* ignore */ }
    }
    es.onopen = () => bus.emit('connection', true)
    es.onerror = () => { bus.emit('connection', false) }
  }
  open()
}

/** Stream a POST endpoint that answers with SSE (used by the terminal). */
export async function postSSE(url, body, onEvent, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2)
      let ev = 'message', data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '')
      }
      try { onEvent(ev, data ? JSON.parse(data) : null) } catch { onEvent(ev, data) }
    }
  }
}
