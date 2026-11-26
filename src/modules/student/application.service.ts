import { one, pool, transaction, type Db } from '../../db/pool';
import type { StudentAccount } from '../../http/auth';
import { AppError } from '../../http/errors';
import { aadhaarBlindIndex, decryptAadhaar, encryptAadhaar, maskAadhaar } from '../../lib/aadhaar';
import { CUSTOM_KEY_PREFIX, type Form, type Step } from '../../program/constants';
import { documentChecks, documentList, storedFiles } from '../../program/document-checks';
import { checkForm, referenceNames, viewFields } from '../../program/form';
import { loadProgram, type Program } from '../../program/masters';
import { openReturn } from '../../program/returns';
import { aadhaarDigits } from '../../program/rules';
import { ensureApplication } from './accounts.service';
import type { SaveStepBody } from './application.schemas';

export const DUPLICATE_AADHAAR = 'A registration with this Aadhaar number already exists';

export interface ApplicationRow {
  id: string;
  status: 'DRAFT' | 'SUBMITTED';
  current_step: number;
  data: Form;
  aadhaar_enc: Buffer | null;
  aadhaar_last4: string | null;
  basic_completed_at: Date | null;
  main_completed_at: Date | null;
  submitted_at: Date | null;
  registration_code: string | null;
  registration_number: string | null;
  batch_id: string | null;
}
const SELECT = `SELECT id, status, current_step, data, aadhaar_enc, aadhaar_last4, basic_completed_at, main_completed_at,
  submitted_at, registration_code, registration_number, batch_id FROM applications WHERE account_id = $1`;

/* The student's application, made on first use; `lock` keeps its row until the transaction ends. */
async function load(accountId: string, db: Db = pool, lock = false): Promise<ApplicationRow> {
  const find = () => one<ApplicationRow>(lock ? `${SELECT} FOR UPDATE` : SELECT, [accountId], db);
  const found = await find();
  if (found) return found;
  await ensureApplication(db, accountId);
  return (await find())!;
}

/* The student's draft, locked: every change is made on it, one after the other. A submitted form is final. */
export async function lockDraft(db: Db, accountId: string): Promise<ApplicationRow> {
  const p = await load(accountId, db, true);
  if (p.status !== 'DRAFT')
    throw AppError.conflict('Your form has already been submitted. A submitted form cannot be changed.', 'ALREADY_SUBMITTED');
  return p;
}

/* The form as stored: every field of the program, own ones (also deleted ones it has a value of), and the Aadhaar in full. */
export function formOf(p: ApplicationRow, program: Program): Form {
  const own = Object.keys(p.data).filter((k) => k.startsWith(CUSTOM_KEY_PREFIX));
  const form: Form = Object.fromEntries([...program.fields.map((f) => f.key), ...own].map((k) => [k, p.data[k] ?? '']));
  form.aadhaar_number = p.aadhaar_enc ? decryptAadhaar(p.aadhaar_enc) : '';
  return form;
}

/* A new form starts with the account's own details; left blank, they are the account's. */
export const withAccount = (form: Form, account: StudentAccount): Form => ({
  ...form,
  first_name: form.first_name || account.first_name,
  last_name: form.last_name || account.last_name,
  mobile_number: form.mobile_number || account.mobile,
  /* The e-mail is always the account's: it cannot be changed. */
  email: account.email,
});

/* Whether another submitted form holds this Aadhaar number (two drafts may). */
export const aadhaarTaken = async (db: Db, index: string, applicationId: string): Promise<boolean> =>
  !!(await one(
    `SELECT 1 FROM applications WHERE aadhaar_index = $1 AND status = 'SUBMITTED' AND deleted_at IS NULL AND id <> $2`,
    [index, applicationId],
    db,
  ));

/* The application as the student sees it: the draft until it is submitted, afterwards (final) the submitted form. */
async function view(account: StudentAccount) {
  const p = await load(account.id);
  const program = await loadProgram();
  const form = formOf(p, program);
  /* The e-mail is always the account's: it cannot be changed. */
  if (program.field('email')?.isActive) form.email = account.email;
  const files = await storedFiles(program, p.id);
  const editable = p.status === 'DRAFT';
  const base = {
    status: p.status,
    current_step: p.current_step,
    steps: { basic_completed: !!p.basic_completed_at, main_completed: !!p.main_completed_at },
    editable,
    submitted_at: p.submitted_at,
  };
  if (editable) {
    const asked = new Set(program.documents().map((d) => d.code));
    return {
      ...base,
      form: withAccount(form, account),
      draft_files: files.filter((f) => asked.has(f.doc_type)),
      submitted_files: [],
      registration: null,
      view_fields: [],
      documents: [],
      returned: null,
      locked_fields: [],
    };
  }
  /* The Aadhaar is never shown in full again. */
  form.aadhaar_number = '';
  const aadhaarMasked = maskAadhaar(p.aadhaar_last4);
  const check = await documentChecks(p.id);
  const names = await referenceNames(program, form);
  /* Sent back by the Auditor (program/returns): the candidate corrects it and saves, which resubmits it. */
  const open = await openReturn(pool, p.id);
  return {
    ...base,
    form,
    draft_files: [],
    submitted_files: files.map((f) => ({ ...f, verified: check(f.doc_type).verified })),
    registration: {
      registration_id: p.registration_code!,
      registration_number: p.registration_number,
      status: p.status,
      aadhaar_masked: aadhaarMasked,
      display: names,
    },
    view_fields: viewFields(program, form, names, aadhaarMasked),
    /* Whether each document is verified, without who verified it. */
    documents: documentList(program, files, (code) => ({ ...check(code), by: null })),
    returned: open ? { reason: open.reason, at: open.at } : null,
    /* What the candidate cannot change while correcting: the sign-in, and the district of a student in a batch. */
    locked_fields: open ? ['email', ...(p.batch_id ? ['district_id'] : [])] : [],
  };
}

export const applicationService = {
  get: view,

  /*
   * Saves one step. complete = false keeps the values as typed, to be resumed later; complete = true keeps them too (nothing
   * typed is lost when the check fails), then checks the step and opens the next one. Values are merged into the stored ones;
   * a key that is not an active field of the step is ignored. The Aadhaar number is stored encrypted, never in the values,
   * once all its 12 digits are there.
   */
  async saveStep(account: StudentAccount, step: Step, { complete, data }: SaveStepBody) {
    const problem = await transaction(async (db): Promise<AppError | null> => {
      const p = await lockDraft(db, account.id);
      const program = await loadProgram(db);
      const fields = program.activeFields(step).map((f) => f.key);
      const given: Form = Object.fromEntries(Object.entries(data).filter(([k]) => fields.includes(k)));
      /* The e-mail is never taken from the request. */
      delete given.email;
      if (fields.includes('email')) given.email = account.email;
      const { aadhaar_number: aadhaar, ...values } = given;
      const digits = aadhaar === undefined ? undefined : aadhaarDigits(aadhaar);
      const replacesAadhaar = digits !== undefined && /^(\d{12})?$/.test(digits);
      await db.query(
        `UPDATE applications SET data = data || $2::jsonb, student_active_at = now(),
           aadhaar_enc = CASE WHEN $3 THEN $4::bytea ELSE aadhaar_enc END
         WHERE id = $1`,
        [p.id, JSON.stringify(values), replacesAadhaar, replacesAadhaar && digits ? encryptAadhaar(digits) : null],
      );
      if (!complete) return null;

      if (step === 2 && !p.basic_completed_at) return AppError.conflict('Please complete Step 1 – Basic Details first.');
      /* A field that was not sent is blank; the other step is as stored, for the rules across fields. */
      const blank = Object.fromEntries(fields.map((k) => [k, '']));
      const { values: checked, errors } = await checkForm(program, { ...formOf(p, program), ...blank, ...given }, { step, db });
      if (checked.aadhaar_number && (await aadhaarTaken(db, aadhaarBlindIndex(aadhaarDigits(checked.aadhaar_number)), p.id)))
        errors.push({ field: 'body.aadhaar_number', message: DUPLICATE_AADHAAR });
      if (errors.length) return AppError.validation(errors);

      const { aadhaar_number: _encrypted, ...clean } = checked;
      const completed = step === 1 ? 'basic_completed_at' : 'main_completed_at';
      await db.query(
        `UPDATE applications SET data = data || $2::jsonb, ${completed} = coalesce(${completed}, now()),
           current_step = greatest(current_step, $3)
         WHERE id = $1`,
        [p.id, JSON.stringify(clean), step + 1],
      );
      return null;
    });
    /* After the commit: the values stay saved. */
    if (problem) throw problem;
    return view(account);
  },
};
