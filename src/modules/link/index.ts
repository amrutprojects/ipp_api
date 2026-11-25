import express, { Router, type RequestHandler } from 'express';
import { config } from '../../config';
import { Api } from '../../http/api';
import { AppError, ERROR_CODES } from '../../http/errors';
import { limiter } from '../../http/middleware';
import { ok } from '../../http/respond';
import { isSigned } from '../../program/link/signature';
import { decisionsBody, documentParams } from './link.schemas';
import { decideAll, sendDocument } from './link.service';

/*
 * What Sarthi's server calls (docs/SARTHI_LINK.md, section 3): signed with the shared secret, nobody signs in. It is no part of
 * the portal's API, and has a limit of its own.
 */
const linkApi = new Api('Link');
const api = linkApi;

api.get('/ping', { auth: 'public', summary: 'Whether the link works', returns: '{ ok, time }' }, ({ res }) =>
  ok(res, { ok: true, time: new Date().toISOString() }),
);

api.post(
  '/decisions',
  { auth: 'public', summary: 'Decisions of the officers', returns: '{ results }', body: decisionsBody },
  async ({ req, res, body }) => ok(res, { results: await decideAll(req, body.decisions) }),
);

api.get(
  '/applications/:id/documents/:code',
  {
    auth: 'public',
    summary: 'A document of a student in a batch',
    file: 'application/octet-stream',
    params: documentParams,
    notFound: 'There is no such document',
  },
  ({ res, params }) => sendDocument(res, params.id, params.code),
);

/* 100 decisions with the longest reasons fit into it. */
const BODY_LIMIT = '512kb';

/* The signature is of the body as it was sent: it is read first, and understood only when the signature is right. */
const requireSarthi: RequestHandler = (req, _res, next) => {
  const { enabled, secret } = config.link;
  if (!enabled || !secret)
    return next(AppError.unavailable('The link to Sarthi is not configured', ERROR_CODES.LINK_NOT_CONFIGURED));
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const headers = { authorization: req.header('authorization'), timestamp: req.header('x-timestamp') };
  if (!isSigned(secret, 'sarthi', headers, { method: req.method, path: req.originalUrl, body }, new Date()))
    return next(AppError.unauthorized('The call is not signed as it should be', ERROR_CODES.LINK_UNAUTHORIZED));
  try {
    req.body = body.length ? (JSON.parse(body.toString('utf8')) as unknown) : undefined;
  } catch {
    return next(AppError.badRequest('Malformed JSON body'));
  }
  next();
};

export function linkRouter(): Router {
  const router = Router();
  router.use(limiter(config.link.rateMax), express.raw({ type: () => true, limit: BODY_LIMIT }), requireSarthi);
  router.use(linkApi.router);
  return router;
}
