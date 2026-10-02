# CursorWeb — a Web AI coding tool that reproduces Cursor 3's core experience

Built on the open-source VS Code stack: the editor core is **Monaco** (VS Code's editor), the color theme is **2026 Dark** taken straight from `microsoft/vscode/extensions/theme-defaults/themes`, and the icons are **codicons**. Two window modes are supported:

| Window | Purpose | Layout |
|---|---|---|
| **Editor Window** | Traditional code editor for browsing and editing code by hand | Activity bar · Explorer/Search/Agents · multi-tab Monaco · terminal panel · Agent side panel on the right · status bar |
| **Agents Window** | Agent-first workbench for launching autonomous agents and running several in parallel | Agent list (In Progress / Ready for Review / Recent) · agent tabs (single / side-by-side / 4-grid) · Review panel on the right (Changes diff / Files) |

Both windows share one set of state: files, Monaco models and agents. Switch between them from the title bar or with `Ctrl+Shift+A` / `Ctrl+Shift+E`.

## Implemented features
- **Editor Window**: file tree (create, rename, delete, context menu, agent-touched highlight), preview/pinned tabs, dirty markers, `Ctrl+S`, breadcrumbs, minimap / sticky scroll, full-text search (ripgrep), Go to Symbol `Ctrl+T`, status bar (git branch, agent status)
- **Interactive terminals**: xterm.js + node-pty over WebSocket. A real TTY (vim/top/python REPL all work), multiple terminal tabs, sessions survive page reloads with scrollback; `` Ctrl+` `` to toggle, `` Ctrl+Shift+` `` for a new terminal; localhost links open in the integrated browser
- **Source Control panel** (`Ctrl+Shift+G`): changed / staged / untracked files, Stage / Unstage / Discard, HEAD ↔ working-tree diff (the right-hand side is editable), commit, branch switching / creation, recent commits
- **Agent runtime**: autonomous tool-call loop against an OpenAI-compatible `chat.completions` API with streaming output. Tools:
  `list_dir` `read_file` `grep_search` `file_search` `edit_file` `write_file` `delete_file` `run_terminal_command` `update_todos`
  `start_background_process` `read_process_output` `stop_process` `fetch_url`
- **Parallel agents + git worktree isolation**: when creating an agent, the composer lets you pick **Local** (edits the workspace directly) or **Worktree**, which gives the agent its own `agent/<task>-<id>` branch and its own git worktree. It starts from a snapshot of your current uncommitted work, and `node_modules` is symlinked in.
  - Agents running in parallel don't interfere with each other or with your workspace.
  - **Apply to Workspace** merges each file three-way. If your workspace hasn't diverged, the agent's version is copied in directly. If both sides changed, `git merge-file` merges them automatically.
  - A real conflict returns 409; you can then choose to write `<<<<<<<` markers and resolve them in the editor.
  - You can also Discard the changes, or Commit Branch to commit on the agent's own branch.
- **Background processes / Ports**: agents (or you) start long-running services such as dev servers. Listening ports are detected automatically (log parsing plus `/proc/net/tcp`), and output is kept in a ring buffer.
- **Integrated browser**: the `/preview/<port>/` reverse proxy shows local dev servers even when the IDE itself is remote. It rewrites root-relative URLs and redirects, and captures console errors from the page.
- **Design Mode**: click any element on the page → its selector, size, text and computed styles plus your note become a structured request in the agent's composer
- **@ mentions**: inline popup for files, folders, symbols (lightweight regex index across languages), terminal output and the browser page; chips are expanded into structured context
- **Context management**: estimates the context in use (falls back to the provider's `usage`) and shows a meter in the composer. Past 80% of the window, older turns are summarized by the model and folded into the system prompt; the most recent turns stay verbatim and tool_call/tool pairs are never split. You can also compact manually, and the header shows total in/out tokens.
- **Safety / review**: terminal commands and background processes need approval by default (or switch to auto-run). Local-mode changes are snapshotted so you can Keep or Undo per file; worktree mode reviews via git diff.
- Ask / Agent modes, model picker, Agents Window single / side-by-side / 4-grid layouts, review panel (Changes / Files / Browser)
- Command palette `Ctrl+Shift+P`, quick open `Ctrl+P`, `Ctrl+N` for a new agent; agent history persisted in `.cursorweb/agents/*.json`
- Built-in **mock model** (Base URL `mock`) for offline demos and automated tests

## Entry points (paths)
- `/#agents`, `/#editor`: the two windows
- REST: `GET /api/tree` · `GET/PUT /api/file` · `POST /api/fs/{mkdir,delete,rename}` · `GET /api/search` · `POST /api/terminal/run` (SSE)
- Agents: `GET/POST /api/agents` · `GET/PATCH/DELETE /api/agents/:id` · `POST /api/agents/:id/{messages,stop,approve,read}` · `GET /api/agents/:id/changes` · `POST /api/agents/:id/changes/resolve`
- Git: `GET /api/git/status` · `POST /api/git/{init,stage,unstage,discard,commit,checkout}` · `GET /api/git/show?path=&ref=` · `GET /api/git/branches`
- Worktrees: `POST /api/agents/:id/worktree/{commit,merge,discard}` · `POST /api/agents/:id/changes/resolve {path?,accept,force?}` (409 = conflict) · `POST /api/agents/:id/compact`
- Terminals: `GET/POST /api/terminals` · `DELETE /api/terminals/:id` · WebSocket `/api/terminals/:id/ws`
- Background processes: `GET/POST /api/processes` · `POST /api/processes/:id/stop` · `DELETE /api/processes/:id`
- Browser proxy: `/preview/<port>/<path>` · symbols: `GET /api/symbols?q=`
- Live events: `GET /api/events` (SSE) · settings: `GET/PUT /api/settings`, `POST /api/settings/test`

## Running it
```bash
npm install
npm start                      # http://localhost:3000
WORKSPACE=/path/to/project npm start   # choose the workspace (default: ./workspace, seeded from examples/todo-app on first run)
ACCESS_TOKEN=secret npm start  # optional: require ?token=secret for access
npm run test:e2e               # Playwright end-to-end tests (uses the mock model)
node tests/e2e-v2.mjs          # v2 E2E: terminals / SCM / worktrees / browser / Design Mode / @ mentions
```
Model settings: open ⚙ Settings in the UI and enter Base URL / API Key / model list. Any OpenAI-compatible endpoint works (OpenAI, DeepSeek, Ollama, vLLM, OpenRouter…). You can also use the `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODELS` / `DEFAULT_MODEL` environment variables. The API key is stored only on the server.

## Architecture
```
server/ (Node + Hono)
  index.ts      routes, SSE, static assets (Monaco / codicons served from node_modules)
  agent.ts      agent loop, parallel runs, approvals, change snapshots, context compaction, persistence
  git.ts        Source Control + per-agent worktrees (create / diff / 3-way apply / revert)
  pty.ts        node-pty sessions ↔ WebSocket (xterm.js)
  processes.ts  background processes + port detection
  browser.ts    fetch_url text extraction + /preview reverse proxy + Design Mode injected script
  symbols.ts    workspace symbol index (@ mentions / Ctrl+T)
  tools.ts      tool schemas + implementations (path sandboxing: workspace only)
  workspace.ts  Workspace class (main workspace / per-agent worktree roots): file system / ripgrep / shell
  theme.ts      VS Code theme JSON → Monaco theme + CSS variables
  mock.ts       OpenAI-compatible mock model (streaming + tool_calls)
public/ (no-build ES modules)
  js/main.js            window switching, command palette, shortcuts, settings
  js/editor-window.js   Editor Window        js/agents-window.js  Agents Window
  js/editor-group.js    tabs + Monaco + diff js/chat.js           agent conversation / tool cards / composer
  js/files.js           shared Monaco models  js/agent-store.js    client-side agent state
  js/terminal.js        xterm terminals       js/scm.js            Source Control
  js/browser.js         integrated browser / Design Mode / Ports
```
**Why it doesn't deploy to Cloudflare Pages**: agents need a real file system and shell (to read and write code and run commands), which the Workers runtime doesn't provide. So this is a Node service (Hono + @hono/node-server) that can be deployed to any VM, container or Render/Fly.io, just like VS Code Server / code-server.

## Not yet implemented / next steps
- **Cloud agents / remote SSH**: these need external VM / container infrastructure (e.g. hand worktrees to remote runners over SSH or a container API). The current architecture keeps that seam in the `Workspace` class: swap in a remote implementation and it plugs in.
- **Real VS Code extensions**: this would require moving to the full vscode-web / openvscode-server build (an extension host plus the Node runtime), a different architecture altogether.
- The integrated browser can only preview local ports (by design, for safety); agents can't drive clicks yet (that would need a headless-browser tool such as Playwright).
- The symbol index is regex-based; it could be swapped for an LSP / tree-sitter implementation.
- Multi-root workspaces, PR creation / GitHub integration.

## Status
- Tech stack: Node 22 · Hono 4 · Monaco 0.52 · xterm.js 6 + node-pty · ws · git worktree · OpenAI SDK · Playwright (tests)
- Last updated: 2026-10-02
