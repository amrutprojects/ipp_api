import crypto from 'node:crypto';
import supertest from 'supertest';
import { createApp } from '../../src/app';
import { one, pool } from '../../src/db/pool';
import { aadhaarBlindIndex, encryptAadhaar, withVerhoeffDigit } from '../../src/lib/aadhaar';
import { hashPassword } from '../../src/lib/passwords';
import { signSession } from '../../src/lib/tokens';
import type { PanelRole } from '../../src/http/auth';
import { storage } from '../../src/services/storage';

/*
 * Test data made straight in the database, so a test starts exactly where it needs to (a draft, a submitted form, a form in a
 * batch) without walking through the whole portal first. Everything is invented: no real person's data.
 */
export const app = createApp();
export const BASE = '/api/v1/edp';
/* request('get', '/manage/me', token) */
export const request = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token?: string) => {
  const r = supertest(app)[method](`${BASE}${path}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

export const PASSWORD = 'Student123';
let n = 0;
const next = () => ++n;
/* A valid, invented Aadhaar number. */
export const newAadhaar = () => withVerhoeffDigit(`7${String(10_000_000_00 + next()).padStart(10, '0')}`);

/* ------------------------------------------------------------------------------------------------------------- masters */

export const optionId = async (kind: string, code: string): Promise<string> =>
  (await one<{ id: string }>(`SELECT id FROM program_options WHERE kind = $1 AND code = $2 AND deleted_at IS NULL`, [
    kind,
    code,
  ]))!.id;
export const districtId = async (code = 'NAS'): Promise<string> =>
  (await one<{ id: string }>(`SELECT id FROM districts WHERE code = $1 AND deleted_at IS NULL`, [code]))!.id;

export async function makeCentre(
  over: { name?: string; code?: string; district?: string; active?: boolean } = {},
): Promise<string> {
  const i = next();
  const row = await one<{ id: string }>(
    `INSERT INTO centres (district_id, name, code, is_active) VALUES ($1, $2, $3, $4) RETURNING id`,
    [await districtId(over.district), over.name ?? `Test Center ${i}`, over.code ?? `TC${i}`, over.active ?? true],
  );
  return row!.id;
}

/* -------------------------------------------------------------------------------------------------------------- people */

export interface TestPanelUser {
  id: string;
  name: string;
  email: string;
  token: string;
}
export async function makePanelUser(
  role: PanelRole = 'ADMIN',
  over: { name?: string; email?: string } = {},
): Promise<TestPanelUser> {
  const i = next();
  const name = over.name ?? `Panel ${role} ${i}`;
  const email = over.email ?? `panel${i}@example.test`;
  const row = await one<{ id: string }>(
    `INSERT INTO panel_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, email, await hashPassword(PASSWORD), role],
  );
  return { id: row!.id, name, email, token: signSession('panel', row!.id, 0).token };
}

export interface TestStudent {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  mobile: string;
  token: string;
}
export async function makeAccount(over: Partial<TestStudent> & { verified?: boolean } = {}): Promise<TestStudent> {
  const i = next();
  const s = {
    first_name: over.first_name ?? `First${String.fromCharCode(65 + (i % 26))}`,
    last_name: over.last_name ?? `Last${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}`,
    email: over.email ?? `student${i}@example.test`,
    mobile: over.mobile ?? `9${String(100_000_000 + i)}`,
  };
  const row = await one<{ id: string }>(
    `INSERT INTO student_accounts (first_name, last_name, email, mobile, password_hash, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [s.first_name, s.last_name, s.email, s.mobile, await hashPassword(PASSWORD), over.verified === false ? null : new Date()],
  );
  return { id: row!.id, ...s, token: signSession('student', row!.id, 0).token };
}

/* --------------------------------------------------------------------------------------------------------------- forms */

/* Valid values of both steps (without the Aadhaar number and the e-mail). `centre` = the id of a center. */
export async function formValues(centre: string, over: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    first_name: 'Asha',
    last_name: 'Testkar',
    father_name: 'Ramesh Testkar',
    mother_name: 'Sunita Testkar',
    date_of_birth: '2003-04-15',
    current_address: '12 Test Road, Nashik',
    permanent_address: '12 Test Road, Nashik',
    pin_code: '422001',
    district_id: await districtId(),
    mobile_number: '9876543210',
    religion: 'हिंदू',
    caste_id: await optionId('CASTE', 'SAR01'),
    gender: 'Female',
    marital_status: 'Unmarried',
    disability_status: 'No',
    region_id: await optionId('REGION', 'NAS'),
    centre_id: centre,
    technology: 'T01',
    education_id: await optionId('EDUCATION', 'BCA'),
    educational_status: 'Completed',
    qualification_name: 'BCA',
    qualification_stream: 'Computer Applications',
    qualification_board: 'Test College',
    qualification_completed_on: '2024-06-01',
    grading_type: 'PERCENTAGE',
    score: '72.5',
    qualification_class: 'First Class',
    ...over,
  };
}

/* The smallest files the portal accepts: their first bytes say what they are. */
export const FILES = {
  pdf: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n'),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(32, 3)]),
};

export const activeDocuments = async (): Promise<string[]> =>
  (
    await pool.query<{ code: string }>(
      `SELECT code FROM program_documents WHERE is_active AND kind = 'DOCUMENT' ORDER BY display_order`,
    )
  ).rows.map((r) => r.code);

export async function addFile(applicationId: string, code: string, data: Buffer = FILES.pdf, name = `${code.toLowerCase()}.pdf`) {
  const key = storage.draftKey(applicationId, `${code}-${crypto.randomUUID()}.pdf`);
  await storage.write(key, data);
  await pool.query(
    `INSERT INTO application_files (application_id, document_code, storage_key, original_name, mime_type, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)`,
    [applicationId, code, key, name, data.length, crypto.createHash('sha256').update(data).digest('hex')],
  );
}

export type State =
  'DRAFT' | 'BASIC_DONE' | 'MAIN_DONE' | 'SUBMITTED' | 'VERIFIED_DOCS' | 'BATCH' | 'DIVISION' | 'RETURNED' | 'APPROVED';

export interface TestApplication {
  student: TestStudent;
  applicationId: string;
  aadhaar: string;
}

/*
 * A student whose form is at `state`: SUBMITTED = sent, documents not verified; VERIFIED_DOCS = all verified, not approved;
 * BATCH = approved, waiting for a batch; DIVISION / APPROVED = in `batch`; RETURNED = in `batch`, sent back to the Auditor.
 */
export async function makeApplication(
  state: State,
  o: { centre: string; by?: TestPanelUser; batch?: string; values?: Record<string, string>; account?: Partial<TestStudent> },
): Promise<TestApplication> {
  const student = await makeAccount(o.account);
  const aadhaar = newAadhaar();
  const submitted = !['DRAFT', 'BASIC_DONE', 'MAIN_DONE'].includes(state);
  const basic = submitted || state !== 'DRAFT';
  const main = submitted || state === 'MAIN_DONE';
  const data =
    state === 'DRAFT'
      ? {}
      : await formValues(o.centre, {
          first_name: student.first_name,
          last_name: student.last_name,
          mobile_number: student.mobile,
          ...o.values,
        });
  const seq = submitted ? (await one<{ n: number }>(`SELECT nextval('registration_seq') AS n`))!.n : null;
  const app = (await one<{ id: string }>(
    `INSERT INTO applications (account_id, status, current_step, data, aadhaar_enc, aadhaar_index, aadhaar_last4,
       basic_completed_at, main_completed_at, declared_at, submitted_at, registration_code, registration_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12) RETURNING id`,
    [
      student.id,
      submitted ? 'SUBMITTED' : 'DRAFT',
      main ? 3 : basic ? 2 : 1,
      JSON.stringify(data),
      basic ? encryptAadhaar(aadhaar) : null,
      submitted ? aadhaarBlindIndex(aadhaar) : null,
      submitted ? aadhaar.slice(-4) : null,
      basic ? new Date() : null,
      main ? new Date() : null,
      submitted ? new Date() : null,
      seq ? `IPP-${String(seq).padStart(6, '0')}` : null,
      seq ? String(seq).padStart(16, '0') : null,
    ],
  ))!;
  if (submitted) for (const code of await activeDocuments()) await addFile(app.id, code);
  if (submitted && state !== 'SUBMITTED') {
    const by = o.by ?? (await makePanelUser());
    await pool.query(
      `INSERT INTO document_checks (application_id, document_code, verified_by)
       SELECT application_id, document_code, $2 FROM application_files WHERE application_id = $1`,
      [app.id, by.id],
    );
    await pool.query(`UPDATE applications SET documents_verified_at = now(), documents_verified_by = $2 WHERE id = $1`, [
      app.id,
      by.id,
    ]);
    const move = (action: string, from: string, to: string, reason: string | null = null) =>
      pool.query(
        `INSERT INTO approval_events (application_id, action, from_stage, to_stage, reason, actor_kind, panel_user_id, actor_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        action === 'REJECT'
          ? [app.id, action, from, to, reason, 'OFFICER', null, 'Test Officer']
          : [app.id, action, from, to, reason, 'PANEL', by.id, by.name],
      );
    if (state !== 'VERIFIED_DOCS') {
      /* As the Auditor approves now: with a reason. */
      await move('APPROVE', 'AUDITOR', 'BATCH', 'Every document checked');
      const inBatch = state !== 'BATCH';
      if (inBatch) await move('APPROVE', 'BATCH', 'DIVISION');
      if (state === 'RETURNED') await move('REJECT', 'DIVISION', 'AUDITOR', 'Photo is not clear');
      await pool.query(
        `UPDATE applications SET approval_stage = $2, batch_id = $3, stage_updated_at = now(), approved_at = $4, approved_by = $5
         WHERE id = $1`,
        [
          app.id,
          state === 'RETURNED' ? null : state,
          inBatch ? (o.batch ?? null) : null,
          state === 'RETURNED' ? null : new Date(),
          state === 'RETURNED' ? null : by.id,
        ],
      );
    }
  }
  return { student, applicationId: app.id, aadhaar };
}

export async function makeBatch(o: {
  centre: string;
  by: TestPanelUser;
  district?: string;
  name?: string;
  size?: number;
}): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO batches (name, district_id, centre_id, size, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [o.name ?? `Batch ${next()}`, await districtId(o.district), o.centre, o.size ?? 1, o.by.id],
  );
  return row!.id;
}
