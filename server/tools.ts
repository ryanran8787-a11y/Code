// Tool definitions (OpenAI function-calling schema) + implementations.
import { minimatch } from './glob'
import * as ws from './workspace'
import * as procs from './processes'
import { webFetch } from './browser'

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
  {
    type: 'function',
    function: {
      name: 'start_background_process',
      description: 'Start a long-running process (dev server, watcher) in the background. Returns an id; use read_process_output to check logs and detected ports, stop_process to stop it. Prefer this over run_terminal_command for servers.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, wait_seconds: { type: 'integer', description: 'Seconds to wait before returning initial output (default 3)' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_process_output',
      description: 'Read recent output, status and listening ports of a background process started with start_background_process.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, tail_chars: { type: 'integer' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_process',
      description: 'Stop a background process.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'HTTP GET/POST a URL (e.g. a local dev server like http://localhost:5173) and return status, headers and body text (HTML is reduced to readable text plus a list of interactive elements). Use it to verify web pages or APIs you built.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' }, raw: { type: 'boolean', description: 'Return raw body instead of extracted text' } }, required: ['url'] },
    },
  },
] as const

export type ToolContext = {
  agentId: string
  /** file-system root the agent works in (main workspace or its git worktree) */
  ws: ws.Workspace
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
      const p = normalize(ctx, args.path)
      const nodes = await ctx.ws.readTree(p, 0)
      if (!nodes.length && !(await ctx.ws.fileExists(p))) throw new Error(`Directory not found: ${p || '.'}`)
      return { result: nodes.map((n) => (n.type === 'dir' ? n.name + '/' : n.name)).join('\n') || '(empty)' }
    }
    case 'read_file': {
      const p = normalize(ctx, args.path)
      const text = await ctx.ws.readFile(p)
      const lines = text.split('\n')
      const s = Math.max(1, args.start_line || 1)
      const e = Math.min(lines.length, args.end_line || lines.length)
      const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n')
      return { result: trunc(`File: ${p} (${lines.length} lines)\n${body}`), meta: { path: p, lines: lines.length, range: [s, e] } }
    }
    case 'grep_search': {
      const hits = await ctx.ws.searchText(args.query, { regex: !!args.is_regex, include: args.include, max: 100 })
      return { result: hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'No matches.', meta: { count: hits.length } }
    }
    case 'file_search': {
      const files = await ctx.ws.listFilesFlat()
      const pat = String(args.pattern || '')
      const hasGlob = /[*?[\]{}]/.test(pat)
      const res = files.filter((f) => (hasGlob ? minimatch(f, pat) : f.toLowerCase().includes(pat.toLowerCase()))).slice(0, 100)
      return { result: res.length ? res.join('\n') : 'No files found.', meta: { count: res.length } }
    }
    case 'edit_file': {
      const p = normalize(ctx, args.path)
      const before = await ctx.ws.readFile(p)
      const oldS = String(args.old_string ?? '')
      const newS = String(args.new_string ?? '')
      if (!oldS) throw new Error('old_string must not be empty (use write_file to create files)')
      const count = before.split(oldS).length - 1
      if (count === 0) throw new Error(`old_string not found in ${p}. Re-read the file and copy the snippet exactly.`)
      if (count > 1 && !args.replace_all) throw new Error(`old_string occurs ${count} times in ${p}; add more context or set replace_all.`)
      await ctx.snapshot(p)
      const after = args.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS)
      await ctx.ws.writeFile(p, after, `agent:${ctx.agentId}`)
      return { result: `Edited ${p} (${count} replacement${count > 1 ? 's' : ''}).`, meta: { path: p, ...lineStats(before, after) } }
    }
    case 'write_file': {
      const p = normalize(ctx, args.path)
      const existed = await ctx.ws.fileExists(p)
      const before = existed ? await ctx.ws.readFile(p).catch(() => '') : ''
      await ctx.snapshot(p)
      await ctx.ws.writeFile(p, String(args.content ?? ''), `agent:${ctx.agentId}`)
      return { result: `${existed ? 'Overwrote' : 'Created'} ${p}.`, meta: { path: p, created: !existed, ...lineStats(before, String(args.content ?? '')) } }
    }
    case 'delete_file': {
      const p = normalize(ctx, args.path)
      if (!(await ctx.ws.fileExists(p))) throw new Error(`File not found: ${p}`)
      await ctx.snapshot(p)
      await ctx.ws.deletePath(p, `agent:${ctx.agentId}`)
      return { result: `Deleted ${p}.`, meta: { path: p } }
    }
    case 'run_terminal_command': {
      const r = await ctx.ws.runCommand(String(args.command), {
        cwd: normalize(ctx, args.cwd || ''),
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
    case 'start_background_process': {
      const cwd = ctx.ws.resolve(normalize(ctx, args.cwd || ''))
      const p = procs.start(String(args.command), cwd, ctx.agentId)
      await procs.waitFor(p.id, Math.min(30, args.wait_seconds ?? 3) * 1000)
      return { result: `Started process ${p.id} (${p.status}${p.exitCode !== null ? ', exit ' + p.exitCode : ''}). Ports: ${p.ports.join(', ') || 'none detected yet'}\n--- output ---\n${p.output.slice(-4000)}`, meta: { procId: p.id, ports: p.ports } }
    }
    case 'read_process_output': {
      const p = procs.get(String(args.id))
      if (!p) throw new Error('No such process: ' + args.id)
      return { result: `Process ${p.id}: ${p.status}${p.exitCode !== null ? ' (exit ' + p.exitCode + ')' : ''}; ports: ${p.ports.join(', ') || 'none'}\n--- output ---\n${p.output.slice(-(args.tail_chars || 6000))}`, meta: { procId: p.id, ports: p.ports } }
    }
    case 'stop_process': {
      procs.stop(String(args.id))
      await procs.waitFor(String(args.id), 3500)
      return { result: `Stopped ${args.id}.` }
    }
    case 'fetch_url': {
      const r = await webFetch(String(args.url), { method: args.method, body: args.body, raw: !!args.raw, signal: ctx.signal })
      return { result: trunc(r.text, 20_000), meta: { status: r.status, url: r.url } }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function normalize(ctx: ToolContext, p: string) {
  let s = String(p ?? '').trim().replace(/\\/g, '/')
  if (s === '.' || s === './') return ''
  s = s.replace(/^\.\//, '')
  if (s.startsWith(ctx.ws.root)) s = s.slice(ctx.ws.root.length)
  else if (s.startsWith(ws.WORKSPACE_ROOT)) s = s.slice(ws.WORKSPACE_ROOT.length)
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
