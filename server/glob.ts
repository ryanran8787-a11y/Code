// Tiny glob matcher supporting **, *, ?, {a,b} – enough for agent file_search.
export function minimatch(file: string, pattern: string): boolean {
  let p = pattern.replace(/^\.\//, '')
  if (!p.includes('/')) p = '**/' + p
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = p.indexOf('}', i)
      re += '(?:' + p.slice(i + 1, end).split(',').map(esc).join('|') + ')'
      i = end
    } else re += esc(c)
  }
  return new RegExp('^' + re + '$').test(file)
}
function esc(s: string) { return s.replace(/[.+^${}()|[\]\\]/g, '\\$&') }
