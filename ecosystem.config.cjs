const common = {
  cwd: __dirname,
  interpreter: 'node',
  autorestart: true,
  restart_delay: 30000,
  exp_backoff_restart_delay: 30000,
  max_restarts: 50,
  kill_timeout: 15000,
  time: true,
  merge_logs: true,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'fdfs-radar',
      script: 'dist/index.js',
      max_memory_restart: '1G',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
    },
    {
      ...common,
      name: 'fdfs-dashboard',
      script: 'dist/web/server.js',
      restart_delay: 3000,
      max_memory_restart: '200M',
      out_file: 'logs/dashboard.out.log',
      error_file: 'logs/dashboard.error.log',
    },
  ],
};
