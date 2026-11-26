import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { one, pool, rows } from '../src/db/pool';
import { sms } from '../src/services/sms';
import { closeDatabase, resetDatabase } from './helpers/db';
import { FILES, formValues, makePanelUser, newAadhaar, optionId, PASSWORD, request, type TestPanelUser } from './helpers/factory';

/*
 * The whole program through the API, as the portal drives it: the Auditor prepares the masters; two students sign up, fill
 * the form and submit it; the Auditor verifies, corrects, approves and puts them into a batch; one is sent back (by an
 * officer, elsewhere) and follows again. Each step uses what the step before left.
 */
let admin: TestPanelUser;
let viewer: TestPanelUser;
let centre: string;
const codes = new Map<string, string>();
const students: { email: string; mobile: string; token: string; id: string; aadhaar: string }[] = [];

beforeAll(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Auditor One' });
  viewer = await makePanelUser('VIEWER');
  vi.spyOn(sms, 'sendOtp').mockImplementation(async (mobile: string, otp: string) => {
    codes.set(mobile, otp);
  });
});
afterAll(closeDatabase);

const ok = (res: { status: number; body: { message?: string; error?: unknown } }, status = 200) =>
  expect(res.status, JSON.stringify(res.body.error ?? res.body.message)).toBe(status);

async function signUp(n: number) {
  const email = `workflow${n}@example.test`;
  const mobile = `987650000${n}`;
  const registered = await request('post', '/auth/register').send({
    first_name: 'Asha',
    last_name: `Number${'ABC'[n]}`,
    email,
    mobile_number: `+91 ${mobile}`,
    password: PASSWORD,
    confirm_password: PASSWORD,
  });
  ok(registered, 201);
  /* Not usable before the code is verified. */
  expect((await request('post', '/auth/login').send({ email, password: PASSWORD })).body.error.code).toBe('EMAIL_NOT_VERIFIED');
  const verified = await request('post', '/auth/verify-otp').send({ email, otp: codes.get(mobile), password: PASSWORD });
  ok(verified);
  const { token, account } = verified.body.data;
  students.push({ email, mobile, token, id: account.id, aadhaar: newAadhaar() });
}

async function documentsOf(token: string, skip: string[] = []) {
  const { document_types } = (await request('get', '/options')).body.data;
  const upload = request('post', '/application/documents', token);
  for (const d of document_types as { code: string; kind: string }[])
    if (!skip.includes(d.code))
      if (d.kind === 'VIDEO') upload.attach(d.code, FILES.mp4, 'clip.mp4');
      else upload.attach(d.code, FILES.pdf, `${d.code}.pdf`);
  return upload;
}

describe('the program from start to end', () => {
  it('the Auditor prepares the masters', async () => {
    const districts = (await request('get', '/manage/districts', admin.token)).body.data as { id: string; name: string }[];
    const nashik = districts.find((d) => d.name === 'Nashik')!.id;
    const taluka = await request('post', '/manage/talukas', admin.token).send({ district_id: nashik, name: 'Sinnar' });
    ok(taluka, 201);
    const made = await request('post', '/manage/centres', admin.token).send({
      name: 'Nashik Center',
      code: 'NSK1',
      districtId: nashik,
      talukaId: taluka.body.data.id,
    });
    ok(made, 201);
    centre = made.body.data.id;
    ok(await request('put', '/manage/settings/batch', admin.token).send({ size: 2 }));
    ok(await request('put', `/manage/technologies/districts/${nashik}`, admin.token).send({ codes: ['T01', 'T03'] }));
    const field = await request('post', '/manage/fields', admin.token).send({
      step: 1,
      label_en: 'Preferred shift',
      type: 'DROPDOWN',
      required: true,
      options: [{ name_en: 'Morning' }, { name_en: 'Evening' }],
    });
    ok(field, 201);
    expect(field.body.data.key).toBe('x_preferred_shift');
    /* A viewer sees it all and changes nothing. */
    ok(await request('get', '/manage/fields', viewer.token));
    ok(await request('post', '/manage/talukas', viewer.token).send({ district_id: nashik, name: 'Niphad' }), 403);
  });

  it('students sign up with a code by SMS', async () => {
    await signUp(0);
    await signUp(1);
    await signUp(2);
    expect((await request('get', '/me', students[0]!.token)).body.data.email).toBe(students[0]!.email);
  });

  it('they fill the form step by step, by the masters of the moment', async () => {
    const options = (await request('get', '/options')).body.data;
    expect(options.fields.some((f: { key: string }) => f.key === 'x_preferred_shift')).toBe(true);
    for (const [i, s] of students.slice(0, 2).entries()) {
      const values = await formValues(centre, { mobile_number: s.mobile, last_name: `Number${'ABC'[i]}` });
      const step2Keys = options.fields
        .filter((f: { step: number }) => f.step === 2)
        .map((f: { key: string }) => f.key) as string[];
      const part = (two: boolean) =>
        Object.fromEntries(Object.entries(values).filter(([k]) => step2Keys.includes(k) === two)) as Record<string, string>;
      /* Typed and left: nothing is checked yet, nothing is lost. */
      ok(await request('put', '/application/steps/1', s.token).send({ complete: false, data: { first_name: 'As' } }));
      const missing = await request('put', '/application/steps/1', s.token).send({
        complete: true,
        data: { ...part(false), aadhaar_number: s.aadhaar },
      });
      expect(missing.body.error.details).toEqual([{ field: 'body.x_preferred_shift', message: 'Preferred shift is required' }]);
      ok(
        await request('put', '/application/steps/1', s.token).send({
          complete: true,
          data: { ...part(false), aadhaar_number: s.aadhaar, x_preferred_shift: 'Morning' },
        }),
      );
      const wrong = await request('put', '/application/steps/2', s.token).send({
        complete: true,
        data: { ...part(true), technology: 'T02' },
      });
      expect(wrong.body.error.details).toEqual([
        { field: 'body.technology', message: 'Technology is not offered in the selected district' },
      ]);
      ok(await request('put', '/application/steps/2', s.token).send({ complete: true, data: part(true) }));
    }
  });

  it('they upload the documents and submit, once', async () => {
    const [a, b] = students as [(typeof students)[0], (typeof students)[0]];
    ok(await documentsOf(a.token, ['PHOTO']));
    const missing = await request('post', '/application/submit', a.token).send({ declaration_accepted: true });
    expect(missing.body.error.details).toEqual([{ field: 'files.PHOTO', message: 'Photo is required' }]);
    ok(await request('post', '/application/documents', a.token).attach('PHOTO', FILES.png, 'छायाचित्र.png'));
    ok(await documentsOf(b.token));
    /* Two clicks at the same moment: one registration. */
    const both = await Promise.all(
      [0, 1].map(() => request('post', '/application/submit', a.token).send({ declaration_accepted: true })),
    );
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const done = both.find((r) => r.status === 201)!;
    expect(done.body.data.registration_id).toMatch(/^IPP-[0-9]{6}$/);
    expect(done.body.data.registration_number).toMatch(/^[0-9]{16}$/);
    ok(await request('post', '/application/submit', b.token).send({ declaration_accepted: true }), 201);

    const seen = (await request('get', '/application', a.token)).body.data;
    expect(seen).toMatchObject({ status: 'SUBMITTED', editable: false });
    expect(seen.registration.aadhaar_masked).toBe(`XXXX-XXXX-${a.aadhaar.slice(-4)}`);
    expect(JSON.stringify(seen)).not.toContain(a.aadhaar);
    expect(seen.submitted_files.find((f: { doc_type: string }) => f.doc_type === 'PHOTO').original_name).toBe('छायाचित्र.png');
    ok(await request('put', '/application/steps/1', a.token).send({ complete: false, data: { first_name: 'X' } }), 409);
  });

  it('a third student cannot register the same Aadhaar number', async () => {
    const c = students[2]!;
    const values = await formValues(centre, { mobile_number: c.mobile });
    const res = await request('put', '/application/steps/1', c.token).send({
      complete: true,
      data: { ...values, aadhaar_number: students[0]!.aadhaar, x_preferred_shift: 'Evening' },
    });
    expect(res.body.error.details).toEqual([
      { field: 'body.aadhaar_number', message: 'A registration with this Aadhaar number already exists' },
    ]);
  });

  it('the Auditor sees them, and approves only after every document is verified', async () => {
    const list = await request('get', '/manage/applicants?application_stage=AUDITOR&limit=20', admin.token);
    expect(list.body.data).toHaveLength(2);
    expect((await request('get', '/manage/summary', viewer.token)).body.data).toMatchObject({
      total: 3,
      approvals: { AWAITING: 2 },
    });
    for (const s of students.slice(0, 2)) {
      const early = await request('post', `/manage/applicants/${s.id}/approve`, admin.token).send({ reason: 'Every document checked' });
      ok(early, 409);
      expect(early.body.message).toMatch(/^Verify every document first \(0 of 10 verified\)/);
      const { documents } = (await request('get', `/manage/applicants/${s.id}`, admin.token)).body.data;
      for (const d of documents as { code: string; file: unknown }[])
        if (d.file)
          ok(
            await request('post', `/manage/applicants/${s.id}/documents/${d.code}/verify`, admin.token).send({ verified: true }),
          );
    }
    const approved = await request('post', '/manage/applicants/approve-selected', admin.token).send({
      ids: students.map((s) => s.id),
      reason: 'Every document checked',
    });
    expect(approved.body.data).toEqual({ approved: 2, skipped: 1 });
  });

  it('a corrected document must be verified again before the batch', async () => {
    const s = students[1]!;
    ok(await request('post', `/manage/applicants/${s.id}/documents`, admin.token).attach('PAN_CARD', FILES.jpg, 'pan.jpg'));
    ok(
      await request('put', `/manage/applicants/${s.id}/form`, admin.token).send({
        data: { landmark: 'Near temple', first_name: 'Asha Rani' },
      }),
    );
    const refused = await request('post', '/manage/batches', admin.token).send({
      name: 'First batch',
      centre_id: centre,
      ids: students.slice(0, 2).map((x) => x.id),
      technology: await optionId('TECHNOLOGY', 'T01'),
    });
    ok(refused, 409);
    expect(refused.body.message).toBe('1 student of the selected cannot be added: every document must be verified first.');
    ok(await request('post', `/manage/applicants/${s.id}/documents/PAN_CARD/verify`, admin.token).send({ verified: true }));
    const detail = (await request('get', `/manage/applicants/${s.id}`, admin.token)).body.data;
    expect(detail.account.name).toBe('Asha Rani NumberB');
    expect(detail.edits).toHaveLength(2);
    expect(detail.edits[0].changes.map((c: { key: string }) => c.key).sort()).toEqual(['first_name', 'landmark']);
  });

  let batch: string;
  it('they become a batch and go to the Divisional Officer', async () => {
    const made = await request('post', '/manage/batches', admin.token).send({
      name: 'First batch',
      centre_id: centre,
      ids: students.slice(0, 2).map((x) => x.id),
      start_date: '2027-01-04',
      end_date: '2027-04-04',
      delivery_mode: 'BLENDED',
      technology: await optionId('TECHNOLOGY', 'T01'),
    });
    ok(made, 201);
    batch = made.body.data.id;
    expect(made.body.data).toMatchObject({
      code: 'IPP-B-0001',
      students: 2,
      district: { name: 'Nashik' },
      stages: { DIVISION: 2 },
      start_date: '2027-01-04',
      delivery_mode: 'BLENDED',
      technology: { code: 'T01' },
      other_centre: 0,
    });
    expect((await request('get', '/manage/summary', admin.token)).body.data.approvals).toMatchObject({ BATCH: 0, DIVISION: 2 });
    /* In a batch: the district stays, and so does the center it is at. */
    const districts = (await request('get', '/manage/districts', admin.token)).body.data as { id: string; name: string }[];
    const pune = districts.find((d) => d.name === 'Pune')!.id;
    const moved = await request('put', `/manage/applicants/${students[0]!.id}/form`, admin.token).send({
      data: { district_id: pune },
    });
    expect(moved.body.error.details[0].message).toBe('District cannot be changed: the student is in a batch');
    expect((await request('delete', `/manage/centres/${centre}`, admin.token)).body.message).toMatch(
      /^This center cannot be deleted while .*batch/,
    );
  });

  it('one sent back stays in the batch and follows after a new approval', async () => {
    const s = students[0]!;
    await pool.query(
      `INSERT INTO approval_events (application_id, action, from_stage, to_stage, reason, actor_kind, actor_name)
       SELECT id, 'REJECT', 'DIVISION', 'AUDITOR', 'Photo is not clear', 'OFFICER', 'An Officer' FROM applications WHERE account_id = $1`,
      [s.id],
    );
    await pool.query(
      `UPDATE applications SET approval_stage = NULL, approved_at = NULL, approved_by = NULL WHERE account_id = $1`,
      [s.id],
    );
    const returned = (await request('get', '/manage/applicants?application_stage=RETURNED', admin.token)).body.data;
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({
      can_approve: true,
      can_batch: false,
      approval: {
        stage: null,
        batch: { id: batch },
        last_event: { action: 'REJECT', reason: 'Photo is not clear', by: 'An Officer' },
      },
    });
    expect((await request('get', `/manage/batches/${batch}`, admin.token)).body.data).toMatchObject({
      students: 2,
      stages: { AUDITOR: 1, DIVISION: 1 },
      rejected: 1,
    });
    ok(await request('post', `/manage/applicants/${s.id}/approve`, admin.token).send({ reason: 'Corrected and checked again' }));
    const history = (await request('get', `/manage/applicants/${s.id}`, admin.token)).body.data.history;
    expect(history.map((h: { from: { stage: string }; to: { stage: string } }) => `${h.from.stage}>${h.to.stage}`)).toEqual([
      'AUDITOR>DIVISION',
      'DIVISION>AUDITOR',
      'BATCH>DIVISION',
      'AUDITOR>BATCH',
    ]);
  });

  it('the documents can be downloaded together', async () => {
    const res = await request('get', `/manage/applicants/${students[0]!.id}/documents.zip`, viewer.token)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    ok(res as never);
    const names = await new Promise<string[]>((resolve, reject) => {
      yauzl.fromBuffer(res.body as Buffer, { lazyEntries: false }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        const found: string[] = [];
        zip.on('entry', (e: { fileName: string }) => found.push(e.fileName));
        zip.on('end', () => resolve(found));
        zip.on('error', reject);
      });
    });
    expect(names).toHaveLength(10);
  });

  it('a renamed or deleted master changes what is shown, never what is stored', async () => {
    const shift = (await request('get', `/manage/masters/${encodeURIComponent('FIELD:x_preferred_shift')}`, admin.token)).body
      .data as { id: string; name_en: string }[];
    const morning = shift.find((o) => o.name_en === 'Morning')!.id;
    const kind = encodeURIComponent('FIELD:x_preferred_shift');
    ok(await request('patch', `/manage/masters/${kind}/${morning}`, admin.token).send({ name_en: 'Early' }));
    const view = (await request('get', `/manage/applicants/${students[0]!.id}`, admin.token)).body.data.view_fields as {
      key: string;
      value: string;
      text: string;
    }[];
    expect(view.find((f) => f.key === 'x_preferred_shift')).toMatchObject({ value: 'Morning', text: 'Early' });
    ok(await request('delete', `/manage/masters/${kind}/${morning}`, admin.token));
    const mine = (await request('get', '/application', students[0]!.token)).body.data.view_fields as {
      key: string;
      text: string;
    }[];
    expect(mine.find((f) => f.key === 'x_preferred_shift')!.text).toBe('Early');
  });

  it('a switched-off panel user is out at once', async () => {
    ok(await request('patch', `/manage/users/${viewer.id}/status`, admin.token).send({ is_active: false }));
    ok(await request('get', '/manage/me', viewer.token), 401);
  });

  it('every change is in the audit log, without personal data', async () => {
    const log = await rows<{ action: string; details: unknown }>(`SELECT action, details FROM audit_logs ORDER BY id`);
    const actions = new Set(log.map((l) => l.action));
    for (const a of [
      'edp.account.create',
      'edp.account.verified',
      'edp.application.submitted',
      'edp.document.verify',
      'edp.application.approve_selected',
      'edp.application.approve',
      'edp.application.edit',
      'edp.application.documents',
      'edp.batch.create',
      'edp.user.status',
      'edp.field.create',
      'edp.taluka.create',
    ])
      expect(actions, a).toContain(a);
    const all = JSON.stringify(log);
    for (const secret of [students[0]!.aadhaar, students[0]!.mobile, students[0]!.email, 'Near temple', 'NumberA'])
      expect(all).not.toContain(secret);
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM applications WHERE data::text ~ $1`, [students[0]!.aadhaar]))!.n,
    ).toBe(0);
  });
});
