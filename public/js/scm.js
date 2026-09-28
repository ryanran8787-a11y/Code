// Source Control view (VS Code style): branch, commit box, staged / changes
// groups with stage / unstage / discard, open diff vs HEAD, recent commits.
import { api, bus } from './api.js'
import { h, icon, fileIcon, basename, dirname, toast, debounce } from './util.js'

const LETTER = { M: ['M', '#e2c08d'], A: ['A', '#73c991'], D: ['D', '#c74e39'], R: ['R', '#73c991'], '?': ['U', '#73c991'], U: ['!', '#e51400'], C: ['C', '#73c991'] }

export class ScmView {
  constructor({ openDiff, openFile }) {
    this.openDiff = openDiff
    this.openFile = openFile
    this.msg = h('textarea', { class: 'scm-msg', rows: 1, placeholder: 'Message (Ctrl+Enter to commit)', spellcheck: 'false' })
    this.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit() } })
    this.msg.addEventListener('input', () => { this.msg.style.height = 'auto'; this.msg.style.height = Math.min(120, this.msg.scrollHeight) + 'px' })
    this.body = h('div', { class: 'scm-body' })
    this.el = h('div', { class: 'pane scm' },
      h('div', { class: 'pane-title' }, h('span', {}, 'Source Control'), h('div', { class: 'flex1' }),
        h('button', { class: 'icon-btn', title: 'Refresh', onclick: () => this.refresh() }, icon('refresh')),
        h('button', { class: 'icon-btn', title: 'Branches…', onclick: () => this.pickBranch() }, icon('git-branch'))),
      this.body)
    this.status = null
    const r = debounce(() => this.refresh(), 300)
    bus.on('git', r)
    bus.on('fs', (e) => { if (!e.scope || e.scope === 'main') r() })
    this.refresh()
  }

  async refresh() {
    try { this.status = await api.get('/api/git/status') } catch (e) { this.body.replaceChildren(h('div', { class: 'empty-note' }, e.message)); return }
    this.onStatus?.(this.status)
    this.render()
  }

  render() {
    const st = this.status
    if (!st.repo) {
      this.body.replaceChildren(h('div', { class: 'empty-note' }, 'The workspace is not a git repository.'),
        h('div', { class: 'scm-init' }, h('button', { class: 'btn-primary', onclick: async () => { await api.post('/api/git/init'); this.refresh() } }, icon('git-commit'), 'Initialize Repository')))
      return
    }
    const staged = st.entries.filter((e) => e.staged)
    const changes = st.entries.filter((e) => e.unstaged || e.conflicted)
    const group = (title, list, isStaged) => {
      if (!list.length) return null
      return h('div', { class: 'scm-group' },
        h('div', { class: 'scm-group-head' }, icon('chevron-down'), h('span', { class: 'flex1' }, title),
          isStaged
            ? h('button', { class: 'icon-btn', title: 'Unstage All', onclick: () => this.op('unstage', list.map((e) => e.path)) }, icon('remove'))
            : [h('button', { class: 'icon-btn', title: 'Discard All Changes', onclick: () => { if (confirm('Discard ALL changes? This cannot be undone.')) this.op('discard', list.map((e) => e.path)) } }, icon('discard')),
              h('button', { class: 'icon-btn', title: 'Stage All', onclick: () => this.op('stage', list.map((e) => e.path)) }, icon('add'))],
          h('span', { class: 'scm-count' }, list.length)),
        ...list.map((e) => this.row(e, isStaged)))
    }
    this.body.replaceChildren(
      h('div', { class: 'scm-branch', title: 'Current branch', onclick: () => this.pickBranch() }, icon('git-branch'), h('span', {}, st.branch || '(detached)'),
        st.ahead ? h('span', { class: 'muted small' }, `↑${st.ahead}`) : null, st.behind ? h('span', { class: 'muted small' }, `↓${st.behind}`) : null),
      h('div', { class: 'scm-commit' }, this.msg,
        h('button', { class: 'btn-primary scm-commit-btn', onclick: () => this.commit(), disabled: !st.entries.length }, icon('check'), staged.length ? 'Commit' : 'Commit All')),
      group('Staged Changes', staged, true),
      group('Changes', changes, false),
      st.entries.length ? null : h('div', { class: 'empty-note' }, 'No changes.'),
      st.commits.length ? h('div', { class: 'scm-group' }, h('div', { class: 'scm-group-head' }, icon('history'), h('span', { class: 'flex1' }, 'Commits')),
        ...st.commits.map((c) => h('div', { class: 'scm-commit-row', title: `${c.hash} · ${c.author} · ${c.when}` }, icon('git-commit'), h('span', { class: 'flex1 ell' }, c.subject), h('span', { class: 'muted small' }, c.when.replace(' ago', ''))))) : null,
    )
  }

  row(e, isStaged) {
    const code = isStaged ? e.index : (e.untracked ? '?' : e.work)
    const [L, color] = LETTER[code] || [code, 'var(--muted)']
    return h('div', { class: 'scm-row', title: e.path, onclick: () => this.openDiff(e.path, code === 'D') },
      fileIcon(e.path), h('span', { class: 'scm-name' + (code === 'D' ? ' deleted' : '') }, basename(e.path)), h('span', { class: 'muted small ell flex1' }, dirname(e.path)),
      h('span', { class: 'scm-actions' },
        code !== 'D' ? h('button', { class: 'icon-btn', title: 'Open File', onclick: (ev) => { ev.stopPropagation(); this.openFile(e.path) } }, icon('go-to-file')) : null,
        isStaged ? h('button', { class: 'icon-btn', title: 'Unstage', onclick: (ev) => { ev.stopPropagation(); this.op('unstage', [e.path]) } }, icon('remove'))
          : [h('button', { class: 'icon-btn', title: 'Discard Changes', onclick: (ev) => { ev.stopPropagation(); if (confirm(`Discard changes in ${e.path}?`)) this.op('discard', [e.path]) } }, icon('discard')),
            h('button', { class: 'icon-btn', title: 'Stage', onclick: (ev) => { ev.stopPropagation(); this.op('stage', [e.path]) } }, icon('add'))]),
      h('span', { class: 'scm-letter', style: { color } }, L))
  }

  async op(kind, paths) {
    try { await api.post('/api/git/' + kind, { paths }); await this.refresh() } catch (e) { toast(e.message, 'error') }
  }

  async commit() {
    const message = this.msg.value.trim()
    if (!message) { this.msg.focus(); toast('Enter a commit message', 'warn'); return }
    const staged = this.status.entries.some((e) => e.staged)
    try { await api.post('/api/git/commit', { message, all: !staged }); this.msg.value = ''; toast('Committed'); this.refresh() } catch (e) { toast(e.message, 'error') }
  }

  async pickBranch() {
    const { quickPick, inputBox } = await import('./palette.js')
    const list = await api.get('/api/git/branches')
    const v = await quickPick([{ label: '+ Create new branch…', value: { create: true }, icon: icon('add') }, ...list.map((b) => ({ label: b.name, description: b.current ? 'current' : b.name.startsWith('agent/') ? 'agent worktree branch' : '', value: { name: b.name }, icon: icon('git-branch') }))], { placeholder: 'Select a branch to checkout' })
    if (!v) return
    try {
      if (v.create) { const n = await inputBox({ placeholder: 'Branch name' }); if (n) await api.post('/api/git/checkout', { branch: n, create: true }) }
      else await api.post('/api/git/checkout', { branch: v.name })
      this.refresh()
    } catch (e) { toast(e.message, 'error') }
  }
}
