# CursorWeb — a Web AI coding tool that reproduces Cursor 3's core experience

Built on the open-source VS Code stack: the editor core is **Monaco** (VS Code's editor), the color theme is **2026 Dark** taken straight from `microsoft/vscode/extensions/theme-defaults/themes`, and the icons are **codicons**. Two window modes are supported:

| Window | Purpose | Layout |
|---|---|---|
| **Editor Window** | Traditional code editor for browsing and editing code by hand | Activity bar · Explorer/Search/Agents · multi-tab Monaco · terminal panel · Agent side panel on the right · status bar |
| **Agents Window** | Agent-first workbench for launching autonomous agents and running several in parallel | Agent list (In Progress / Ready for Review / Recent) · agent tabs (single / side-by-side / 4-grid) · Review panel on the right (Changes diff / Files) |

Both windows share one set of state: files, Monaco models and agents. Switch between them from the title bar or with `Ctrl+Shift+A` / `Ctrl+Shift+E`.

## Implemented features
- **Editor Window**: file tree (create, rename, delete, context menu, agent-touched highlight), preview/pinned tabs, drag to reorder tabs, dirty markers, `Ctrl+S`, breadcrumbs, minimap / sticky scroll / bracket colorization, full-text search (ripgrep, regex, case sensitivity, glob), terminal panel (streamed output, history, Ctrl+C), status bar
- **Agent runtime** (`server/agent.ts`): autonomous tool-call loop against an OpenAI-compatible `chat.completions` API with streaming output. Tools: `list_dir` `read_file` `grep_search` `file_search` `edit_file` `write_file` `delete_file` `run_terminal_command` `update_todos`
- **Parallel agents**: any number of agents run concurrently on the server; the status of each one is pushed to every window live over SSE
- **Safety / review**: terminal commands wait for approval by default (Run / Skip; can switch to auto-run). Every agent file change is snapshotted, so you can Keep or Undo per file or all at once and review in the Monaco diff editor
- **Ask / Agent modes** and a model picker; `@` adds file context; `Ctrl+L` sends the editor selection to Agent chat
- Command palette `Ctrl+Shift+P`, quick open `Ctrl+P`, `Ctrl+N` for a new agent, `` Ctrl+` `` for the terminal, `Ctrl+B` for the sidebar
- Agent history is persisted (`.cursorweb/agents/*.json`)
- Built-in **mock model** (set Base URL to `mock`) for offline demos and automated tests

## Entry points (paths)
- `/#agents`, `/#editor`: the two windows
- REST: `GET /api/tree` · `GET/PUT /api/file` · `POST /api/fs/{mkdir,delete,rename}` · `GET /api/search` · `POST /api/terminal/run` (SSE)
- Agents: `GET/POST /api/agents` · `GET/PATCH/DELETE /api/agents/:id` · `POST /api/agents/:id/{messages,stop,approve,read}` · `GET /api/agents/:id/changes` · `POST /api/agents/:id/changes/resolve`
- Live events: `GET /api/events` (SSE) · settings: `GET/PUT /api/settings`, `POST /api/settings/test`

## Running it
```bash
npm install
npm start                      # http://localhost:3000
WORKSPACE=/path/to/project npm start   # choose the workspace (default: ./sample-workspace)
ACCESS_TOKEN=secret npm start  # optional: require ?token=secret for access
npm run test:e2e               # Playwright end-to-end tests (uses the mock model)
```
Model settings: open ⚙ Settings in the UI and enter Base URL / API Key / model list. Any OpenAI-compatible endpoint works (OpenAI, DeepSeek, Ollama, vLLM, OpenRouter…). You can also use the `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODELS` / `DEFAULT_MODEL` environment variables. The API key is stored only on the server.

## Architecture
```
server/ (Node + Hono)
  index.ts      routes, SSE, static assets (Monaco / codicons served from node_modules)
  agent.ts      agent loop, parallel runs, approvals, change snapshots, persistence
  tools.ts      tool schemas + implementations (path sandboxing: workspace only)
  workspace.ts  file system / ripgrep / shell
  theme.ts      VS Code theme JSON → Monaco theme + CSS variables
  mock.ts       OpenAI-compatible mock model (streaming + tool_calls)
public/ (no-build ES modules)
  js/main.js            window switching, command palette, shortcuts, settings
  js/editor-window.js   Editor Window        js/agents-window.js  Agents Window
  js/editor-group.js    tabs + Monaco + diff js/chat.js           agent conversation / tool cards / composer
  js/files.js           shared Monaco models  js/agent-store.js    client-side agent state
```
**Why it doesn't deploy to Cloudflare Pages**: agents need a real file system and shell (to read and write code and run commands), which the Workers runtime doesn't provide. So this is a Node service (Hono + @hono/node-server) that can be deployed to any VM, container or Render/Fly.io, just like VS Code Server / code-server.

## Not yet implemented / next steps
- Git worktree isolation (so parallel agents can't overwrite each other's files) and a git diff/commit panel
- Interactive PTY terminal (xterm.js + node-pty) and running long-lived services
- Cloud agents / remote SSH, Design Mode, integrated browser
- Loading real VS Code extensions (would need to move to the full vscode-web / openvscode-server build)
- Context compression for long conversations, token usage display, `@`-mentions for symbols and folders

## Status
- Tech stack: Node 22 · Hono 4 · Monaco 0.52 · OpenAI SDK · Playwright (tests)
- Last updated: 2026-09-26
