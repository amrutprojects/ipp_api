import { pool } from '../../db/pool';
import { logger } from '../../lib/logger';
import { linkReady } from './client';
import { enqueueMissingBatches } from './outbox';
import { createLinkWorker } from './worker';

/* The worker of this server: every POLL_MS, and at once after a change (kickLink, after the commit). */
const POLL_MS = 15_000;

let stopping = false;
const worker = createLinkWorker({ fetch: (...args) => fetch(...args), now: () => new Date(), stopping: () => stopping });
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let again = false;

function run(): void {
  if (stopping || !linkReady()) return;
  /* Asked for while it runs: once more afterwards, for what was added meanwhile. */
  if (running) {
    again = true;
    return;
  }
  running = worker
    .run()
    .then(
      () => undefined,
      (err: unknown) => logger.error({ err }, 'sending to Sarthi failed'),
    )
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        run();
      }
    });
}

export const kickLink = (): void => {
  if (linkReady()) setImmediate(run);
};

/* What was asked for so far is done (the tests wait for it before they empty the tables). */
export async function linkIdle(): Promise<void> {
  await new Promise((done) => setImmediate(done));
  while (running) await running;
}

export async function startLink(): Promise<void> {
  const queued = await enqueueMissingBatches(pool);
  if (queued) logger.info({ queued }, 'batches queued for Sarthi');
  timer = setInterval(run, POLL_MS);
  timer.unref();
  kickLink();
}

/* No new run; the one that is on ends with the message it is sending. */
export async function stopLink(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  await running;
}
