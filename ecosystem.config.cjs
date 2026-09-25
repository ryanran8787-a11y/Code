module.exports = {
  apps: [{
    name: 'cursorweb',
    script: 'node_modules/.bin/tsx',
    args: 'server/index.ts',
    cwd: __dirname,
    env: { PORT: 3000, NODE_ENV: 'development' },
    watch: false, instances: 1, exec_mode: 'fork', max_memory_restart: '400M',
  }],
}
