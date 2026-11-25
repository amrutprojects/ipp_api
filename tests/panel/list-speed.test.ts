import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { makeApplication, makeBatch, makeCentre, makePanelUser, type TestPanelUser } from '../helpers/factory';
import { get } from './helpers';

/* The student list with many students: one query for a page whatever its size, and an answer at once. */
const STUDENTS = 2000;
let admin: TestPanelUser;

beforeAll(async () => {
  await resetDatabase();
  admin = await makePanelUser();
  const centre = await makeCentre();
  const batch = await makeBatch({ centre, by: admin, size: 100 });
  const { applicationId } = await makeApplication('RETURNED', { centre, by: admin, batch });
  await pool.query(
    `INSERT INTO student_accounts (first_name, last_name, email, mobile, password_hash, verified_at, created_at)
     SELECT 'First' || i, 'Last' || i, 'many' || i || '@example.test', '9' || lpad(i::text, 9, '0'), 'x', now(), now() - i * interval '1 minute'
     FROM generate_series(1, $1) i`,
    [STUDENTS],
  );
  /* Copies of the one form: a third drafts, the rest with the Auditor, waiting, at the Divisional Officer or at COEP. */
  await pool.query(
    `INSERT INTO applications (account_id, status, current_step, data, aadhaar_enc, aadhaar_index, aadhaar_last4,
       basic_completed_at, main_completed_at, declared_at, submitted_at, registration_code, registration_number,
       approval_stage, batch_id)
     SELECT a.id, 'SUBMITTED', 3, s.data, s.aadhaar_enc, md5(a.id::text) || md5('x' || a.id), '1234', now(), now(), now(), now(),
       'IPP-' || padded(nextval('registration_seq'), 6), lpad((n + 1000)::text, 16, '0'),
       (ARRAY[NULL, 'BATCH', 'DIVISION', 'COEP'])[1 + n % 4], CASE WHEN n % 4 >= 2 THEN $1::uuid END
     FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS n FROM student_accounts WHERE email LIKE 'many%') a,
          (SELECT data, aadhaar_enc FROM applications WHERE id = $2) s
     WHERE n % 3 <> 0`,
    [batch, applicationId],
  );
  await pool.query(
    `INSERT INTO application_files (application_id, document_code, storage_key, original_name, mime_type, size_bytes, sha256)
     SELECT p.id, d.code, p.id || '/' || d.code, 'x.pdf', 'application/pdf', 10, repeat('0', 64)
     FROM applications p CROSS JOIN program_documents d WHERE d.is_active AND p.id <> $1`,
    [applicationId],
  );
  await pool.query(
    `INSERT INTO approval_events (application_id, action, from_stage, to_stage, actor_kind)
     SELECT id, 'APPROVE', 'AUDITOR', 'BATCH', 'SYSTEM' FROM applications`,
  );
  await pool.query(
    `INSERT INTO follow_ups (account_id, status) SELECT id, s FROM student_accounts, unnest(ARRAY['PENDING', 'CALLED']) s`,
  );
  await pool.query('ANALYZE');
});
afterAll(closeDatabase);

const timed = async (path: string) => {
  const start = performance.now();
  const res = await get(path, admin.token);
  return { res, ms: performance.now() - start };
};

describe('the student list with 2,000 students', () => {
  it.each([
    ['first page', '/manage/applicants?limit=25', STUDENTS + 1],
    ['last page', `/manage/applicants?limit=25&page=${STUDENTS / 25}`, STUDENTS + 1],
    ['largest page', '/manage/applicants?limit=100', STUDENTS + 1],
    ['one stage', '/manage/applicants?limit=25&application_stage=BATCH', 334],
    ['sent back', '/manage/applicants?limit=25&application_stage=RETURNED', 0],
    ['follow-up', '/manage/applicants?limit=25&follow_up=CALLED', STUDENTS + 1],
    ['no follow-up', '/manage/applicants?limit=25&follow_up=NONE', 0],
    ['search', '/manage/applicants?limit=25&search=last199', 11],
  ])('answers at once: %s', async (_what, path, total) => {
    const { res, ms } = await timed(path);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(total);
    expect(ms).toBeLessThan(1500);
  });

  it('counts at once', async () => {
    const { res, ms } = await timed('/manage/summary');
    expect(res.body.data).toMatchObject({
      total: STUDENTS + 1,
      counts: { VERIFIED: 666, SUBMITTED: 1335 },
      follow_ups: { CALLED: STUDENTS + 1, NONE: 0 },
      approvals: { BATCH: 334 },
    });
    expect(ms).toBeLessThan(1500);
  });

  it('takes as many queries for 100 students as for one', async () => {
    const queries = async (limit: number) => {
      const query = vi.spyOn(pool, 'query');
      const res = await get(`/manage/applicants?limit=${limit}`, admin.token);
      expect(res.body.data).toHaveLength(limit);
      const n = query.mock.calls.length;
      query.mockRestore();
      return n;
    };
    /* Who is asking, the page, and the count. */
    expect(await queries(1)).toBe(3);
    expect(await queries(100)).toBe(3);
  });
});
