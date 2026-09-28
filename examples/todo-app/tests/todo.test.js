import assert from 'node:assert'
import { TodoList } from '../src/todo.js'

const list = new TodoList()
list.add('write code')
list.add('ship it')
list.toggle(1)
assert.strictEqual(list.pending().length, 1)
console.log('all tests passed')
