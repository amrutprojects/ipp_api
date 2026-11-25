import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { mailer } from '../../src/services/mailer';
import { sms } from '../../src/services/sms';
import { storageRoot } from '../../src/services/storage';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { activeDocuments, FILES, formValues, makeCentre, newAadhaar, PASSWORD, request } from '../helpers/factory';

/* What was "sent" in the current test: no SMS and no e-mail leaves the tests. */
export const sent = {
  otps: [] as { mobile: string; otp: string; ttl: number }[],
  links: [] as { to: string; name: string; link: string; minutes: number }[],
};
export const lastOtp = () => sent.otps.at(-1)!.otp;
export const lastToken = () => new URL(sent.links.at(-1)!.link).searchParams.get('token')!;

/* A fresh database for the file, and nothing sent, before each test. */
export function setUp(): void {
  beforeAll(resetDatabase);
  beforeEach(() => {
    sent.otps.length = 0;
    sent.links.length = 0;
    vi.spyOn(sms, 'sendOtp').mockImplementation(async (mobile, otp, ttl) => {
      sent.otps.push({ mobile, otp, ttl });
    });
    vi.spyOn(mailer, 'sendPasswordReset').mockImplementation(async (to, name, link, minutes) => {
      sent.links.push({ to, name, link, minutes });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(closeDatabase);
}

let n = 0;
export const newEmail = () => `kavya${++n}@example.test`;

/* ----------------------------------------------------------------------------------------------------------- accounts */

export const post = (path: string, body: object, token?: string) => request('post', path, token).send(body);
export const signUp = (email: string, over: Record<string, unknown> = {}) =>
  post('/auth/register', {
    first_name: 'Kavya',
    last_name: 'Jadhav',
    email,
    mobile_number: '9765412345',
    password: PASSWORD,
    confirm_password: PASSWORD,
    ...over,
  });
export const verify = (email: string, otp = lastOtp(), password = PASSWORD) => post('/auth/verify-otp', { email, otp, password });
export const login = (email: string, password = PASSWORD) => post('/auth/login', { email, password });
export const wrongOtp = () => (lastOtp() === '000000' ? '111111' : '000000');

/* Signed up and verified; the session's token. */
export async function verifiedToken(email = newEmail()): Promise<string> {
  expect((await signUp(email)).status).toBe(201);
  const res = await verify(email);
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

export const accountRow = async (email: string) =>
  (await one<Record<string, unknown>>(`SELECT * FROM student_accounts WHERE email = $1`, [email]))!;
/* As if the account's code had been sent `age` seconds ago, and worked for `left` more seconds. */
export const ageOtp = (email: string, age: number, left: number) =>
  pool.query(
    `UPDATE student_accounts SET otp_sent_at = now() - make_interval(secs => $2), otp_expires_at = now() + make_interval(secs => $3)
     WHERE email = $1`,
    [email, age, left],
  );

export const auditActions = async (resourceId: string): Promise<string[]> =>
  (await rows<{ action: string }>(`SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY id`, [resourceId])).map(
    (a) => a.action,
  );

/* ---------------------------------------------------------------------------------------------------------------- form */

export const application = (token: string) => request('get', '/application', token);
export const step = (token: string, number: number, data: Record<string, unknown>, complete = true) =>
  request('put', `/application/steps/${number}`, token).send({ complete, data });
export const submit = (token: string) => post('/application/submit', { declaration_accepted: true }, token);

const STEP_2 = [
  'region_id',
  'centre_id',
  'technology',
  'education_id',
  'educational_status',
  'qualification_name',
  'qualification_stream',
  'qualification_board',
  'qualification_completed_on',
  'grading_type',
  'cgpa_scale',
  'score',
  'qualification_class',
];
/* The values of both steps, as the page sends them. */
export async function steps(over: Record<string, string> = {}) {
  const all = { ...(await formValues(await makeCentre())), cgpa_scale: '', ...over };
  const pick = (second: boolean) => Object.fromEntries(Object.entries(all).filter(([k]) => STEP_2.includes(k) === second));
  return {
    basic: { aadhaar_number: newAadhaar(), ...pick(false) } as Record<string, string>,
    main: pick(true) as Record<string, string>,
  };
}

export const upload = (token: string, files: [code: string, data: Buffer, name: string][]) =>
  files.reduce((r, [code, data, name]) => r.attach(code, data, name), request('post', '/application/documents', token));
export const uploadAll = async (token: string, without: string[] = []) =>
  upload(
    token,
    (await activeDocuments()).filter((c) => !without.includes(c)).map((c) => [c, FILES.pdf, `${c.toLowerCase()}.pdf`]),
  );

/* A student signed in, everything filled in and uploaded, not submitted yet. */
export async function ready(over: Record<string, string> = {}) {
  const email = newEmail();
  const token = await verifiedToken(email);
  const values = await steps(over);
  expect((await step(token, 1, values.basic)).status).toBe(200);
  expect((await step(token, 2, values.main)).status).toBe(200);
  expect((await uploadAll(token)).status).toBe(200);
  const { id } = (await one<{ id: string }>(
    `SELECT p.id FROM applications p JOIN student_accounts a ON a.id = p.account_id WHERE a.email = $1`,
    [email],
  ))!;
  return { email, token, id, ...values };
}

export const fileRows = (applicationId: string) =>
  rows<{
    document_code: string;
    storage_key: string;
    original_name: string;
    mime_type: string;
    size_bytes: number;
    sha256: string;
  }>(`SELECT * FROM application_files WHERE application_id = $1 ORDER BY document_code`, [applicationId]);
export const isStored = (key: string) => fs.existsSync(path.join(storageRoot(), key));
/* Every stored file under a folder of the storage. */
export function storedIn(folder: string): string[] {
  const root = path.join(storageRoot(), folder);
  if (!fs.existsSync(root)) return [];
  return (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

type Failed = { body: { error: { code: string; details?: { field: string; message: string }[] } } };
export const details = (res: Failed) => res.body.error.details ?? [];
export const fields = (res: Failed) => details(res).map((d) => d.field);
export const code = (res: Failed) => res.body.error.code;
