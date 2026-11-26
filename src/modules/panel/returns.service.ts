import type { Request } from 'express';
import { pool, one, transaction } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { AppError } from '../../http/errors';
import { logger } from '../../lib/logger';
import { openReturn, returnsOf, WITH_CANDIDATE } from '../../program/returns';
import { rejectionSettings } from '../../program/settings';
import { audit } from '../../services/audit';
import { mailer, type Delivery } from '../../services/mailer';
import { actor, applicationOf, FINALLY_APPROVED, lockedApplication, studentAccount } from './common';

/*
 * The Auditor sends a submitted form back to the candidate, with the reason (setting "Enable Rejection Email Notification and
 * Resubmission", key "rejection"). Only a form with the Auditor (submitted, not approved yet, not already with the
 * candidate). The candidate gets an e-mail with the reason after the commit; whether it went out is kept with the return.
 */

export const REJECTION_OFF =
  'Sending a form back to the candidate is switched off. An ADMIN can switch on "Enable Rejection Email Notification and Resubmission" in Settings.';

export async function returnToCandidate(
  req: Request,
  user: PanelUser,
  accountId: string,
  reason: string,
): Promise<{ email: Delivery }> {
  const sent = await transaction(async (db) => {
    if (!(await rejectionSettings(db)).enabled) throw AppError.conflict(REJECTION_OFF, 'REJECTION_OFF');
    const account = await studentAccount(accountId, db);
    const p = await lockedApplication(accountId, db);
    if (p?.status !== 'SUBMITTED') throw AppError.conflict('Only a submitted form can be sent back to the candidate.');
    if (p.approval_stage === 'APPROVED') throw AppError.conflict(FINALLY_APPROVED);
    if (p.approval_stage)
      throw AppError.conflict('Only a form that is with the Auditor can be sent back to the candidate: this one is already approved.');
    if (await openReturn(db, p.id)) throw AppError.conflict(WITH_CANDIDATE, 'WITH_CANDIDATE');
    const row = (await one<{ seq: string }>(
      `INSERT INTO application_returns (application_id, reason, panel_user_id, actor_name) VALUES ($1, $2, $3, $4) RETURNING seq`,
      [p.id, reason, user.id, user.name],
      db,
    ))!;
    /* The reason is in the return itself; the audit says who and which form. */
    await audit.inTx(db, req, {
      action: 'edp.application.return',
      resource: 'student_account',
      resourceId: accountId,
      actor: actor(user),
      details: { applicationId: p.id, return: row.seq },
    });
    return { seq: row.seq, to: account.email, name: account.first_name || account.full_name };
  });
  const email = await mailer.sendFormReturned(sent.to, sent.name, reason);
  try {
    await pool.query(`UPDATE application_returns SET email_status = $2, email_at = now() WHERE seq = $1`, [sent.seq, email]);
  } catch (err) {
    logger.error({ err }, 'the outcome of a form returned e-mail could not be saved');
  }
  return { email };
}

/* The returns of a student's form (latest first), the open one, and whether the Auditor can send it back now. */
export async function returnsOfStudent(accountId: string) {
  await studentAccount(accountId);
  const [p, setting] = await Promise.all([applicationOf(accountId), rejectionSettings()]);
  const list = p ? await returnsOf(p.id) : [];
  const open = list.find((r) => !r.resubmitted_at) ?? null;
  return {
    enabled: setting.enabled,
    open,
    can_return: setting.enabled && p?.status === 'SUBMITTED' && !p.approval_stage && !open,
    returns: list,
  };
}
