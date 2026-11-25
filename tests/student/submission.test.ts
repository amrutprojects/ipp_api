import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { aadhaarBlindIndex, encryptAadhaar } from '../../src/lib/aadhaar';
import { storage } from '../../src/services/storage';
import { FILES, makeApplication, makeCentre, makePanelUser, newAadhaar, request } from '../helpers/factory';
import {
  application,
  auditActions,
  code,
  details,
  fileRows,
  isStored,
  post,
  ready,
  setUp,
  step,
  steps,
  storedIn,
  submit,
  upload,
  uploadAll,
  verifiedToken,
  fields,
} from './helpers';

setUp();

const DUPLICATE = 'A registration with this Aadhaar number already exists';
const row = async (id: string) => (await one<Record<string, unknown>>(`SELECT * FROM applications WHERE id = $1`, [id]))!;

/* The statements of every transaction go through `handle` (not those outside one). */
function intercept(handle: (sql: string, run: (sql?: string) => Promise<unknown>) => Promise<unknown>) {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
  return vi.spyOn(pool, 'connect').mockImplementation((async (...args: unknown[]) => {
    /* A single statement takes its connection with a callback. */
    if (args.length) return connect(...args);
    const client = await connect();
    const query = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<unknown>;
    const release = client.release.bind(client);
    const own = client as unknown as Record<'query' | 'release', unknown>;
    own.query = (sql: string, params?: unknown[]) => handle(sql, (changed = sql) => query(changed, params));
    own.release = () => {
      delete (own as Partial<typeof own>).query;
      release();
    };
    return client;
  }) as never);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await pool.query(`UPDATE program_documents SET is_active = code <> 'HSC_DIPLOMA' WHERE is_system`);
  await pool.query(`UPDATE program_options SET is_active = true`);
  await pool.query(`UPDATE centres SET is_active = true`);
  await pool.query(`DELETE FROM district_technologies`);
});

describe('POST /application/submit', () => {
  it('makes the form the registration: final, with its documents in the candidate’s folder', async () => {
    const r = await ready({ first_name: 'Kavya  R.', last_name: "D'Souza" });
    const drafts = (await fileRows(r.id)).map((f) => f.storage_key);
    const uploaded = (await application(r.token)).body.data.draft_files[0].uploaded_at;
    const res = await submit(r.token);
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Your form has been submitted successfully');
    expect(res.body.data).toEqual({
      registration_id: expect.stringMatching(/^IPP-\d{6}$/),
      registration_number: expect.stringMatching(/^\d{16}$/),
      status: 'SUBMITTED',
    });
    const { registration_id, registration_number } = res.body.data;

    const p = await row(r.id);
    expect(p).toMatchObject({
      status: 'SUBMITTED',
      current_step: 3,
      registration_code: registration_id,
      registration_number,
      aadhaar_index: aadhaarBlindIndex(r.basic.aadhaar_number!),
      aadhaar_last4: r.basic.aadhaar_number!.slice(-4),
      approval_stage: null,
      batch_id: null,
    });
    for (const at of ['submitted_at', 'declared_at', 'basic_completed_at', 'main_completed_at'])
      expect(p[at]).toBeInstanceOf(Date);
    const data = p.data as Record<string, string>;
    expect(data).toMatchObject({
      first_name: 'Kavya  R.',
      email: r.email,
      technology: 'T01',
      centre_id: r.main.centre_id,
      score: '72.5',
    });
    expect(data).not.toHaveProperty('aadhaar_number');

    /* One folder per candidate, letters, digits, '.', '_' and '-' only; nothing is left of the draft's files. */
    const folder = `candidates/${registration_id}_Kavya_R._D_Souza`;
    const files = await fileRows(r.id);
    expect(files).toHaveLength(9);
    for (const f of files) {
      expect(f.storage_key).toBe(`${folder}/${f.document_code}.pdf`);
      expect(isStored(f.storage_key)).toBe(true);
    }
    expect(drafts.some(isStored)).toBe(false);
    const file = await request('get', '/application/documents/PHOTO/file', r.token).buffer();
    expect(Buffer.from(file.body as Buffer).equals(FILES.pdf)).toBe(true);

    /* The audit log: ids and counts only. */
    expect((await auditActions(r.id)).slice(-1)).toEqual(['edp.application.submitted']);
    const [log] = await rows<{ details: unknown; actor_kind: string }>(
      `SELECT details, actor_kind FROM audit_logs WHERE resource_id = $1`,
      [r.id],
    );
    expect(log).toEqual({ details: { registration_id, files: 9 }, actor_kind: 'STUDENT' });

    const view = (await application(r.token)).body.data;
    expect(view).toMatchObject({
      status: 'SUBMITTED',
      current_step: 3,
      steps: { basic_completed: true, main_completed: true },
      editable: false,
      submitted_at: (p.submitted_at as Date).toISOString(),
      draft_files: [],
    });
    expect(view.registration).toEqual({
      registration_id,
      registration_number,
      status: 'SUBMITTED',
      aadhaar_masked: `XXXX-XXXX-${r.basic.aadhaar_number!.slice(-4)}`,
      display: {
        caste: 'मराठा',
        course_centre: 'Nashik',
        education: 'BCA',
        centre: expect.stringMatching(/^Test Center/),
        district: 'Nashik',
        taluka: null,
        religion: 'हिंदू',
        technology: 'Data Analytics & Business Intelligence',
        gender: 'Female',
        marital_status: 'Unmarried',
        educational_status: 'Completed',
        grading_type: 'Percentage',
        qualification_class: 'First Class',
      },
    });
    /* The Aadhaar is never shown in full again. */
    expect(view.form.aadhaar_number).toBe('');
    expect(JSON.stringify(view)).not.toContain(r.basic.aadhaar_number);
    expect(view.form).toMatchObject({ email: r.email, father_name: r.basic.father_name });
    expect(view.submitted_files[0]).toEqual({
      doc_type: 'PHOTO',
      name: 'Photo',
      original_name: 'photo.pdf',
      mime_type: 'application/pdf',
      size_bytes: FILES.pdf.length,
      /* When it was uploaded, not when it was submitted. */
      uploaded_at: uploaded,
      verified: false,
    });
    expect(view.documents).toHaveLength(10);
    expect(view.documents[0]).toMatchObject({ code: 'PHOTO', verified: { verified: false, at: null, by: null } });
    const shown = (key: string) => view.view_fields.find((f: { key: string }) => f.key === key);
    expect(view.view_fields).toHaveLength(36);
    expect(shown('caste_id')).toEqual({
      key: 'caste_id',
      step: 1,
      label_en: 'Caste',
      label_mr: 'जात',
      type: 'DROPDOWN',
      value: r.basic.caste_id,
      text: 'मराठा',
      custom: false,
    });
    expect(shown('aadhaar_number')).toMatchObject({ value: '', text: `XXXX-XXXX-${r.basic.aadhaar_number!.slice(-4)}` });
  });

  it('shows which documents the Auditor has verified, not who did', async () => {
    const { student, applicationId } = await makeApplication('SUBMITTED', { centre: await makeCentre() });
    const admin = await makePanelUser('ADMIN', { name: 'Asha Auditor' });
    await pool.query(`INSERT INTO document_checks (application_id, document_code, verified_by) VALUES ($1, 'PHOTO', $2)`, [
      applicationId,
      admin.id,
    ]);
    const view = (await application(student.token)).body.data;
    const verified = (code: string) => view.submitted_files.find((f: { doc_type: string }) => f.doc_type === code).verified;
    expect([verified('PHOTO'), verified('SIGNATURE')]).toEqual([true, false]);
    expect(JSON.stringify(view)).not.toContain('Asha Auditor');
  });

  it('gives each submission the next registration ID, and a number of its own from the program’s clock', async () => {
    const [a, b] = [await ready(), await ready()];
    /* MMDDHHmmssSSS in Asia/Kolkata, then microseconds. */
    const clock = async () =>
      (await one<{ t: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Kolkata', 'MMDDHH24MISSMS') AS t`))!.t;
    const before = await clock();
    const results = await Promise.all([submit(a.token), submit(b.token)]);
    const after = await clock();
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const ids = results.map((r) => Number(r.body.data.registration_id.slice(4))).sort((x, y) => x - y);
    expect(ids[1]).toBe(ids[0]! + 1);
    const numbers = results.map((r) => r.body.data.registration_number as string);
    expect(new Set(numbers).size).toBe(2);
    for (const n of numbers) expect([before, n.slice(0, 13), after]).toEqual([before, n.slice(0, 13), after].sort());
  });

  it('checks the declaration', async () => {
    const r = await ready();
    for (const body of [{}, { declaration_accepted: false }, { declaration_accepted: 'true' }])
      expect(details(await post('/application/submit', body, r.token))).toEqual([
        { field: 'body.declaration_accepted', message: 'The declaration must be accepted' },
      ]);
    expect(fields(await post('/application/submit', { declaration_accepted: true, barcodes: {} }, r.token))).toEqual([
      'body.barcodes',
    ]);
    expect((await row(r.id)).status).toBe('DRAFT');
  });

  it('checks everything again: an empty form, every problem at once', async () => {
    const token = await verifiedToken();
    const res = await submit(token);
    expect(res.status).toBe(422);
    expect(details(res)).toEqual(
      expect.arrayContaining([
        { field: 'body.father_name', message: 'Father Name is required' },
        { field: 'body.aadhaar_number', message: 'Aadhaar Number is required' },
        { field: 'body.technology', message: 'Technology is required' },
        { field: 'files.PHOTO', message: 'Photo is required' },
        { field: 'files.DOMICILE', message: 'Domicile of Certificate Maharashtra is required' },
      ]),
    );
    /* The optional video is not asked for. */
    expect(fields(res)).not.toContain('files.APPLICANT_VIDEO');
    expect(fields(res)).not.toContain('files.HSC_DIPLOMA');
  });

  it('an autosaved form that is right may be submitted as it is', async () => {
    const token = await verifiedToken();
    const { basic, main } = await steps();
    await step(token, 1, basic, false);
    await step(token, 2, main, false);
    await uploadAll(token);
    expect((await submit(token)).status).toBe(201);
    expect((await application(token)).body.data.steps).toEqual({ basic_completed: true, main_completed: true });
  });

  it('checks the masters as they are now', async () => {
    const r = await ready();
    await pool.query(`UPDATE centres SET is_active = false WHERE id = $1`, [r.main.centre_id]);
    expect(details(await submit(r.token))).toEqual([{ field: 'body.centre_id', message: 'Center Name not found or inactive' }]);
    await pool.query(`UPDATE centres SET is_active = true WHERE id = $1`, [r.main.centre_id]);
    await pool.query(
      `INSERT INTO district_technologies SELECT $1, id FROM program_options WHERE kind = 'TECHNOLOGY' AND code = 'T03'`,
      [r.basic.district_id],
    );
    expect(details(await submit(r.token))).toEqual([
      { field: 'body.technology', message: 'Technology is not offered in the selected district' },
    ]);
    /* None of the district's choices is active any more: the same as none chosen. */
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'TECHNOLOGY' AND code = 'T03'`);
    await request('delete', '/application/documents/PAN_CARD', r.token);
    expect(details(await submit(r.token))).toEqual([{ field: 'files.PAN_CARD', message: 'PAN Card is required' }]);
    await upload(r.token, [['PAN_CARD', FILES.jpg, 'pan.jpg']]);
    /* A document switched off meanwhile is not asked for; its file stays with the form. */
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'DOMICILE'`);
    const res = await submit(r.token);
    expect(res.status).toBe(201);
    const view = (await application(r.token)).body.data;
    expect(view.submitted_files.map((f: { doc_type: string }) => f.doc_type)).toContain('DOMICILE');
    const keys = (await fileRows(r.id)).map((f) => f.storage_key.split('/').at(-1));
    expect(keys).toContain('PAN_CARD.jpg');
    expect(keys).toContain('DOMICILE.pdf');
  });

  it('drops what does not apply, and keeps the values of fields switched off meanwhile', async () => {
    const r = await ready();
    await pool.query(`UPDATE applications SET data = data || '{"cgpa_scale":"10","landmark":"Old fort"}' WHERE id = $1`, [r.id]);
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'landmark'`);
    try {
      expect((await submit(r.token)).status).toBe(201);
      expect((await row(r.id)).data).toMatchObject({ cgpa_scale: '', landmark: 'Old fort' });
    } finally {
      await pool.query(`UPDATE program_fields SET is_active = true WHERE key = 'landmark'`);
    }
  });

  it('refuses the Aadhaar number of another submitted form, and moves nothing', async () => {
    const centre = await makeCentre();
    const other = await makeApplication('SUBMITTED', { centre });
    const r = await ready();
    await pool.query(`UPDATE applications SET aadhaar_enc = $2 WHERE id = $1`, [r.id, encryptAadhaar(other.aadhaar)]);
    const candidates = storedIn('candidates').length;
    const before = await fileRows(r.id);
    const res = await submit(r.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(DUPLICATE);
    expect(code(res)).toBe('CONFLICT');
    expect(await fileRows(r.id)).toEqual(before);
    expect(before.every((f) => isStored(f.storage_key))).toBe(true);
    expect((await row(r.id)).status).toBe('DRAFT');
    expect(storedIn('candidates')).toHaveLength(candidates);
  });

  it('two drafts of one Aadhaar number submitted at once: one is registered, the other refused', async () => {
    const aadhaar = newAadhaar();
    const [a, b] = [await ready(), await ready()];
    await pool.query(`UPDATE applications SET aadhaar_enc = $2 WHERE id = ANY($1::uuid[])`, [
      [a.id, b.id],
      encryptAadhaar(aadhaar),
    ]);
    const results = await Promise.all([submit(a.token), submit(b.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.message).toBe(DUPLICATE);
    const refused = results[0]!.status === 409 ? a : b;
    expect((await fileRows(refused.id)).every((f) => isStored(f.storage_key))).toBe(true);
  });

  it('the unique index is the last guard: a form with the number that appears meanwhile', async () => {
    const r = await ready();
    const centre = await makeCentre();
    const other = await makeApplication('SUBMITTED', { centre });
    const { aadhaar_index, aadhaar_last4 } = {
      aadhaar_index: aadhaarBlindIndex(r.basic.aadhaar_number!),
      aadhaar_last4: r.basic.aadhaar_number!.slice(-4),
    };
    /* After the check, while the documents are copied. */
    const copy = storage.copy;
    vi.spyOn(storage, 'copy').mockImplementationOnce(async (from, to) => {
      await copy(from, to);
      await pool.query(`UPDATE applications SET aadhaar_index = $2, aadhaar_last4 = $3 WHERE id = $1`, [
        other.applicationId,
        aadhaar_index,
        aadhaar_last4,
      ]);
    });
    const before = await fileRows(r.id);
    const res = await submit(r.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(DUPLICATE);
    expect(await fileRows(r.id)).toEqual(before);
    expect(before.every((f) => isStored(f.storage_key))).toBe(true);
  });

  it('submitted twice at once: one registration, the other already submitted', async () => {
    const r = await ready();
    const results = await Promise.all([submit(r.token), submit(r.token), submit(r.token)]);
    expect(results.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    for (const res of results.filter((x) => x.status === 409)) {
      expect(code(res)).toBe('ALREADY_SUBMITTED');
      expect(res.body.message).toBe('Your form has already been submitted. A submitted form cannot be changed.');
    }
    const p = await row(r.id);
    expect(results.find((x) => x.status === 201)!.body.data.registration_id).toBe(p.registration_code);
    expect((await fileRows(r.id)).every((f) => isStored(f.storage_key))).toBe(true);
    expect(code(await submit(r.token))).toBe('ALREADY_SUBMITTED');
    expect((await auditActions(r.id)).filter((a) => a === 'edp.application.submitted')).toHaveLength(1);
  });

  it('a storage that fails half way changes nothing: the form can be submitted again', async () => {
    const r = await ready();
    const before = await fileRows(r.id);
    const candidates = storedIn('candidates').length;
    const copy = storage.copy;
    vi.spyOn(storage, 'copy')
      .mockImplementationOnce(copy)
      .mockImplementationOnce(copy)
      .mockRejectedValueOnce(new Error('disk full'));
    expect((await submit(r.token)).status).toBe(500);
    expect((await row(r.id)).status).toBe('DRAFT');
    expect(await fileRows(r.id)).toEqual(before);
    expect(before.every((f) => isStored(f.storage_key))).toBe(true);
    expect(storedIn('candidates')).toHaveLength(candidates);
    expect((await submit(r.token)).status).toBe(201);
  });

  it('a commit whose answer is lost loses no file', async () => {
    const r = await ready();
    /* The transaction of the submission commits, and then its connection breaks off. */
    let submits = false;
    const spy = intercept(async (sql, run) => {
      const result = await run();
      if (sql.includes(`status = 'SUBMITTED', submitted_at`)) submits = true;
      if (submits && sql === 'COMMIT') throw new Error('connection lost');
      return result;
    });
    expect((await submit(r.token)).status).toBe(500);
    spy.mockRestore();
    expect((await row(r.id)).status).toBe('SUBMITTED');
    const files = await fileRows(r.id);
    expect(files.every((f) => f.storage_key.startsWith('candidates/') && isStored(f.storage_key))).toBe(true);
    expect(code(await submit(r.token))).toBe('ALREADY_SUBMITTED');
  });

  it('a draft’s file that cannot be deleted does not fail the submission', async () => {
    const r = await ready();
    vi.spyOn(storage, 'remove').mockRejectedValue(new Error('busy'));
    expect((await submit(r.token)).status).toBe(201);
    expect((await fileRows(r.id)).every((f) => f.storage_key.startsWith('candidates/') && isStored(f.storage_key))).toBe(true);
  });

  it('a registration number already given is not given again', async () => {
    const { applicationId } = await makeApplication('SUBMITTED', { centre: await makeCentre() });
    const r = await ready();
    await pool.query(`UPDATE applications SET registration_number = '0102030405678901' WHERE id = $1`, [applicationId]);
    /* The clock stands still (the same instant of an earlier year): it is read again, and in the end refused. */
    intercept((sql, run) => run(sql.replace('clock_timestamp() AS t', `'2026-01-02 03:04:05.678901+05:30'::timestamptz AS t`)));
    const refused = await submit(r.token);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Could not allocate a registration number right now; please try again');
    expect((await row(r.id)).status).toBe('DRAFT');
    await pool.query(`UPDATE applications SET registration_number = NULL WHERE id = $1`, [applicationId]);
    expect((await submit(r.token)).body.data.registration_number).toBe('0102030405678901');
  });

  it('is an activity of the student', async () => {
    const r = await ready();
    await pool.query(`UPDATE applications SET student_active_at = now() - interval '2 days' WHERE id = $1`, [r.id]);
    await submit(r.token);
    expect(Date.now() - ((await row(r.id)).student_active_at as Date).getTime()).toBeLessThan(60_000);
  });
});
