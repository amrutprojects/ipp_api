import crypto from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { DatabaseError } from 'pg';
import type { z } from 'zod';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError, ERROR_CODES, type FieldError } from './errors';
import { fail } from './respond';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/* An id for every request: in the answer's header, in error answers and in every log line. */
export const requestId: RequestHandler = (req, res, next) => {
  const given = req.header(REQUEST_ID_HEADER);
  const id = given && /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : crypto.randomUUID();
  res.locals.requestId = id;
  (req as Request & { id: string }).id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};

/* Passes a rejected promise of a handler to the error handler. */
export const handle =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

export const limiter = (max: number): RequestHandler =>
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => fail(res, 429, 'Too many requests. Please try again later.', ERROR_CODES.RATE_LIMITED),
  });

export const zodDetails = (issues: z.ZodIssue[], prefix: string): FieldError[] =>
  issues.flatMap((i) =>
    /* An unknown key is named itself, not its parent. */
    i.code === 'unrecognized_keys'
      ? i.keys.map((k) => ({ field: [prefix, ...i.path, k].join('.'), message: 'Unknown field' }))
      : [{ field: [prefix, ...i.path].join('.'), message: i.message }],
  );

interface Schemas {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
}

/* Checks the request; the parsed values are read with `input(req)`. All problems are answered together (422). */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    const details: FieldError[] = [];
    const parsed: Record<string, unknown> = {};
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) parsed[part] = result.data;
      else details.push(...zodDetails(result.error.issues, part));
    }
    if (details.length) return next(AppError.validation(details));
    (req as Request & { input?: unknown }).input = parsed;
    next();
  };

export const input = <T>(req: Request): T => (req as Request & { input: T }).input;

/* Unknown routes: a JSON 404 in the usual shape. */
export const notFound: RequestHandler = (req, res) =>
  fail(res, 404, `Route not found: ${req.method} ${req.path}`, ERROR_CODES.ROUTE_NOT_FOUND);

const PG = { unique: '23505', foreignKey: '23503', check: '23514' };
/* A value the database cannot hold: not of the type, out of range, a character it refuses, too long. */
const PG_VALUE = ['22P02', '22003', '22021', '22001', '22P05'];

/* The one error handler. SQL, stack traces and settings never reach the client; they go to the log with the request id. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const id = res.locals.requestId as string | undefined;
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, requestId: id }, err.message);
    return fail(res, err.status, err.message, err.code, err.details);
  }
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'Malformed JSON body', ERROR_CODES.BAD_REQUEST);
  if (err?.type === 'entity.too.large') return fail(res, 413, 'Request body too large', ERROR_CODES.PAYLOAD_TOO_LARGE);
  if (err instanceof URIError) return fail(res, 400, 'Invalid request', ERROR_CODES.BAD_REQUEST);
  if (err instanceof DatabaseError) {
    logger.warn({ requestId: id, code: err.code, constraint: err.constraint }, 'database constraint');
    if (err.code === PG.unique) return fail(res, 409, 'A record with the same unique value already exists', ERROR_CODES.CONFLICT);
    if (err.code === PG.foreignKey) return fail(res, 409, 'The operation conflicts with related records', ERROR_CODES.CONFLICT);
    if (err.code === PG.check || PG_VALUE.includes(err.code ?? ''))
      return fail(res, 400, 'Invalid value', ERROR_CODES.BAD_REQUEST);
  }
  logger.error({ err, requestId: id }, 'unhandled error');
  return fail(res, 500, 'Something went wrong. Please try again.', ERROR_CODES.INTERNAL_ERROR);
};
