'use strict';
module.exports = {
  apps: [
    {
      name: 'pattern-bridge',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        OPENCLAW_WEBHOOK_URL: 'http://127.0.0.1:18789/hooks/agent',
        OPENCLAW_TOKEN: 'pattern-bridge-secret',
      },
    },
  ],
};
