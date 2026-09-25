// Tool definitions (OpenAI function-calling schema) + implementations.
import { minimatch } from './glob'
import * as ws from './workspace'

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a workspace directory (non-recursive). Use "" or "." for the workspace root.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory path' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns numbered lines. Optionally pass start_line/end_line (1-based, inclusive) for large files.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search file contents in the workspace (ripgrep). Returns matching lines as path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for' },
          is_regex: { type: 'boolean' },
          include: { type: 'string', description: 'Optional glob filter, e.g. "*.ts"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_search',
      description: 'Find files by glob pattern or fuzzy name, e.g. "**/*.css" or "index".',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit an existing file by replacing an exact snippet. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing file with the full content.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description:
        'Run a non-interactive shell command (bash) in the workspace, e.g. to run tests, build, list files, install deps. Avoid long-running servers. Output is truncated.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Workspace-relative working directory' },
          timeout_seconds: { type: 'integer' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todos',
      description: 'Maintain a short task list for the current job so the user can follow progress. Send the full list each time.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
] as const

export type ToolContext = {
  agentId: string
  /** called before a file is modified for the first time so the agent can snapshot it */
  snapshot: (path: string) => Promise<void>
  onOutput: (chunk: string) => void
  signal: AbortSignal
  setTodos: (t: any[]) => void
}

function trunc(s: string, n = 30_000) {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s
}

export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<{ result: string; meta?: any }> {
  switch (name) {
    case 'list_dir': {
      const p = normalize(args.path)
      const nodes = await ws.readTree(p, 0)
      if (!nodes.length && !(await ws.fileExists(p))) throw new Error(`Directory not found: ${p || '.'}`)
      return { result: nodes.map((n) => (n.type === 'dir' ? n.name + '/' : n.name)).join('\n') || '(empty)' }
    }
    case 'read_file': {
      const p = normalize(args.path)
      const text = await ws.readFile(p)
      const lines = text.split('\n')
      const s = Math.max(1, args.start_line || 1)
      const e = Math.min(lines.length, args.end_line || lines.length)
      const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n')
      return { result: trunc(`File: ${p} (${lines.length} lines)\n${body}`), meta: { path: p, lines: lines.length, range: [s, e] } }
    }
    case 'grep_search': {
      const hits = await ws.searchText(args.query, { regex: !!args.is_regex, include: args.include, max: 100 })
      return { result: hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'No matches.', meta: { count: hits.length } }
    }
    case 'file_search': {
      const files = await ws.listFilesFlat()
      const pat = String(args.pattern || '')
      const hasGlob = /[*?[\]{}]/.test(pat)
      const res = files.filter((f) => (hasGlob ? minimatch(f, pat) : f.toLowerCase().includes(pat.toLowerCase()))).slice(0, 100)
      return { result: res.length ? res.join('\n') : 'No files found.', meta: { count: res.length } }
    }
    case 'edit_file': {
      const p = normalize(args.path)
      const before = await ws.readFile(p)
      const oldS = String(args.old_string ?? '')
      const newS = String(args.new_string ?? '')
      if (!oldS) throw new Error('old_string must not be empty (use write_file to create files)')
      const count = before.split(oldS).length - 1
      if (count === 0) throw new Error(`old_string not found in ${p}. Re-read the file and copy the snippet exactly.`)
      if (count > 1 && !args.replace_all) throw new Error(`old_string occurs ${count} times in ${p}; add more context or set replace_all.`)
      await ctx.snapshot(p)
      const after = args.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS)
      await ws.writeFile(p, after, `agent:${ctx.agentId}`)
      return { result: `Edited ${p} (${count} replacement${count > 1 ? 's' : ''}).`, meta: { path: p, ...lineStats(before, after) } }
    }
    case 'write_file': {
      const p = normalize(args.path)
      const existed = await ws.fileExists(p)
      const before = existed ? await ws.readFile(p).catch(() => '') : ''
      await ctx.snapshot(p)
      await ws.writeFile(p, String(args.content ?? ''), `agent:${ctx.agentId}`)
      return { result: `${existed ? 'Overwrote' : 'Created'} ${p}.`, meta: { path: p, created: !existed, ...lineStats(before, String(args.content ?? '')) } }
    }
    case 'delete_file': {
      const p = normalize(args.path)
      if (!(await ws.fileExists(p))) throw new Error(`File not found: ${p}`)
      await ctx.snapshot(p)
      await ws.deletePath(p, `agent:${ctx.agentId}`)
      return { result: `Deleted ${p}.`, meta: { path: p } }
    }
    case 'run_terminal_command': {
      const r = await ws.runCommand(String(args.command), {
        cwd: normalize(args.cwd || ''),
        timeoutMs: Math.min(300, args.timeout_seconds || 60) * 1000,
        onData: ctx.onOutput,
        signal: ctx.signal,
      })
      const status = r.timedOut ? 'timed out' : `exit code ${r.exitCode}`
      return { result: trunc(`$ ${args.command}\n${r.output}\n[${status}]`, 20_000), meta: { exitCode: r.exitCode, timedOut: r.timedOut } }
    }
    case 'update_todos': {
      ctx.setTodos(Array.isArray(args.todos) ? args.todos : [])
      return { result: 'Todo list updated.' }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function normalize(p: string) {
  let s = String(p ?? '').trim().replace(/\\/g, '/')
  if (s === '.' || s === './') return ''
  s = s.replace(/^\.\//, '')
  if (s.startsWith(ws.WORKSPACE_ROOT)) s = s.slice(ws.WORKSPACE_ROOT.length)
  return s.replace(/^\/+/, '').replace(/\/+$/, '')
}

function lineStats(before: string, after: string) {
  // cheap +/- estimate for UI badges, the precise diff is computed on the client
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const setA = new Map<string, number>()
  for (const l of a) setA.set(l, (setA.get(l) || 0) + 1)
  let common = 0
  for (const l of b) { const c = setA.get(l); if (c) { common++; setA.set(l, c - 1) } }
  return { added: b.length - common, removed: a.length - common }
}
