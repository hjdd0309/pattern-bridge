'use strict';
module.exports = {
  apps: [
    {
      name: 'pattern-bridge-collector',
      script: 'src/collector/main.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Secrets/endpoints live in .env (loaded by config/config.ts)
    },
  ],
};
