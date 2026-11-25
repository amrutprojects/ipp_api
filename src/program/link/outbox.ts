import { one, rows, type Db } from '../../db/pool';

/*
 * The messages to Sarthi (table link_outbox). One is added in the transaction of the change it tells of, so either both are
 * kept or neither is; the worker sends it later (worker.ts).
 */
export type MessageKind = 'BATCH' | 'BATCH_UPDATE' | 'RESUBMIT' | 'UPDATE';
export type MessageStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface OutboxRow {
  seq: number;
  id: string;
  kind: MessageKind;
  batch_id: string;
  application_id: string | null;
  status: MessageStatus;
  attempts: number;
}

/*
 * Until the transaction ends nobody else adds a message of this batch: seq is the order of the changes. Batches are locked
 * after the applications, and several in one order, so no two changes wait for each other.
 */
const lockBatches = (db: Db, ids: string[]) =>
  db.query(`SELECT 1 FROM batches WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`, [ids]);

/* A new batch, or a changed one. */
export async function enqueueBatch(db: Db, kind: 'BATCH' | 'BATCH_UPDATE', batchId: string): Promise<void> {
  await lockBatches(db, [batchId]);
  await db.query(`INSERT INTO link_outbox (kind, batch_id) VALUES ($1, $2)`, [kind, batchId]);
}

/*
 * A student of a batch: sent again after the correction (RESUBMIT), or corrected where the form is now (UPDATE). Nothing for
 * a form that is in no batch, or finally approved. The rows of the applications are locked by the caller.
 */
export async function enqueueApplications(db: Db, kind: 'RESUBMIT' | 'UPDATE', applicationIds: string[]): Promise<void> {
  const list = await rows<{ id: string; batch_id: string }>(
    `SELECT id, batch_id FROM applications
     WHERE id = ANY($1::uuid[]) AND batch_id IS NOT NULL AND approval_stage IS DISTINCT FROM 'APPROVED' ORDER BY id`,
    [applicationIds],
    db,
  );
  if (!list.length) return;
  await lockBatches(db, [...new Set(list.map((a) => a.batch_id))]);
  await db.query(
    `INSERT INTO link_outbox (kind, batch_id, application_id)
     SELECT $1, batch_id, id FROM unnest($2::uuid[], $3::uuid[]) AS t (id, batch_id) ORDER BY id`,
    [kind, list.map((a) => a.id), list.map((a) => a.batch_id)],
  );
}

/* Batches nothing was ever sent of (made by an older server): queued once. */
export async function enqueueMissingBatches(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO link_outbox (kind, batch_id)
     SELECT 'BATCH', b.id FROM batches b
     WHERE b.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM link_outbox m WHERE m.batch_id = b.id)
       AND EXISTS (SELECT 1 FROM applications p WHERE p.batch_id = b.id AND p.deleted_at IS NULL AND p.approval_stage IS NOT NULL)
     ORDER BY b.created_at, b.id`,
  );
  return rowCount ?? 0;
}

/* The first message of each batch that is not sent: what comes after it waits. Those that may be tried now, in order. */
export const dueMessages = (db: Db, now: Date, limit = 50): Promise<OutboxRow[]> =>
  rows<OutboxRow>(
    `SELECT seq, id, kind, batch_id, application_id, status, attempts FROM (
       SELECT DISTINCT ON (batch_id) * FROM link_outbox WHERE status <> 'SENT' ORDER BY batch_id, seq
     ) head
     WHERE status = 'PENDING' AND next_attempt_at <= $1 ORDER BY seq LIMIT $2`,
    [now, limit],
    db,
  );

/* Tried again now: the given ones, those of a batch, or all. A waiting one does not wait any longer. */
export async function retryMessages(db: Db, which: { ids?: string[]; batchId?: string }): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE link_outbox SET status = 'PENDING', next_attempt_at = now(), attempts = CASE WHEN status = 'FAILED' THEN 0 ELSE attempts END
     WHERE status <> 'SENT' AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR batch_id = $2::uuid)`,
    [which.ids ?? null, which.batchId ?? null],
  );
  return rowCount ?? 0;
}

/* Where each batch's messages are: the first one not sent decides. A batch without messages is not in the map. */
export interface BatchSync {
  status: 'SENT' | 'WAITING' | 'FAILED';
  error: string | null;
  sent_at: Date | null;
}
export async function batchSync(ids: string[], db: Db): Promise<Map<string, BatchSync>> {
  const list = await rows<{
    batch_id: string;
    head: MessageStatus | null;
    error: string | null;
    sent_at: Date | null;
  }>(
    `SELECT m.batch_id, max(m.sent_at) AS sent_at,
            (array_agg(m.status ORDER BY m.seq) FILTER (WHERE m.status <> 'SENT'))[1] AS head,
            (array_agg(m.last_error ORDER BY m.seq) FILTER (WHERE m.status <> 'SENT'))[1] AS error
     FROM link_outbox m WHERE m.batch_id = ANY($1::uuid[]) GROUP BY m.batch_id`,
    [ids],
    db,
  );
  return new Map(
    list.map((r) => [
      r.batch_id,
      {
        status: r.head === null ? 'SENT' : r.head === 'FAILED' ? 'FAILED' : 'WAITING',
        error: r.head === null ? null : r.error,
        sent_at: r.sent_at,
      },
    ]),
  );
}

export interface LinkItem {
  id: string;
  kind: MessageKind;
  batch: { id: string; code: string; name: string };
  student: { id: string; name: string; registration_id: string | null } | null;
  status: MessageStatus;
  attempts: number;
  next_attempt_at: Date;
  error: string | null;
  created_at: Date;
}
/* What is not sent, oldest first. */
export async function unsentMessages(db: Db, limit = 100): Promise<LinkItem[]> {
  const list = await rows<
    Omit<LinkItem, 'batch' | 'student'> & {
      batch_id: string;
      batch_code: string;
      batch_name: string;
      account_id: string | null;
      student_name: string | null;
      registration_code: string | null;
    }
  >(
    `SELECT m.id, m.kind, m.status, m.attempts, m.next_attempt_at, m.last_error AS error, m.created_at,
            b.id AS batch_id, b.code AS batch_code, b.name AS batch_name,
            a.id AS account_id, a.full_name AS student_name, p.registration_code
     FROM link_outbox m JOIN batches b ON b.id = m.batch_id
     LEFT JOIN applications p ON p.id = m.application_id LEFT JOIN student_accounts a ON a.id = p.account_id
     WHERE m.status <> 'SENT' ORDER BY m.seq LIMIT $1`,
    [limit],
    db,
  );
  return list.map(({ batch_id, batch_code, batch_name, account_id, student_name, registration_code, ...m }) => ({
    ...m,
    batch: { id: batch_id, code: batch_code, name: batch_name },
    student: account_id ? { id: account_id, name: student_name!, registration_id: registration_code } : null,
  }));
}

export const messageCounts = async (db: Db) =>
  (await one<{ pending: number; failed: number; last_sent_at: Date | null; last_received_at: Date | null }>(
    `SELECT (SELECT count(*) FROM link_outbox WHERE status = 'PENDING') AS pending,
            (SELECT count(*) FROM link_outbox WHERE status = 'FAILED') AS failed,
            (SELECT max(sent_at) FROM link_outbox) AS last_sent_at,
            (SELECT max(received_at) FROM link_inbound) AS last_received_at`,
    [],
    db,
  ))!;
