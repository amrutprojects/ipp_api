import path from 'node:path';
import type { Request } from 'express';
import { DatabaseError } from 'pg';
import { env } from '../../config/env';
import { one, rows, transaction, type Db } from '../../db/pool';
import type { StudentAccount } from '../../http/auth';
import { AppError } from '../../http/errors';
import { aadhaarBlindIndex } from '../../lib/aadhaar';
import { checkForm } from '../../program/form';
import { loadProgram } from '../../program/masters';
import { aadhaarDigits } from '../../program/rules';
import { candidateFolder, discardFiles, discardUnusedFiles } from '../../program/uploads';
import { audit } from '../../services/audit';
import { storage } from '../../services/storage';
import { aadhaarTaken, DUPLICATE_AADHAAR, formOf, lockDraft, withAccount } from './application.service';

/* Until the transaction ends: one holder of `key` at a time. */
const hold = (db: Db, key: string) => db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);

const NUMBER_ATTEMPTS = 200;
/*
 * The registration number: MMDDHHmmssSSSfff (month … second in APP_TIMEZONE, milliseconds, microseconds) from the database's
 * clock, which really has microseconds. One submission at a time takes one, until it commits; a number already given (the
 * same instant of another year) → the clock is read again.
 */
async function newRegistrationNumber(db: Db): Promise<string> {
  await hold(db, 'registration-number');
  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt++) {
    const { number, taken } = (await one<{ number: string; taken: boolean }>(
      `SELECT n.number, EXISTS (SELECT 1 FROM applications WHERE registration_number = n.number) AS taken
       FROM (SELECT to_char(t AT TIME ZONE $1, 'MMDDHH24MISSMS') || substr(to_char(t AT TIME ZONE $1, 'US'), 4, 3) AS number
             FROM (SELECT clock_timestamp() AS t) c) n`,
      [env.APP_TIMEZONE],
      db,
    ))!;
    if (!taken) return number;
  }
  throw AppError.conflict('Could not allocate a registration number right now; please try again');
}

/*
 * The final submission (once): the whole form is checked again as the masters are now, with the documents; then, in one
 * transaction, it gets its registration ID and number and its documents go into the candidate's own folder. They are copied
 * first and the drafts' files deleted only after the commit, so at every moment the database points to files that exist. Two
 * submissions of one form wait for each other (the row is locked), two with the same Aadhaar number too.
 */
export async function submit(req: Request, account: StudentAccount) {
  const copies: string[] = [];
  let done: { code: string; number: string; drafts: string[] };
  try {
    done = await transaction(async (db) => {
      const p = await lockDraft(db, account.id);
      const program = await loadProgram(db);
      const { values, errors } = await checkForm(program, withAccount(formOf(p, program), account), { db });
      const files = await rows<{ id: string; document_code: string; storage_key: string }>(
        `SELECT id, document_code, storage_key FROM application_files WHERE application_id = $1`,
        [p.id],
        db,
      );
      for (const d of program.documents())
        if (d.required && !files.some((f) => f.document_code === d.code))
          errors.push({ field: `files.${d.code}`, message: `${d.nameEn} is required` });
      if (errors.length) throw AppError.validation(errors);

      /* None when it is not asked for, or optional and left blank: one typed before it was switched off is not kept. */
      const { aadhaar_number: aadhaar, ...clean } = values;
      const digits = aadhaar ? aadhaarDigits(aadhaar) : null;
      const index = digits && aadhaarBlindIndex(digits);
      if (index) {
        await hold(db, `aadhaar:${index}`);
        if (await aadhaarTaken(db, index, p.id)) throw AppError.conflict(DUPLICATE_AADHAAR);
      }

      const { code } = (await one<{ code: string }>(`SELECT 'IPP-' || padded(nextval('registration_seq'), 6) AS code`, [], db))!;
      const folder = candidateFolder(code, values.first_name || account.first_name, values.last_name || account.last_name);
      for (const f of files) {
        const key = storage.candidateKey(folder, `${f.document_code}${path.extname(f.storage_key)}`);
        copies.push(key);
        await storage.copy(f.storage_key, key);
        await db.query(`UPDATE application_files SET storage_key = $2 WHERE id = $1`, [f.id, key]);
      }
      const number = await newRegistrationNumber(db);
      await db.query(
        `UPDATE applications SET status = 'SUBMITTED', submitted_at = now(), declared_at = now(), student_active_at = now(),
           current_step = 3, basic_completed_at = coalesce(basic_completed_at, now()),
           main_completed_at = coalesce(main_completed_at, now()), registration_code = $2, registration_number = $3,
           aadhaar_enc = CASE WHEN $4::text IS NULL THEN NULL ELSE aadhaar_enc END, aadhaar_index = $4, aadhaar_last4 = $5,
           data = data || $6::jsonb
         WHERE id = $1`,
        [p.id, code, number, index, digits && digits.slice(-4), JSON.stringify(clean)],
      );
      await audit.inTx(db, req, {
        action: 'edp.application.submitted',
        resource: 'application',
        resourceId: p.id,
        actor: { kind: 'STUDENT', id: account.id },
        details: { registration_id: code, files: files.length },
      });
      return { code, number, drafts: files.map((f) => f.storage_key) };
    });
  } catch (err) {
    await discardUnusedFiles(copies);
    if (err instanceof DatabaseError && err.constraint === 'uq_applications_aadhaar') throw AppError.conflict(DUPLICATE_AADHAAR);
    throw err;
  }
  await discardFiles(done.drafts);
  return { registration_id: done.code, registration_number: done.number, status: 'SUBMITTED' as const };
}
