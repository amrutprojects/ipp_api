import { Router } from 'express';
import { pool } from '../../db/pool';
import { handle } from '../../http/middleware';
import { fail, ok } from '../../http/respond';
import { logger } from '../../lib/logger';

/* /health: the process answers. /health/ready: so does the database (for the load balancer and monitoring). */
export const healthRouter = Router();

healthRouter.get('/', (_req, res) => ok(res, { status: 'ok' }, 'Service is running'));

healthRouter.get(
  '/ready',
  handle(async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      ok(res, { status: 'ok', database: 'ok' }, 'Service is ready');
    } catch (err) {
      logger.error({ err }, 'the database does not answer');
      fail(res, 503, 'Service is not ready', 'SERVICE_UNAVAILABLE');
    }
  }),
);
