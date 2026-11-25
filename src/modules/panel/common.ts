import { z } from 'zod';
import { one, pool, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import type { PanelUser } from '../../http/auth';
import { decryptAadhaar, maskAadhaar } from '../../lib/aadhaar';
import { blankAsMissing, listQuery } from '../../lib/paging';
import { hasControlChars, uuid } from '../../lib/text';
import { CUSTOM_KEY_PREFIX, type ApprovalStage, type Form } from '../../program/constants';
import type { Program } from '../../program/masters';
import { candidateFolder } from '../../program/uploads';
import type { Actor } from '../../services/audit';

/* What the parts of the panel share: a student's account and application, the form they hold, and the request's parameters. */

export const STUDENT_NOT_FOUND = 'Student not found';
export const NO_FILE = 'No file has been uploaded for this document';
export const FINALLY_APPROVED = 'This form is finally approved and can no longer be changed.';

export const actor = (user: PanelUser): Actor => ({ kind: 'PANEL', id: user.id });
export const people = (n: number) => `${n} student${n === 1 ? '' : 's'}`;

/* --------------------------------------------------------------------------------------------------------- parameters */

/* A student is addressed by the account's id. */
export const studentParams = z.object({ id: uuid() });
/* A document's code, in any case; a malformed one is a document that has no file. */
export const documentParams = studentParams.extend({
  docType: z.string().transform((v) => (/^[A-Za-z0-9_]{1,40}$/.test(v) ? v.toUpperCase() : '')),
});

/* Ids of students, each once. */
export const studentIds = (o: { max: number; twice: string; list: string }) =>
  z
    .array(
      uuid('Student').transform((v) => v.toLowerCase()),
      { required_error: 'Select at least one student', invalid_type_error: o.list },
    )
    .min(1, 'Select at least one student')
    .max(o.max, `At most ${o.max} students at a time`)
    .refine((ids) => new Set(ids).size === ids.length, o.twice);

/* A blank value clears, as null does. */
export const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/* A query value that is blank is the same as one not given. */
export const given = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankAsMissing, schema);
/* Text that is searched for: the database refuses some characters outright. */
export const searchText = (label: string) =>
  given(
    z
      .string()
      .trim()
      .max(100, `${label} must be at most 100 characters`)
      .refine((v) => !hasControlChars(v), `${label} contains characters that cannot be searched`)
      .optional(),
  );
/* The query of a list, newest first. */
export const panelListQuery = <S extends readonly [string, ...string[]]>(sortable: S) => {
  const { page, limit, sortBy, sortOrder } = listQuery(sortable).shape;
  return z.object({
    page: given(page.pipe(z.number().max(1_000_000))),
    limit: given(limit),
    search: searchText('Search'),
    sortBy: given(sortBy),
    sortOrder: given(sortOrder),
  });
};

/* ------------------------------------------------------------------------------------------------ account, application */

export interface Account {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  mobile: string;
  verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

export async function studentAccount(id: string, db: Db = pool): Promise<Account> {
  const account = await one<Account>(
    `SELECT id, first_name, last_name, full_name, email, mobile, verified_at, last_login_at, created_at
     FROM student_accounts WHERE id = $1 AND deleted_at IS NULL`,
    [id],
    db,
  );
  if (!account) throw AppError.notFound(STUDENT_NOT_FOUND);
  return account;
}

export interface Application {
  id: string;
  status: 'DRAFT' | 'SUBMITTED';
  data: Record<string, unknown>;
  aadhaar_enc: Buffer | null;
  aadhaar_last4: string | null;
  basic_completed_at: Date | null;
  main_completed_at: Date | null;
  submitted_at: Date | null;
  registration_code: string | null;
  registration_number: string | null;
  approval_stage: ApprovalStage | null;
  batch_id: string | null;
}

const APPLICATION = `SELECT id, status, data, aadhaar_enc, aadhaar_last4, basic_completed_at, main_completed_at, submitted_at,
    registration_code, registration_number, approval_stage, batch_id
  FROM applications WHERE account_id = $1 AND deleted_at IS NULL`;

/* An account's application; null = the student has not started the form. */
export const applicationOf = (accountId: string, db: Db = pool) => one<Application>(APPLICATION, [accountId], db);
/* The same, locked: nobody approves or changes it until the transaction is done. */
export const lockedApplication = (accountId: string, db: Db) => one<Application>(`${APPLICATION} FOR UPDATE`, [accountId], db);

/* ---------------------------------------------------------------------------------------------------------------- form */

/*
 * The form as the application holds it: every field of the program ('' when it has no value; always of the Aadhaar number),
 * and the values of own fields deleted since.
 */
export function formOf(p: Application | null, program: Program): Form {
  const data = p?.data ?? {};
  const keys = [...program.fields.map((f) => f.key), ...Object.keys(data).filter((k) => k.startsWith(CUSTOM_KEY_PREFIX))];
  return Object.fromEntries(
    keys.map((k) => {
      const v = data[k];
      return [k, typeof v === 'string' ? v : ''];
    }),
  );
}

/* The Aadhaar number in full: to check a change of it, never to be answered. */
export const aadhaarOf = (p: Application | null): string => (p?.aadhaar_enc ? decryptAadhaar(p.aadhaar_enc) : '');
/* As it is shown: of a submitted form by its stored last digits, of a draft by the number typed so far. */
export const aadhaarMasked = (p: Application | null): string | null => maskAadhaar(p?.aadhaar_last4 ?? aadhaarOf(p).slice(-4));

/* The name of a candidate's documents: after the form, or the account until the form has a name; DRAFT_… before submission. */
export const folderOf = (p: Application | null, form: Form, account: Pick<Account, 'first_name' | 'last_name'>) =>
  candidateFolder(p?.registration_code ?? 'DRAFT', form.first_name || account.first_name, form.last_name || account.last_name);

/* ---------------------------------------------------------------------------------------------------------- corrections */

/* The Auditor may correct a submitted form until its final approval … */
export const canEdit = (p: Application | null) => p?.status === 'SUBMITTED' && p.approval_stage !== 'APPROVED';
/* … except the sign-in, and the district of a student in a batch (a batch is of one district). */
export const lockedFields = (p: Application | null) => ['email', ...(p?.batch_id ? ['district_id'] : [])];

/* A change of a form, as people read it (names of choices, the Aadhaar masked); a document's is of its file's name. */
export interface EditChange {
  key: string;
  label: string;
  from: string;
  to: string;
}
