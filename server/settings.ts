import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '.cursorweb'))
fs.mkdirSync(DATA_DIR, { recursive: true })
const FILE = path.join(DATA_DIR, 'settings.json')

export type Settings = {
  baseUrl: string
  apiKey: string
  models: string[]
  defaultModel: string
  autoRunCommands: boolean
  maxSteps: number
  temperature: number | null
  /** approximate context window of the model, in tokens (used for compaction + meter) */
  contextWindow: number
  /** compact when the prompt exceeds this fraction of contextWindow */
  compactAt: number
  defaultEnv: 'local' | 'worktree'
  /** terminal/background commands matching any of these regexes run without asking */
  commandAllowlist: string[]
  /** matching commands are rejected outright (deny wins over allow) */
  commandDenylist: string[]
  /** tried in order when the primary model fails with a retryable error */
  fallbackModels: string[]
  /** retries per model on retryable errors (429/5xx/timeout), exponential backoff */
  retryBudget: number
}

function fromGensparkYaml(): { apiKey?: string; baseUrl?: string } {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.genspark_llm.yaml'), 'utf8')
    const key = /api_key:\s*(\S+)/.exec(txt)?.[1]
    const url = /base_url:\s*(\S+)/.exec(txt)?.[1]
    return { apiKey: key, baseUrl: url }
  } catch { return {} }
}

const y = fromGensparkYaml()
const defaults: Settings = {
  baseUrl: process.env.OPENAI_BASE_URL || y.baseUrl || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || y.apiKey || '',
  models: (process.env.MODELS || 'gpt-5,gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5-codex,gpt-5.2-codex,gpt-5.3-codex').split(',').map((s) => s.trim()).filter(Boolean),
  defaultModel: process.env.DEFAULT_MODEL || 'gpt-5-mini',
  autoRunCommands: false,
  maxSteps: 40,
  temperature: null,
  contextWindow: Number(process.env.CONTEXT_WINDOW || 128000),
  compactAt: 0.8,
  defaultEnv: 'local',
  // one pattern per line; each entry is a full regex (alternation with | is fine inside an entry)
  commandAllowlist: (process.env.COMMAND_ALLOWLIST || '^(npm test|npm run test|ls|pwd|git status|git diff|node --version)(\\s|$)').split('\n').map((s) => s.trim()).filter(Boolean),
  commandDenylist: (process.env.COMMAND_DENYLIST || 'rm\\s+-rf\\s+/(\\s|$)\n:\\(\\)\\s*\\{').split('\n').map((s) => s.trim()).filter(Boolean),
  fallbackModels: (process.env.FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  retryBudget: Number(process.env.RETRY_BUDGET || 2),
}

let current: Settings = { ...defaults }
try { current = { ...defaults, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } } catch { /* first run */ }

export function getSettings(): Settings { return current }

export function publicSettings() {
  const k = current.apiKey
  return { ...current, apiKey: k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '', hasApiKey: !!k }
}

export function updateSettings(patch: Partial<Settings>) {
  const next = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'apiKey' && (typeof v !== 'string' || v.includes('…'))) continue // masked value sent back
    ;(next as any)[k] = v
  }
  for (const k of ['models', 'commandAllowlist', 'commandDenylist', 'fallbackModels'] as const) {
    const v = (next as any)[k]
    if (typeof v === 'string') (next as any)[k] = v.split(k === 'models' || k === 'fallbackModels' ? ',' : '\n').map((s: string) => s.trim()).filter(Boolean)
  }
  current = next
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2))
  return publicSettings()
}
