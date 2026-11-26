import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { rows, transaction } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { AppError } from '../../http/errors';
import { recordMove } from '../../program/approval';
import {
  allVerified,
  DOCUMENT_COUNTS,
  documentChecks,
  notVerifiedMessage,
  syncDocumentsVerified,
  type DocumentCounts,
} from '../../program/document-checks';
import { enqueueApplications } from '../../program/link/outbox';
import { kickLink } from '../../program/link/runtime';
import { audit } from '../../services/audit';
import { OPEN_RETURN, openReturn, WITH_CANDIDATE } from '../../program/returns';
import { actor, applicationOf, FINALLY_APPROVED, lockedApplication, NO_FILE, studentAccount } from './common';

/* The Auditor's approval of submitted forms, and the check of each of their documents. */

/*
 * Approves the submitted forms that are with the Auditor, once every uploaded document is verified: a form then waits for a
 * batch, or, sent back by the Divisional Officer and still in its batch, goes straight to the Divisional Officer again.
 * `waiting` = forms with a document still to verify (or none at all), not approved.
 */
async function approveForms(
  db: PoolClient,
  user: PanelUser,
  accountIds: string[],
): Promise<{ approved: string[]; waiting: DocumentCounts[] }> {
  /* Locked first, then counted: a document being replaced or checked meanwhile is counted as it ends up. */
  const locked = await rows<{ id: string }>(
    `SELECT p.id FROM applications p JOIN student_accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
     WHERE p.account_id = ANY($1::uuid[]) AND p.deleted_at IS NULL AND p.status = 'SUBMITTED' AND p.approval_stage IS NULL
       AND NOT ${OPEN_RETURN('p')}
     ORDER BY p.id FOR UPDATE OF p`,
    [accountIds],
    db,
  );
  const counted = await rows<DocumentCounts & { id: string }>(
    `SELECT p.id, dc.uploaded, dc.verified FROM applications p${DOCUMENT_COUNTS} WHERE p.id = ANY($1::uuid[])`,
    [locked.map((r) => r.id)],
    db,
  );
  const moved = await rows<{ id: string; stage: 'BATCH' | 'DIVISION' }>(
    `UPDATE applications SET approved_at = now(), approved_by = $1, stage_updated_at = now(),
       approval_stage = CASE WHEN batch_id IS NULL THEN 'BATCH' ELSE 'DIVISION' END
     WHERE id = ANY($2::uuid[]) RETURNING id, approval_stage AS stage`,
    [user.id, counted.filter(allVerified).map((r) => r.id)],
    db,
  );
  for (const p of moved) await recordMove(db, { applicationId: p.id, action: 'APPROVE', from: 'AUDITOR', to: p.stage, by: user });
  /* Sent back before, and now with the Divisional Officer again. */
  await enqueueApplications(
    db,
    'RESUBMIT',
    moved.filter((p) => p.stage === 'DIVISION').map((p) => p.id),
  );
  return { approved: moved.map((r) => r.id), waiting: counted.filter((r) => !allVerified(r)) };
}

/* One form; says why it cannot be approved (409). */
export async function approve(req: Request, user: PanelUser, accountId: string) {
  const result = await transaction(async (db) => {
    await studentAccount(accountId, db);
    const { approved, waiting } = await approveForms(db, user, [accountId]);
    if (waiting[0]) throw AppError.conflict(notVerifiedMessage(waiting[0]));
    if (!approved.length) {
      const p = await applicationOf(accountId, db);
      /* Sent back to the candidate (program/returns): with them until they resubmit it. */
      if (p && (await openReturn(db, p.id))) throw AppError.conflict(WITH_CANDIDATE, 'WITH_CANDIDATE');
      throw AppError.conflict(p?.approval_stage ? 'This form is already approved.' : 'Only a submitted form can be approved.');
    }
    await audit.inTx(db, req, {
      action: 'edp.application.approve',
      resource: 'student_account',
      resourceId: accountId,
      actor: actor(user),
      details: { applicationId: approved[0] },
    });
    return { approved: 1 };
  });
  kickLink();
  return result;
}

/*
 * The selected forms. One that cannot be approved (not submitted, a document still to verify, already approved, unknown) is
 * skipped.
 */
export async function approveSelected(req: Request, user: PanelUser, accountIds: string[]) {
  const result = await transaction(async (db) => {
    const { approved } = await approveForms(db, user, accountIds);
    if (approved.length)
      await audit.inTx(db, req, {
        action: 'edp.application.approve_selected',
        resource: 'application',
        resourceId: null,
        actor: actor(user),
        details: { count: approved.length, selected: accountIds.length, applicationIds: approved },
      });
    return { approved: approved.length, skipped: accountIds.length - approved.length };
  });
  kickLink();
  return result;
}

/*
 * Marks one uploaded document of a submitted form as verified, or takes the mark back; the form's own mark follows. Verifying
 * it again keeps who verified it first, and when.
 */
export async function verifyDocument(req: Request, user: PanelUser, accountId: string, code: string, verified: boolean) {
  const result = await transaction(async (db) => {
    await studentAccount(accountId, db);
    const p = await lockedApplication(accountId, db);
    if (p?.status !== 'SUBMITTED') throw AppError.conflict("Only a submitted form's documents can be verified.");
    if (p.approval_stage === 'APPROVED') throw AppError.conflict(FINALLY_APPROVED);
    const file = await rows(`SELECT 1 FROM application_files WHERE application_id = $1 AND document_code = $2`, [p.id, code], db);
    if (!file.length) throw AppError.notFound(NO_FILE);
    const { rowCount } = verified
      ? await db.query(
          `INSERT INTO document_checks (application_id, document_code, verified_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [p.id, code, user.id],
        )
      : await db.query(`DELETE FROM document_checks WHERE application_id = $1 AND document_code = $2`, [p.id, code]);
    const documents = await syncDocumentsVerified(db, p.id, user.id);
    if (rowCount) await enqueueApplications(db, 'UPDATE', [p.id]);
    if (rowCount)
      await audit.inTx(db, req, {
        action: verified ? 'edp.document.verify' : 'edp.document.unverify',
        resource: 'student_account',
        resourceId: accountId,
        actor: actor(user),
        details: { applicationId: p.id, document: code },
      });
    return { ...(await documentChecks(p.id, db))(code), documents };
  });
  kickLink();
  return result;
}
