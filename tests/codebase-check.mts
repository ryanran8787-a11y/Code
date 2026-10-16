// Backend unit test for @codebase search. Run with WORKSPACE=examples/todo-app:
//   WORKSPACE=examples/todo-app npx tsx tests/codebase-check.mts
import { tokenize, searchCodebase } from '../server/codebase.ts'

function eq(a: any, b: any, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) { console.error(`FAIL ${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); process.exit(1) }
  console.log(`ok ${msg}`)
}
function ok(c: any, msg: string) {
  if (!c) { console.error(`FAIL ${msg}`); process.exit(1) }
  console.log(`ok ${msg}`)
}

async function main() {
  eq(tokenize('TodoList!'), ['todolist'], 'tokenize single')
  eq(tokenize('the todo list'), ['todo', 'list'], 'tokenize stopwords')
  eq(tokenize('a!'), [], 'tokenize short-only')
  eq(tokenize(''), [], 'tokenize empty')

  const r = await searchCodebase('todo')
  ok(r.terms.includes('todo'), 'terms kept')
  ok(r.files.length > 0, 'todo matches files')
  ok(r.files.some((f) => f.path === 'src/todo.js'), 'src/todo.js ranked')
  ok(r.files[0].score > 0, 'positive score')
  ok(r.files[0].snippets.length > 0 && r.files[0].snippets[0].line >= 1, 'snippets have lines')
  const chars = JSON.stringify(r).length
  ok(chars <= 20000, `budget respected (${chars} chars)`)
  for (let i = 1; i < r.files.length; i++) {
    if (r.files[i].score > r.files[i - 1].score) { console.error('FAIL ranking order'); process.exit(1) }
  }
  console.log('ok ranking sorted desc')

  const none = await searchCodebase('xyzzy-nope-zzz')
  eq(none.files, [], 'gibberish has no matches')

  const tiny = await searchCodebase('todo', { maxFiles: 8, maxChars: 50 })
  ok(tiny.truncated === true, 'tiny budget truncates')
  console.log('CODEBASE-UNIT-OK')
}
main().catch((e) => { console.error(e); process.exit(1) })
