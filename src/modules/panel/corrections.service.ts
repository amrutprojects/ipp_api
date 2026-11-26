import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { Request } from 'express';
import { DatabaseError } from 'pg';
import { rows, transaction, type Db } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { AppError, type FieldError } from '../../http/errors';
import { aadhaarBlindIndex, encryptAadhaar, maskAadhaar } from '../../lib/aadhaar';
import { logger } from '../../lib/logger';
import { normaliseMobile } from '../../lib/text';
import type { Form } from '../../program/constants';
import { syncDocumentsVerified } from '../../program/document-checks';
import { checkForm, fieldText, referenceNames } from '../../program/form';
import { enqueueApplications } from '../../program/link/outbox';
import { kickLink } from '../../program/link/runtime';
import { loadProgram, type Program } from '../../program/masters';
import { aadhaarDigits } from '../../program/rules';
import { folderFor, relocateFiles } from '../../program/folders';
import { checkUploads, discardFiles, discardUnusedFiles, type CheckedUpload } from '../../program/uploads';
import { audit } from '../../services/audit';
import { storage } from '../../services/storage';
import {
  aadhaarOf,
  actor,
  applicationOf,
  canEdit,
  FINALLY_APPROVED,
  formOf,
  lockedApplication,
  lockedFields,
  studentAccount,
  type Application,
  type EditChange,
} from './common';

/*
 * The Auditor corrects a submitted form and its documents, at any stage until the final approval. Every change is recorded
 * (application_edits) and shown on the student's page.
 */

function assertCorrectable(p: Application | null): asserts p is Application {
  if (p?.status !== 'SUBMITTED') throw AppError.conflict('Only a submitted form can be changed here.');
  if (!canEdit(p)) throw AppError.conflict(FINALLY_APPROVED);
}

const recordEdit = (db: Db, applicationId: string, user: PanelUser, changes: EditChange[]) =>
  db.query(`INSERT INTO application_edits (application_id, changes, panel_user_id, actor_name) VALUES ($1, $2, $3, $4)`, [
    applicationId,
    JSON.stringify(changes),
    user.id,
    user.name,
  ]);

/* ---------------------------------------------------------------------------------------------------------------- form */

/* Fields whose own check depends on this one: changed with it, they are checked (and cleared) too. */
const DEPENDENTS: Record<string, readonly string[]> = {
  disability_status: ['disability_type', 'disability_certificate_number'],
  grading_type: ['cgpa_scale', 'score'],
  cgpa_scale: ['score'],
  district_id: ['technology'],
  mobile_number: ['alternate_mobile_number'],
};

/* Aadhaar: the mask, its last four digits or nothing at all is not a new number. */
const isNoAadhaar = (digits: string) => /^X*(\d{4})?$/i.test(digits);

/* The values that really change, and what is wrong with the keys sent. */
function changedValues(program: Program, p: Application, before: Form, data: Form) {
  const changed: Form = {};
  const errors: FieldError[] = [];
  for (const [key, raw] of Object.entries(data)) {
    const issue = (message: string) => errors.push({ field: `body.${key}`, message });
    const field = program.field(key);
    if (!field) {
      issue('Unknown field');
      continue;
    }
    const v = key === 'aadhaar_number' ? aadhaarDigits(raw) : raw.trim();
    /* A switched-off field is not part of the form. */
    if (!field.isActive || (key === 'aadhaar_number' && isNoAadhaar(v)) || v === (before[key] ?? '').trim()) continue;
    if (key === 'email') {
      if (v.toLowerCase() !== before.email) issue(`${field.labelEn} is the sign-in and cannot be changed`);
    } else if (lockedFields(p).includes(key)) issue(`${field.labelEn} cannot be changed: the student is in a batch`);
    else changed[key] = v;
  }
  return { changed, errors };
}

/* A form's values as people read them, the Aadhaar masked. */
async function textsOf(program: Program, form: Form, db: Db) {
  const names = await referenceNames(program, form, db);
  const masked = form.aadhaar_number ? maskAadhaar(form.aadhaar_number.slice(-4)) : null;
  return (key: string) => {
    const field = program.field(key);
    return field ? fieldText(program, field, form, names, masked) : '';
  };
}

/*
 * Changes a submitted form. Only the changed values are checked, with the ones that depend on them, as the student's form is,
 * by the masters as they are now; a value that stays as it is may be one no longer offered. The account follows a new name
 * and mobile number, so lists, search and calls match the form (one that is cleared leaves the account's). Nothing changed =
 * nothing recorded.
 */
export async function editForm(req: Request, user: PanelUser, accountId: string, data: Form): Promise<void> {
  try {
    await transaction(async (db) => {
      const account = await studentAccount(accountId, db);
      const p = await lockedApplication(accountId, db);
      assertCorrectable(p);
      const program = await loadProgram(db);
      const before: Form = { ...formOf(p, program), email: account.email, aadhaar_number: aadhaarOf(p) };
      const { changed, errors } = changedValues(program, p, before, data);
      const affected = new Set(Object.keys(changed).flatMap((k) => [k, ...(DEPENDENTS[k] ?? [])]));
      const checked = await checkForm(program, { ...before, ...changed }, { stored: before, db });
      errors.push(...checked.errors.filter((e) => affected.has((e.field ?? '').replace(/^body\./, ''))));
      if (errors.length) throw AppError.validation(errors);

      const after: Form = { ...before };
      for (const key of affected) if (checked.values[key] !== undefined) after[key] = checked.values[key];
      if (changed.aadhaar_number) after.aadhaar_number = changed.aadhaar_number;
      const keys = program.fields.map((f) => f.key).filter((k) => after[k] !== before[k]);
      if (!keys.length) return;

      const from = await textsOf(program, before, db);
      const to = await textsOf(program, after, db);
      const { aadhaar_number: aadhaar, ...values } = Object.fromEntries(keys.map((k) => [k, after[k]!]));
      await db.query(
        `UPDATE applications SET data = data || $2::jsonb, aadhaar_enc = coalesce($3, aadhaar_enc),
           aadhaar_index = coalesce($4, aadhaar_index), aadhaar_last4 = coalesce($5, aadhaar_last4) WHERE id = $1`,
        [
          p.id,
          JSON.stringify(values),
          aadhaar ? encryptAadhaar(aadhaar) : null,
          aadhaar ? aadhaarBlindIndex(aadhaar) : null,
          aadhaar ? aadhaar.slice(-4) : null,
        ],
      );
      if (values.first_name !== undefined || values.last_name !== undefined)
        await db.query(
          `UPDATE student_accounts SET first_name = coalesce(nullif($2, ''), first_name),
             last_name = coalesce(nullif($3, ''), last_name) WHERE id = $1`,
          [account.id, after.first_name ?? '', after.last_name ?? ''],
        );
      if (values.mobile_number)
        await db.query(`UPDATE student_accounts SET mobile = $2 WHERE id = $1`, [
          account.id,
          normaliseMobile(values.mobile_number),
        ]);
      await recordEdit(
        db,
        p.id,
        user,
        keys.map((key) => ({ key, label: program.label(key), from: from(key), to: to(key) })),
      );
      await enqueueApplications(db, 'UPDATE', [p.id]);
      /* The names of the fields only: their values are in the record of the edit. */
      await audit.inTx(db, req, {
        action: 'edp.application.edit',
        resource: 'student_account',
        resourceId: accountId,
        actor: actor(user),
        details: { applicationId: p.id, fields: keys, stage: p.approval_stage },
      });
    });
  } catch (err) {
    if (err instanceof DatabaseError && err.constraint === 'uq_applications_aadhaar')
      throw AppError.validation([
        { field: 'body.aadhaar_number', message: 'A registration with this Aadhaar number already exists' },
      ]);
    throw err;
  }
  kickLink();
  await followName(accountId);
}

/*
 * After a correction of the name or the mobile number: the student's documents move to the folder of the new name. Nothing
 * changes when the name is the same; a failure leaves the files where they are (still found by the database) and is logged.
 */
async function followName(accountId: string): Promise<void> {
  try {
    const account = await studentAccount(accountId);
    const p = await applicationOf(accountId);
    if (!p) return;
    const v = (k: string) => (typeof p.data[k] === 'string' ? (p.data[k] as string) : '');
    const folder = await transaction((db) =>
      folderFor(db, p.id, { first_name: v('first_name'), last_name: v('last_name'), mobile: v('mobile_number') }, account),
    );
    if (folder) await relocateFiles(p.id);
  } catch (err) {
    logger.error({ err }, 'documents could not follow a corrected name');
  }
}

/* ----------------------------------------------------------------------------------------------------------- documents */

interface StoredFile {
  document_code: string;
  storage_key: string;
  original_name: string;
}
const filesOf = (applicationId: string, db?: Db) =>
  rows<StoredFile>(
    `SELECT document_code, storage_key, original_name FROM application_files WHERE application_id = $1`,
    [applicationId],
    db,
  );

/*
 * Replaces or adds documents of a submitted form: the ones asked for now, and any other that has a file. A replaced document
 * has to be verified again. The new files are stored under names of their own before the database changes (a slow storage
 * holds no lock) and removed if it does not; the replaced ones are deleted once it has.
 */
export async function uploadDocuments(
  req: Request,
  user: PanelUser,
  accountId: string,
  files: Express.Multer.File[],
): Promise<void> {
  const account = await studentAccount(accountId);
  if (!files.length) throw AppError.validation([{ field: 'files', message: 'Choose a file to upload' }]);
  const [program, found] = await Promise.all([loadProgram(), applicationOf(accountId)]);
  assertCorrectable(found);
  const asked = program.documents();
  const others = (await filesOf(found.id))
    .flatMap((f) => program.document(f.document_code) ?? [])
    .filter((d) => !asked.includes(d));
  const uploads = await checkUploads(files, [...asked, ...others]);
  /* The student's folder by the name and number as they are now; earlier files are moved into it first. */
  const form = formOf(found, program);
  const folder = await transaction((db) =>
    folderFor(db, found.id, { first_name: form.first_name, last_name: form.last_name, mobile: form.mobile_number }, account),
  );
  await relocateFiles(found.id);

  const written: string[] = [];
  let replaced: string[];
  try {
    const stored: (CheckedUpload & { key: string; size: number; sha256: string })[] = [];
    for (const u of uploads) {
      const content = await fs.readFile(u.path);
      const key = storage.versionedKey(folder, `${u.code}.${u.type.ext}`);
      /* Before the write, so a file written in part is removed as well. */
      written.push(key);
      await storage.write(key, content);
      stored.push({ ...u, key, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
    }
    replaced = await transaction(async (db) => {
      const p = await lockedApplication(accountId, db);
      assertCorrectable(p);
      const before = new Map((await filesOf(p.id, db)).map((f) => [f.document_code, f]));
      for (const f of stored) {
        await db.query(
          `INSERT INTO application_files (application_id, document_code, storage_key, original_name, mime_type, size_bytes, sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (application_id, document_code) DO UPDATE SET storage_key = EXCLUDED.storage_key,
             original_name = EXCLUDED.original_name, mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
             sha256 = EXCLUDED.sha256, uploaded_at = now()`,
          [p.id, f.code, f.key, f.name, f.type.mime, f.size, f.sha256],
        );
        await db.query(`DELETE FROM document_checks WHERE application_id = $1 AND document_code = $2`, [p.id, f.code]);
      }
      await recordEdit(
        db,
        p.id,
        user,
        stored.map((f) => ({
          key: f.code,
          label: program.documentName(f.code),
          from: before.get(f.code)?.original_name ?? '',
          to: f.name,
        })),
      );
      await syncDocumentsVerified(db, p.id, user.id);
      await enqueueApplications(db, 'UPDATE', [p.id]);
      await audit.inTx(db, req, {
        action: 'edp.application.documents',
        resource: 'student_account',
        resourceId: accountId,
        actor: actor(user),
        details: {
          applicationId: p.id,
          documents: stored.map((f) => ({ document: f.code, size: f.size, sha256: f.sha256 })),
          stage: p.approval_stage,
        },
      });
      return stored.flatMap((f) => before.get(f.code)?.storage_key ?? []);
    });
  } catch (err) {
    await discardUnusedFiles(written);
    throw err;
  }
  kickLink();
  await discardFiles(replaced);
}
