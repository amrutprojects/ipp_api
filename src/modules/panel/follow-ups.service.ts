import type { Request } from 'express';
import { one, pool, rows, transaction, type Db } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { FOLLOW_UP_STATUS, type FollowUpStatus } from '../../program/constants';
import { audit } from '../../services/audit';
import { actor, studentAccount } from './common';
import type { FollowUpBody } from './follow-ups.schemas';

/* The calls made to a student at any stage: each is kept, the newest is the student's current follow-up status. */

export interface FollowUpRow {
  status: FollowUpStatus;
  note: string | null;
  created_at: Date;
  by: string | null;
}
export const followUpDto = (f: FollowUpRow) => ({
  status: f.status,
  status_label: FOLLOW_UP_STATUS[f.status],
  note: f.note,
  at: f.created_at,
  by: f.by,
});

/* Newest first. */
export async function followUps(accountId: string, db: Db = pool) {
  await studentAccount(accountId, db);
  const list = await rows<FollowUpRow>(
    `SELECT f.status, f.note, f.created_at, u.name AS by FROM follow_ups f LEFT JOIN panel_users u ON u.id = f.panel_user_id
     WHERE f.account_id = $1 ORDER BY f.seq DESC`,
    [accountId],
    db,
  );
  return list.map(followUpDto);
}

/* Records a follow-up; answers the whole history. */
export async function addFollowUp(req: Request, user: PanelUser, accountId: string, body: FollowUpBody) {
  return transaction(async (db) => {
    await studentAccount(accountId, db);
    const saved = (await one<{ seq: number }>(
      `INSERT INTO follow_ups (account_id, status, note, panel_user_id) VALUES ($1, $2, $3, $4) RETURNING seq`,
      [accountId, body.status, body.note || null, user.id],
      db,
    ))!;
    /* Not the note: it may hold anything about a person. */
    await audit.inTx(db, req, {
      action: 'edp.follow_up.create',
      resource: 'student_account',
      resourceId: accountId,
      actor: actor(user),
      details: { followUp: saved.seq, status: body.status, hasNote: !!body.note },
    });
    return followUps(accountId, db);
  });
}
