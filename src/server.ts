import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { pending } from './db/migrate';
import { pool } from './db/pool';
import { logger } from './lib/logger';

/* Starts only on a database that is up to date; stops cleanly (requests in progress are finished first). */
async function start(): Promise<void> {
  await pool.query('SELECT 1');
  const missing = await pending();
  if (missing.length) {
    logger.fatal({ missing }, 'the database has pending migrations: run "npm run db:migrate" first');
    process.exit(1);
  }
  const server = http.createServer(createApp());
  /* Longer than a load balancer's idle time, so it never reuses a connection that is being closed. */
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.listen(config.port, () => logger.info({ port: config.port, prefix: config.apiPrefix }, 'server listening'));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 15_000).unref();
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

start().catch((err) => {
  logger.fatal({ err }, 'could not start');
  process.exit(1);
});
