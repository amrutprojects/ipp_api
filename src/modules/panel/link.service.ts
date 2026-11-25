import type { Request } from 'express';
import { config } from '../../config';
import { pool, transaction } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { callSarthi, linkReady, PING_PATH } from '../../program/link/client';
import { messageCounts, retryMessages, unsentMessages } from '../../program/link/outbox';
import { kickLink } from '../../program/link/runtime';
import { audit } from '../../services/audit';
import { actor } from './common';
import type { RetryBody } from './link.schemas';

/* The link to Sarthi, as the Auditor sees it: whether it is on, and what is not sent and why. */
export async function linkStatus() {
  const { enabled, url, secret } = config.link;
  const [counts, items] = await Promise.all([messageCounts(pool), unsentMessages(pool)]);
  return {
    enabled,
    configured: !!url && !!secret,
    host: url ? new URL(url).host : null,
    ...counts,
    items,
  };
}

export async function retry(req: Request, user: PanelUser, body: RetryBody) {
  const retried = await transaction(async (db) => {
    const n = await retryMessages(db, { ids: body.ids, batchId: body.batch_id });
    await audit.inTx(db, req, {
      action: 'edp.link.retry',
      resource: 'link',
      resourceId: body.batch_id ?? null,
      actor: actor(user),
      details: { messages: n },
    });
    return n;
  });
  kickLink();
  return { retried };
}

/* Whether Sarthi answers, and knows the secret. */
export async function testLink() {
  if (!linkReady())
    return { ok: false, message: config.link.enabled ? 'The connection is not set up.' : 'The connection is switched off.' };
  const answer = await callSarthi(fetch, 'GET', PING_PATH, '', new Date());
  return answer.kind === 'done' ? { ok: true, message: 'Sarthi answered.' } : { ok: false, message: answer.error };
}
