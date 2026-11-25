import compression from 'compression';
import cors from 'cors';
import express, { type Express, type Request } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config';
import { env } from './config/env';
import { errorHandler, limiter, notFound, REQUEST_ID_HEADER, requestId } from './http/middleware';
import { logger } from './lib/logger';
import { healthRouter } from './modules/health/health.routes';
import { portalRouter } from './routes';
import { mountDocs } from './openapi';

/* Builds the app (no listening, no database connection), so tests can drive it. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request & { id: string }).id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      /* The query string may hold a name or a mobile number: only the path is logged. */
      serializers: {
        req: (r: { id: string; method: string; url: string }) => ({ id: r.id, method: r.method, path: r.url.split('?')[0] }),
        res: (r: { statusCode: number }) => ({ status: r.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', REQUEST_ID_HEADER],
      exposedHeaders: [REQUEST_ID_HEADER, 'Content-Disposition'],
      maxAge: 600,
    }),
  );
  app.use(compression({ filter: (req, res) => !req.path.endsWith('.zip') && compression.filter(req, res) }));
  app.use(`${config.apiPrefix}/health`, healthRouter);
  app.use(limiter(config.rateLimit.max));
  app.use(express.json({ limit: '100kb' }));

  if (config.apiDocs) mountDocs(app);
  for (const mount of config.portalMounts) app.use(`${config.apiPrefix}${mount}`, portalRouter());

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
