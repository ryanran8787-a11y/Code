export class TodoList {
  constructor() {
    this.items = []
  }

  add(title) {
    const item = { id: this.items.length + 1, title, done: false }
    this.items.push(item)
    return item
  }

  toggle(id) {
    const item = this.items.find((i) => i.id === id)
    if (item) item.done = !item.done
    return item
  }

  pending() {
    return this.items.filter((i) => !i.done)
  }
}
