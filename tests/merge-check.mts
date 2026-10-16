// TEMP: worktree merge correctness — binary integrity, renames, real conflicts, revert.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { createWorktree, applyWorktree, revertWorktree, removeWorktree } from '../server/git.ts'

const WS = process.env.WORKSPACE!
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const eq = (a: any, b: any, m: string) => {
  if (a !== b) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); process.exit(1) }
  console.log(`ok ${m}`)
}
async function main() {
  // hermetic: reset the scratch workspace so reruns never inherit divergence
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  execSync('git init -q -b main', { cwd: WS })
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n'
  fs.writeFileSync(path.join(WS, 'text.txt'), text)
  const blob = crypto.randomBytes(1024)
  blob[100] = 0; blob[500] = 0
  fs.writeFileSync(path.join(WS, 'blob.bin'), blob)
  const baseBlobHash = sha(path.join(WS, 'blob.bin'))
  fs.writeFileSync(path.join(WS, 'oldname.txt'), 'alpha\nbeta\ngamma\ndelta\nepsilon\n')

  const wt = await createWorktree('merge1', 'merge test')
  console.log('worktree: ' + wt.branch)

  console.log('1. fast-forward: text append + binary rewrite + rename')
  fs.appendFileSync(path.join(wt.dir, 'text.txt'), 'agent-line\n')
  const blob2 = crypto.randomBytes(1024)
  fs.writeFileSync(path.join(wt.dir, 'blob.bin'), blob2)
  fs.renameSync(path.join(wt.dir, 'oldname.txt'), path.join(wt.dir, 'newname.txt'))
  fs.appendFileSync(path.join(wt.dir, 'newname.txt'), 'zeta\n')
  let r = await applyWorktree(wt)
  eq(r.conflicts.length, 0, 'no conflicts on fast-forward')
  eq(fs.readFileSync(path.join(WS, 'text.txt'), 'utf8').includes('agent-line'), true, 'text applied')
  eq(sha(path.join(WS, 'blob.bin')), sha(path.join(wt.dir, 'blob.bin')), 'binary byte-identical after merge')
  eq(fs.existsSync(path.join(WS, 'oldname.txt')), false, 'old name removed')
  eq(fs.readFileSync(path.join(WS, 'newname.txt'), 'utf8').includes('zeta'), true, 'renamed file content applied')

  console.log('2. both sides change different lines -> auto-merge')
  const t1 = fs.readFileSync(path.join(WS, 'text.txt'), 'utf8').split('\n')
  t1[0] = 'MAIN'
  fs.writeFileSync(path.join(WS, 'text.txt'), t1.join('\n'))
  const t2 = fs.readFileSync(path.join(wt.dir, 'text.txt'), 'utf8').split('\n')
  t2[5] = 'AGENT'
  fs.writeFileSync(path.join(wt.dir, 'text.txt'), t2.join('\n'))
  r = await applyWorktree(wt, ['text.txt'])
  eq(r.conflicts.length, 0, 'auto-merge, no conflict')
  const merged = fs.readFileSync(path.join(WS, 'text.txt'), 'utf8')
  eq(merged.includes('MAIN') && merged.includes('AGENT'), true, 'both edits present')

  console.log('3. same line both sides -> conflict, main untouched')
  const m1 = merged.split('\n'); m1[2] = 'MAIN2'
  fs.writeFileSync(path.join(WS, 'text.txt'), m1.join('\n'))
  const w1 = fs.readFileSync(path.join(wt.dir, 'text.txt'), 'utf8').split('\n'); w1[2] = 'AGENT2'
  fs.writeFileSync(path.join(wt.dir, 'text.txt'), w1.join('\n'))
  r = await applyWorktree(wt, ['text.txt'])
  eq(r.conflicts.includes('text.txt'), true, 'conflict reported')
  eq(fs.readFileSync(path.join(WS, 'text.txt'), 'utf8').includes('MAIN2'), true, 'main untouched without force')
  r = await applyWorktree(wt, ['text.txt'], { writeConflicts: true })
  eq(r.conflicts.includes('text.txt'), true, 'conflict reported with force')
  eq(fs.readFileSync(path.join(WS, 'text.txt'), 'utf8').includes('<<<<<<<'), true, 'markers written with force')
  // restore a clean merged state for the rest of the suite
  const clean = m1.slice(); clean[2] = 'line2'
  fs.writeFileSync(path.join(WS, 'text.txt'), clean.join('\n'))

  console.log('4. binary vs binary -> conflict, never corrupted')
  const mainBlob = fs.readFileSync(path.join(WS, 'blob.bin'))
  mainBlob[10] = (mainBlob[10] + 1) % 256
  fs.writeFileSync(path.join(WS, 'blob.bin'), mainBlob)
  const wtBlob = fs.readFileSync(path.join(wt.dir, 'blob.bin'))
  wtBlob[20] = (wtBlob[20] + 1) % 256
  fs.writeFileSync(path.join(wt.dir, 'blob.bin'), wtBlob)
  const beforeHash = sha(path.join(WS, 'blob.bin'))
  r = await applyWorktree(wt, ['blob.bin'])
  eq(r.conflicts.includes('blob.bin'), true, 'binary conflict reported')
  eq(sha(path.join(WS, 'blob.bin')), beforeHash, 'main binary untouched')

  console.log('5. revert restores worktree bytes exactly')
  const wb = fs.readFileSync(path.join(wt.dir, 'blob.bin'))
  wb[30] = (wb[30] + 5) % 256
  fs.writeFileSync(path.join(wt.dir, 'blob.bin'), wb)
  await revertWorktree(wt, ['blob.bin'])
  eq(sha(path.join(wt.dir, 'blob.bin')), baseBlobHash, 'worktree binary restored to base bytes')
  await removeWorktree(wt)
  eq(fs.existsSync(wt.dir), false, 'worktree removed')
  console.log('MERGE-CHECK-OK')
}
main().catch((e) => { console.error(e); process.exit(1) })
