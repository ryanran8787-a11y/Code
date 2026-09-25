// Simple in-process event bus used to push agent / fs updates to all SSE clients.
export type BusEvent = { kind: string; [k: string]: any }
type Listener = (e: BusEvent) => void

const listeners = new Set<Listener>()

export function publish(e: BusEvent) {
  for (const l of listeners) {
    try { l(e) } catch { /* ignore */ }
  }
}

export function subscribe(l: Listener) {
  listeners.add(l)
  return () => listeners.delete(l)
}
