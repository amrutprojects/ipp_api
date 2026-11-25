import { exclusively, pool, transaction } from '../../db/pool';
import { logger } from '../../lib/logger';
import { callSarthi, linkReady, MESSAGES_PATH, type Answer, type Fetch } from './client';
import { buildMessage } from './message';
import { dueMessages, type OutboxRow } from './outbox';

/*
 * Sends the messages to Sarthi, one after the other, first come, first served within a batch: while one is not sent, the
 * later ones of its batch wait, other batches go on. One worker at a time, across processes.
 */
const MINUTE = 60_000;
const WAITS = [MINUTE / 2, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 30 * MINUTE];
/* How long to wait after the nth try that failed: 30 s, 1, 2, 5, 10, 30 min, then an hour. */
export const waitAfter = (attempts: number): number => WAITS[attempts - 1] ?? 60 * MINUTE;

class Busy extends Error {}
const LOCK = 'sarthi-link-worker';

export interface LinkWorkerDeps {
  fetch: Fetch;
  now: () => Date;
  /* The server is stopping: no further message. */
  stopping?: () => boolean;
}
export interface RunResult {
  sent: number;
  failed: number;
  later: number;
}

export function createLinkWorker(deps: LinkWorkerDeps) {
  async function send(m: OutboxRow, result: RunResult): Promise<void> {
    const now = deps.now();
    /* Read in one transaction: the batch, the forms and their documents belong together. */
    let answer: Answer;
    try {
      const message = await transaction((db) => buildMessage(db, m, now));
      /* A deleted batch: nothing to say. */
      answer = message
        ? await callSarthi(deps.fetch, 'POST', MESSAGES_PATH, JSON.stringify(message), now)
        : { kind: 'done', data: { id: m.id } };
    } catch (err) {
      logger.error({ err, message: m.id, kind: m.kind }, 'a message to Sarthi could not be made');
      answer = { kind: 'later', error: 'The message could not be made (see the server log)' };
    }
    const attempts = m.attempts + 1;
    if (answer.kind === 'done' && answer.data.id === m.id) {
      result.sent += 1;
      await pool.query(`UPDATE link_outbox SET status = 'SENT', sent_at = $2, attempts = $3, last_error = NULL WHERE id = $1`, [
        m.id,
        deps.now(),
        attempts,
      ]);
      return;
    }
    const error = answer.kind === 'done' ? 'The answer is not from the Sarthi API (check SARTHI_API_URL)' : answer.error;
    if (answer.kind === 'refused') {
      result.failed += 1;
      logger.error({ message: m.id, kind: m.kind, batch: m.batch_id, error }, 'Sarthi refused a message');
      await pool.query(`UPDATE link_outbox SET status = 'FAILED', attempts = $2, last_error = $3 WHERE id = $1`, [
        m.id,
        attempts,
        error,
      ]);
      return;
    }
    result.later += 1;
    logger.warn({ message: m.id, kind: m.kind, batch: m.batch_id, attempts, error }, 'a message to Sarthi was not sent');
    await pool.query(`UPDATE link_outbox SET attempts = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1`, [
      m.id,
      attempts,
      error,
      new Date(deps.now().getTime() + waitAfter(attempts)),
    ]);
  }

  /* Sends everything that may be sent now; null = the link is off, or another worker is at it. */
  async function run(): Promise<RunResult | null> {
    if (!linkReady()) return null;
    const result: RunResult = { sent: 0, failed: 0, later: 0 };
    try {
      await exclusively(
        LOCK,
        async () => {
          for (;;) {
            const due = await dueMessages(pool, deps.now());
            if (!due.length) return;
            for (const m of due) {
              if (deps.stopping?.()) return;
              await send(m, result);
            }
          }
        },
        () => new Busy(),
      );
    } catch (err) {
      if (err instanceof Busy) return null;
      throw err;
    }
    return result;
  }

  return { run };
}
export type LinkWorker = ReturnType<typeof createLinkWorker>;
