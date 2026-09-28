// Shared document store: one Monaco model per file, shared by every editor in
// both windows. Tracks dirty state and reconciles with on-disk changes (e.g. edits
// made by agents) pushed through the event bus.
import { api, bus, Emitter } from './api.js'
import { languageOf } from './util.js'

class FileStore extends Emitter {
  constructor() {
    super()
    this.docs = new Map() // path -> { model, saved, dirty }
    this.tree = []
    this.flat = []
    bus.on('fs', (e) => this.onFsEvent(e))
  }

  uri(path) { return monaco.Uri.parse('file:///' + path) }

  async open(path) {
    let d = this.docs.get(path)
    if (d) return d
    const { content } = await api.get('/api/file?path=' + encodeURIComponent(path))
    d = this.docs.get(path) // raced
    if (d) return d
    const model = monaco.editor.getModel(this.uri(path)) || monaco.editor.createModel(content, languageOf(path), this.uri(path))
    d = { path, model, saved: content, dirty: false }
    model.onDidChangeContent(() => {
      const dirty = model.getValue() !== d.saved
      if (dirty !== d.dirty) { d.dirty = dirty; this.emit('dirty', path, dirty) }
    })
    this.docs.set(path, d)
    return d
  }

  isDirty(path) { return !!this.docs.get(path)?.dirty }

  async save(path) {
    const d = this.docs.get(path)
    if (!d) return
    const content = d.model.getValue()
    await api.put('/api/file', { path, content })
    d.saved = content
    d.dirty = false
    this.emit('dirty', path, false)
    this.emit('saved', path)
  }

  async saveAll() { for (const [p, d] of this.docs) if (d.dirty) await this.save(p) }

  async reloadFromDisk(path) {
    const d = this.docs.get(path)
    if (!d) return
    try {
      const { content } = await api.get('/api/file?path=' + encodeURIComponent(path))
      if (content === d.saved) return // disk unchanged (dirty edits stay untouched)
      if (d.dirty) { d.saved = content; this.emit('conflict', path); return }
      d.saved = content
      // pushEditOperations keeps undo stack & view state
      d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: content }], () => null)
      d.dirty = false
      this.emit('dirty', path, false)
      this.emit('reloaded', path)
    } catch {
      this.emit('deleted', path)
    }
  }

  close(path) {
    const d = this.docs.get(path)
    if (!d) return
    // keep model alive if anybody still shows it; caller decides
    d.model.dispose()
    this.docs.delete(path)
  }

  async refreshTree() {
    this.tree = await api.get('/api/tree')
    const flat = []
    const walk = (nodes) => { for (const n of nodes) { if (n.type === 'file') flat.push(n.path); else walk(n.children || []) } }
    walk(this.tree)
    this.flat = flat
    this.emit('tree', this.tree)
  }

  onFsEvent(e) {
    if (e.scope && e.scope !== 'main') { this.emit('fs', e); return } // change inside an agent worktree
    clearTimeout(this._t)
    this._t = setTimeout(() => this.refreshTree(), 120)
    if (e.path && this.docs.has(e.path)) {
      if (e.change === 'deleted') this.emit('deleted', e.path)
      else if (!(e.source === 'user')) this.reloadFromDisk(e.path)
    }
    if (e.change === 'unknown') for (const p of this.docs.keys()) this.reloadFromDisk(p)
    this.emit('fs', e)
  }
}

export const files = new FileStore()
