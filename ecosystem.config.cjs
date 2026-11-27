module.exports = {
  apps: [
    {
      name: 'fdfs-radar',
      script: 'dist/index.js',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      restart_delay: 30000,
      exp_backoff_restart_delay: 30000,
      max_restarts: 50,
      max_memory_restart: '1G',
      kill_timeout: 15000,
      time: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
