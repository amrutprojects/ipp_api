/* PM2: pm2 start ecosystem.config.cjs. One process: the rate limits are counted in its memory. */
module.exports = {
  apps: [
    {
      name: 'ipp-backend',
      script: 'dist/server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '600M',
      kill_timeout: 20000,
    },
  ],
};
