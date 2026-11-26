import type { Request } from 'express';
import { rows, transaction } from '../../db/pool';
import type { StudentAccount } from '../../http/auth';
import { AppError } from '../../http/errors';
import type { Form } from '../../program/constants';
import { checkForm } from '../../program/form';
import { loadProgram } from '../../program/masters';
import { NOT_RETURNED, openReturn } from '../../program/returns';
import { audit } from '../../services/audit';
import { aadhaarOf, formOf, lockedApplication } from '../panel/common';
import { editForm, uploadDocuments, type Editor } from '../panel/corrections.service';

/*
 * The candidate corrects the form the Auditor sent back to them (program/returns) and saves it, which resubmits it to the
 * Auditor. The changes go through the same checks and records as the Auditor's own corrections (panel/corrections.service):
 * only what changed, by the masters as they are now, every change in the form's history marked as the candidate's.
 */

const asCandidate = (account: StudentAccount): Editor => ({
  kind: 'CANDIDATE',
  accountId: account.id,
  name: `${account.first_name} ${account.last_name}`.trim() || account.email,
});

/* Saves the changed values of the form (only while it is with the candidate). */
export const correctForm = (req: Request, account: StudentAccount, data: Form) => editForm(req, asCandidate(account), account.id, data);

/* Replaces or adds documents (only while the form is with the candidate); a replaced one is verified again by the Auditor. */
export const correctDocuments = (req: Request, account: StudentAccount, files: Express.Multer.File[]) =>
  uploadDocuments(req, asCandidate(account), account.id, files);

/*
 * Sends the corrected form back to the Auditor: the whole form is checked as it is now (a value kept from before that is no
 * longer offered still counts, as for the Auditor's corrections), with its required documents; then the return is closed and
 * the form is with the Auditor again, to verify and approve.
 */
export async function resubmit(req: Request, account: StudentAccount): Promise<void> {
  await transaction(async (db) => {
    const p = await lockedApplication(account.id, db);
    if (p?.status !== 'SUBMITTED') throw AppError.conflict(NOT_RETURNED, 'NOT_RETURNED');
    const open = await openReturn(db, p.id, true);
    if (!open) throw AppError.conflict(NOT_RETURNED, 'NOT_RETURNED');
    const program = await loadProgram(db);
    /* As the Auditor's corrections read it: the stored values, the sign-in e-mail and the Aadhaar number. */
    const stored: Form = { ...formOf(p, program), email: account.email, aadhaar_number: aadhaarOf(p) };
    const { errors } = await checkForm(program, stored, { stored, db });
    const files = await rows<{ document_code: string }>(`SELECT document_code FROM application_files WHERE application_id = $1`, [p.id], db);
    for (const d of program.documents())
      if (d.required && !files.some((f) => f.document_code === d.code))
        errors.push({ field: `files.${d.code}`, message: `${d.nameEn} is required` });
    if (errors.length) throw AppError.validation(errors);
    await db.query(`UPDATE application_returns SET resubmitted_at = now() WHERE seq = $1`, [open.seq]);
    await db.query(`UPDATE applications SET student_active_at = now() WHERE id = $1`, [p.id]);
    await audit.inTx(db, req, {
      action: 'edp.application.resubmitted',
      resource: 'application',
      resourceId: p.id,
      actor: { kind: 'STUDENT', id: account.id },
      details: { return: open.seq },
    });
  });
}
