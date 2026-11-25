import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../../src/config';
import type { LinkMessage } from '../../src/program/link/message';
import { linkIdle } from '../../src/program/link/runtime';
import { isSigned, signedHeaders } from '../../src/program/link/signature';
import { app } from './factory';
import supertest from 'supertest';

/* A stand-in for Sarthi: its API as IPP calls it, and its calls of IPP. */
export const SECRET = 'test-link-secret-0123456789-abcdef-0123456789';

const OFF = { enabled: false, url: null, secret: null };
export const linkOff = () => Object.assign(config.link, OFF);
/* Off, once the server's own sender has done what the test asked for: it must not meet the next test's empty tables. */
export const linkStop = async () => {
  await linkIdle();
  linkOff();
};
/* The link is on; `url` is where Sarthi answers (nowhere by default). */
export const linkOn = (url = 'http://127.0.0.1:9') => Object.assign(config.link, { enabled: true, url, secret: SECRET });

type Body = Record<string, unknown>;
export interface Reply {
  status: number;
  body?: Body | string;
}
export interface Received {
  path: string;
  method: string;
  signed: boolean;
  message: LinkMessage & { sent_at: string };
}

/* Answers every message as Sarthi does, unless `replies` holds another answer for the next ones. */
export async function fakeSarthi() {
  const received: Received[] = [];
  const replies: (Reply | 'drop')[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(parts);
      const headers = { authorization: req.headers.authorization, timestamp: req.headers['x-timestamp'] as string | undefined };
      /* The tests move the clock of the sender; the age of a call is tested where IPP checks it. */
      const at = new Date(Number(headers.timestamp) * 1000);
      const signed = isSigned(SECRET, 'ipp', headers, { method: req.method!, path: req.url!, body: raw }, at);
      const message = (raw.length ? JSON.parse(raw.toString('utf8')) : null) as Received['message'];
      received.push({ path: req.url!, method: req.method!, signed, message });
      const next = replies.shift();
      if (next === 'drop') {
        req.socket.destroy();
        return;
      }
      const data = message
        ? { id: message.id, duplicate: false, applications: [] }
        : { ok: true, time: new Date().toISOString() };
      const reply: Reply = next ?? {
        status: signed ? 200 : 401,
        body: signed
          ? { success: true, status: 200, message: 'ok', data }
          : { success: false, error: { code: 'LINK_UNAUTHORIZED' } },
      };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    received,
    /* The messages, as kind and batch or student. */
    messages: () => received.filter((r) => r.message).map((r) => r.message),
    replies,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
export type FakeSarthi = Awaited<ReturnType<typeof fakeSarthi>>;

/* A call of Sarthi's server. `over` breaks something about its signature. */
export function sarthiCalls(
  method: 'get' | 'post',
  path: string,
  body?: object | string,
  over: { client?: 'ipp' | 'sarthi'; secret?: string; now?: Date; signedBody?: string; signedPath?: string } = {},
) {
  const full = `/api/v1/link${path}`;
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const headers = signedHeaders(
    over.secret ?? SECRET,
    { client: over.client ?? 'sarthi', method, path: over.signedPath ?? full, body: over.signedBody ?? raw },
    over.now ?? new Date(),
  );
  const r = supertest(app)[method](full).set(headers);
  return body === undefined ? r : r.set('Content-Type', 'application/json').send(raw);
}
