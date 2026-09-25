// Client-side mirror of all agents. Keeps summaries for the sidebar and full
// timelines for agents that are open in any view. Both windows share this store.
import { api, bus, Emitter } from './api.js'

class AgentStore extends Emitter {
  constructor() {
    super()
    this.list = []            // summaries
    this.details = new Map()  // id -> { timeline, changes, ... }
    this.settings = null
    bus.on('agent.created', (e) => this.upsert(e.agent))
    bus.on('agent.summary', (e) => this.upsert(e.agent))
    bus.on('agent.deleted', (e) => { this.list = this.list.filter((a) => a.id !== e.agentId); this.details.delete(e.agentId); this.emit('list') })
    bus.on('agent.item', (e) => this.onItem(e))
    bus.on('agent.delta', (e) => this.onDelta(e))
    bus.on('agent.changes', (e) => this.emit('changes', e.agentId))
    bus.on('connection', (ok) => { if (ok) this.resync() })
  }

  async init() {
    this.settings = await api.get('/api/settings')
    this.list = await api.get('/api/agents')
    this.emit('list')
  }

  async resync() {
    try {
      this.list = await api.get('/api/agents')
      this.emit('list')
      for (const id of this.details.keys()) await this.load(id, true)
    } catch { /* offline */ }
  }

  get(id) { return this.list.find((a) => a.id === id) }

  upsert(s) {
    const i = this.list.findIndex((a) => a.id === s.id)
    const prev = i >= 0 ? this.list[i] : null
    if (i >= 0) this.list[i] = s; else this.list.unshift(s)
    this.list.sort((a, b) => b.updatedAt - a.updatedAt)
    this.emit('list')
    this.emit('summary', s, prev)
  }

  async load(id, force = false) {
    if (this.details.has(id) && !force) return this.details.get(id)
    const d = await api.get('/api/agents/' + id)
    this.details.set(id, d)
    this.emit('detail', id)
    return d
  }

  onItem(e) {
    const d = this.details.get(e.agentId)
    if (!d) return
    const i = d.timeline.findIndex((t) => t.id === e.item.id)
    if (i >= 0) d.timeline[i] = { ...d.timeline[i], ...e.item }
    else if (e.before) {
      const j = d.timeline.findIndex((t) => t.id === e.before)
      d.timeline.splice(j < 0 ? d.timeline.length : j, 0, e.item)
    } else d.timeline.push(e.item)
    this.emit('item', e.agentId, e.item)
  }

  onDelta(e) {
    const d = this.details.get(e.agentId)
    if (!d) return
    const it = d.timeline.find((t) => t.id === e.itemId)
    if (it) { it.text = (it.text || '') + e.delta; this.emit('delta', e.agentId, it) }
  }

  async create(prompt, opts = {}) {
    const s = await api.post('/api/agents', { prompt, model: opts.model, mode: opts.mode })
    this.upsert(s)
    await this.load(s.id, true)
    return s
  }
  send(id, text, opts = {}) { return api.post(`/api/agents/${id}/messages`, { text, model: opts.model, mode: opts.mode }) }
  stop(id) { return api.post(`/api/agents/${id}/stop`) }
  remove(id) { return api.del(`/api/agents/${id}`) }
  rename(id, title) { return api.patch(`/api/agents/${id}`, { title }) }
  markRead(id) { const a = this.get(id); if (a?.unread) api.post(`/api/agents/${id}/read`) }
  approve(id, toolId, approve) { return api.post(`/api/agents/${id}/approve`, { toolId, approve }) }
  changes(id) { return api.get(`/api/agents/${id}/changes`) }
  resolve(id, path, accept) { return api.post(`/api/agents/${id}/changes/resolve`, { path, accept }) }
}

export const agentStore = new AgentStore()

export const STATUS = {
  idle: { label: 'Idle', icon: 'circle-large-outline', cls: 'st-idle' },
  running: { label: 'Running', icon: 'loading', cls: 'st-running' },
  awaiting_approval: { label: 'Needs approval', icon: 'bell-dot', cls: 'st-await' },
  done: { label: 'Done', icon: 'pass-filled', cls: 'st-done' },
  error: { label: 'Error', icon: 'error', cls: 'st-error' },
  stopped: { label: 'Stopped', icon: 'debug-stop', cls: 'st-stopped' },
}
