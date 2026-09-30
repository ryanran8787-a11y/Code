// A deterministic, OpenAI-compatible mock model (chat.completions + SSE streaming +
// tool calls). Used for offline development / self-verification when no real
// LLM key is available: set Base URL to "mock" in Settings.
//
// It derives a plan from the latest user message:
//   - always explores the workspace (list_dir)
//   - reads any file path mentioned
//   - "edit/修改/add/添加" + a file   -> edit_file (inserts a comment line)
//   - "create/创建/新建" + a file      -> write_file
//   - `backticked command` or "run/运行" -> run_terminal_command
//   - finally streams a Markdown summary
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

export const mock = new Hono()

type Step = { name: string; args: any }

function plan(user: string, fileContents: Record<string, string>): Step[] {
  const steps: Step[] = [{ name: 'list_dir', args: { path: '' } }]
  const files = [...user.matchAll(/([\w\-./]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|txt|go|rs))/g)].map((m) => m[1].replace(/^\.\//, ''))
  const wantsCreate = /create|创建|新建|建立|new file/i.test(user)
  const wantsEdit = /edit|修改|add|添加|加上|update|改/i.test(user)
  const cmd = /`([^`]+)`/.exec(user)?.[1] || (/run|运行|执行|测试|test/i.test(user) ? 'ls -la && node --version' : null)
  if (/todo|计划|plan/i.test(user)) steps.push({ name: 'update_todos', args: { todos: [{ content: 'Explore workspace', status: 'completed' }, { content: 'Make the change', status: 'in_progress' }, { content: 'Verify', status: 'pending' }] } })
  for (const f of files) {
    if (wantsCreate) {
      steps.push({ name: 'write_file', args: { path: f, content: `// ${f}\n// Created by the mock agent\nexport function hello(name) {\n  return \`Hello, \${name}!\`\n}\n` } })
    } else {
      steps.push({ name: 'read_file', args: { path: f } })
      if (wantsEdit) steps.push({ name: 'edit_file', args: { path: f, __insertTop: true } })
    }
  }
  if (!files.length) steps.push({ name: 'grep_search', args: { query: 'function' } })
  const serve = /serve|server|dev server|啟動服務|启动服务|preview|預覽|预览/i.test(user)
  const port = /(?:port|:)\s*(\d{4,5})/i.exec(user)?.[1] || '5199'
  if (serve) {
    const dir = /\bin\s+([\w\-./]+)\//.exec(user)?.[1] || /\b(site|public|web|app)\b/.exec(user)?.[1] || ''
    steps.push({ name: 'start_background_process', args: { command: `python3 -m http.server ${port} --bind 127.0.0.1`, cwd: dir, wait_seconds: 2 } })
    steps.push({ name: 'fetch_url', args: { url: `http://localhost:${port}/` } })
  } else if (cmd) steps.push({ name: 'run_terminal_command', args: { command: cmd } })
  return steps
}

function commentFor(path: string) {
  if (/\.(py|sh|rb)$/.test(path)) return '# Edited by the mock agent'
  if (/\.(md|html)$/.test(path)) return '<!-- Edited by the mock agent -->'
  if (/\.css$/.test(path)) return '/* Edited by the mock agent */'
  if (/\.json$/.test(path)) return null
  return '// Edited by the mock agent'
}

mock.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json()
  const msgs: any[] = body.messages || []
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break }
  const user = String(msgs[lastUser]?.content ?? '')
  const after = msgs.slice(lastUser + 1)
  const toolMsgs = after.filter((m) => m.role === 'tool')
  // collect file contents that were read (for edit_file old_string)
  const fileContents: Record<string, string> = {}
  const steps = plan(user, fileContents)
  const idx = toolMsgs.length
  let next: Step | null = steps[idx] || null
  const hasTools = Array.isArray(body.tools) && body.tools.length
  if (!hasTools) next = null
  if (next && hasTools && !body.tools.some((t: any) => t.function?.name === next!.name)) next = null // ask mode
  if (next?.args?.__insertTop) {
    const readMsg = [...toolMsgs].reverse().find((m) => /^File: /.test(m.content))
    const firstLine = readMsg ? (readMsg.content.split('\n')[1] || '').replace(/^\s*\d+\| /, '') : ''
    const cm = commentFor(next.args.path)
    if (!firstLine || !cm) next = steps[idx + 1] ? steps[idx + 1] : null
    else next = { name: 'edit_file', args: { path: next.args.path, old_string: firstLine, new_string: `${cm}\n${firstLine}` } }
  }
  const model = body.model || 'mock'
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2)
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: any, finish: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })

  const text = next
    ? idx === 0 ? `I'll start by exploring the workspace to understand the project structure.` : ''
    : idx === 0 && !hasTools
      ? `Hello! I'm the **mock model**. You said: "${user.slice(0, 200)}"`
      : `Done. Here's a summary of what I did:\n\n${toolMsgs.map((m, i) => `${i + 1}. \`${steps[i]?.name ?? 'tool'}\` — ${String(m.content).split('\n')[0].slice(0, 100)}`).join('\n')}\n\n> This response comes from the built-in **mock model**. Configure a real OpenAI-compatible endpoint in Settings for real results.`

  if (!body.stream) {
    return c.json({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, tool_calls: next ? [{ id: 'call_' + Math.random().toString(36).slice(2), type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] : undefined }, finish_reason: next ? 'tool_calls' : 'stop' }] })
  }
  return streamSSE(c, async (s) => {
    await s.writeSSE({ data: JSON.stringify(chunk({ role: 'assistant', content: '' })) })
    for (const w of text.match(/\S+\s*|\s+/g) || []) {
      await s.writeSSE({ data: JSON.stringify(chunk({ content: w })) })
      await s.sleep(15)
    }
    if (next) {
      const argStr = JSON.stringify(next.args)
      const callId = 'call_' + Math.random().toString(36).slice(2)
      await s.writeSSE({ data: JSON.stringify(chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: next.name, arguments: '' } }] })) })
      for (let i = 0; i < argStr.length; i += 24) {
        await s.writeSSE({ data: JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + 24) } }] })) })
        await s.sleep(5)
      }
      await s.writeSSE({ data: JSON.stringify(chunk({}, 'tool_calls')) })
    } else await s.writeSSE({ data: JSON.stringify(chunk({}, 'stop')) })
    await s.writeSSE({ data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) })
    await s.writeSSE({ data: '[DONE]' })
  })
})

mock.get('/v1/models', (c) => c.json({ object: 'list', data: [{ id: 'mock', object: 'model' }] }))
