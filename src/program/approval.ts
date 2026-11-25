import { pool, rows, type Db } from '../db/pool';
import { STAGE_NAME, STAGE_STATUS, type ApprovalStage, type StagePoint } from './constants';

/*
 * A submitted form's approval as the lists show it: its stage, the Auditor's approval, the latest event (who moved it where,
 * and a rejection's reason) and its batch. Over applications `p`.
 */
export const APPROVAL_JOINS = `
  LEFT JOIN panel_users apv ON apv.id = p.approved_by
  LEFT JOIN batches bt ON bt.id = p.batch_id AND bt.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT e.action, e.from_stage, e.to_stage, e.reason, e.created_at, coalesce(e.actor_name, eu.name) AS by_name
    FROM approval_events e LEFT JOIN panel_users eu ON eu.id = e.panel_user_id
    WHERE e.application_id = p.id ORDER BY e.seq DESC LIMIT 1
  ) ev ON true`;

export const APPROVAL_COLUMNS = `p.approval_stage, p.stage_updated_at, p.approved_at, apv.name AS approved_by_name,
  ev.action AS last_action, ev.from_stage AS last_from, ev.to_stage AS last_to, ev.reason AS last_reason,
  ev.created_at AS last_at, ev.by_name AS last_by, bt.id AS batch_id, bt.name AS batch_name, p.registration_code AS approval_code`;

export interface ApprovalRow {
  approval_stage: ApprovalStage | null;
  stage_updated_at: Date | null;
  approved_at: Date | null;
  approved_by_name: string | null;
  last_action: 'APPROVE' | 'REJECT' | null;
  last_from: StagePoint | null;
  last_to: StagePoint | null;
  last_reason: string | null;
  last_at: Date | null;
  last_by: string | null;
  batch_id: string | null;
  batch_name: string | null;
  approval_code: string | null;
}

const point = (s: StagePoint) => ({ stage: s, name: STAGE_NAME[s] });

export const approvalDto = (r: ApprovalRow) => ({
  /* null = with the Auditor (not approved yet, or sent back); BATCH = waiting for a batch. */
  stage: r.approval_stage,
  stage_label: r.approval_stage ? STAGE_STATUS[r.approval_stage] : null,
  stage_updated_at: r.stage_updated_at,
  /* The Auditor's latest approval. */
  approved_at: r.approved_at,
  approved_by: r.approved_by_name,
  /* The latest move: an approval to the next stage, or a rejection back one stage (with its reason). */
  last_event: r.last_action
    ? {
        action: r.last_action,
        from: point(r.last_from!),
        to: point(r.last_to!),
        reason: r.last_reason,
        by: r.last_by,
        at: r.last_at,
      }
    : null,
  /* Finally approved: the registration ID is the student's record. */
  register_id: r.approval_stage === 'APPROVED' ? r.approval_code : null,
  batch: r.batch_id ? { id: r.batch_id, name: r.batch_name } : null,
});

/* Every move of one application between stages, newest first. */
export async function approvalHistory(applicationId: string, db: Db = pool) {
  const events = await rows<{
    action: 'APPROVE' | 'REJECT';
    from_stage: StagePoint;
    to_stage: StagePoint;
    reason: string | null;
    by: string | null;
    created_at: Date;
  }>(
    `SELECT e.action, e.from_stage, e.to_stage, e.reason, coalesce(e.actor_name, u.name) AS by, e.created_at
     FROM approval_events e LEFT JOIN panel_users u ON u.id = e.panel_user_id
     WHERE e.application_id = $1 ORDER BY e.seq DESC`,
    [applicationId],
    db,
  );
  return events.map((e) => ({
    action: e.action,
    from: point(e.from_stage),
    to: point(e.to_stage),
    reason: e.reason,
    by: e.by,
    at: e.created_at,
  }));
}

/* Where the students of each batch are now (AUDITOR = sent back to the Auditor), and how many were last sent back. */
export type BatchPlace = 'AUDITOR' | 'DIVISION' | 'COEP' | 'HEAD_OFFICE' | 'ADMIN' | 'APPROVED';
export interface BatchProgress {
  students: number;
  stages: Record<BatchPlace, number>;
  rejected: number;
}
export async function batchProgress(ids: string[], db: Db = pool): Promise<Map<string, BatchProgress>> {
  const out = new Map<string, BatchProgress>(
    ids.map((id) => [
      id,
      { students: 0, stages: { AUDITOR: 0, DIVISION: 0, COEP: 0, HEAD_OFFICE: 0, ADMIN: 0, APPROVED: 0 }, rejected: 0 },
    ]),
  );
  if (!ids.length) return out;
  const counts = await rows<{ batch_id: string; stage: BatchPlace; n: number; rejected: number }>(
    `SELECT p.batch_id, coalesce(p.approval_stage, 'AUDITOR') AS stage, count(*)::int AS n,
            (count(*) FILTER (WHERE ev.action = 'REJECT'))::int AS rejected
     FROM applications p
     LEFT JOIN LATERAL (SELECT e.action FROM approval_events e WHERE e.application_id = p.id ORDER BY e.seq DESC LIMIT 1) ev ON true
     WHERE p.batch_id = ANY($1::uuid[]) AND p.deleted_at IS NULL GROUP BY 1, 2`,
    [ids],
    db,
  );
  for (const r of counts) {
    const b = out.get(r.batch_id)!;
    b.stages[r.stage] = r.n;
    b.students += r.n;
    b.rejected += r.rejected;
  }
  return out;
}

/* Records a move between stages by a panel user (inside the transaction that makes it). */
export async function recordMove(
  db: Db,
  move: {
    applicationId: string;
    action: 'APPROVE' | 'REJECT';
    from: StagePoint;
    to: StagePoint;
    reason?: string | null;
    by: { id: string; name: string };
  },
): Promise<void> {
  await db.query(
    `INSERT INTO approval_events (application_id, action, from_stage, to_stage, reason, actor_kind, panel_user_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, 'PANEL', $6, $7)`,
    [move.applicationId, move.action, move.from, move.to, move.reason ?? null, move.by.id, move.by.name],
  );
}
