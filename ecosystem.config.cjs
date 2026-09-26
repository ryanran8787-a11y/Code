const fs = require('fs')
const path = require('path')
// Optional local env (e.g. ACCESS_TOKEN) — not committed
const env = { PORT: 3000, NODE_ENV: 'development' }
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2]
  }
} catch {}
module.exports = {
  apps: [{
    name: 'cursorweb',
    script: 'node_modules/.bin/tsx',
    args: 'server/index.ts',
    cwd: __dirname,
    env,
    watch: false, instances: 1, exec_mode: 'fork', max_memory_restart: '400M',
  }],
}
