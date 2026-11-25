import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { aadhaarBlindIndex, decryptAadhaar } from '../../src/lib/aadhaar';
import { storage } from '../../src/services/storage';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  activeDocuments,
  districtId,
  FILES,
  makeAccount,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  newAadhaar,
  optionId,
  request,
  type TestPanelUser,
} from '../helpers/factory';
import { applicationRow, audits, detailsOf, fieldsOf, get, post, put, setStage, UNKNOWN_ID } from './helpers';

let admin: TestPanelUser;
let centre: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  centre = await makeCentre({ name: 'Nashik Center' });
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeDatabase);

const edit = (id: string, data: unknown, token = admin.token) => put(`/manage/applicants/${id}/form`, token, { data } as object);
const view = async (id: string) => (await get(`/manage/applicants/${id}`, admin.token)).body.data;
const listed = async (query: string) => (await get(`/manage/applicants${query}`, admin.token)).body.data as { id: string }[];
const changesOf = (res: { body: { data: { edits: { changes: { key: string }[] }[] } } }, i = 0) =>
  res.body.data.edits[i]!.changes.map((c) => c.key);

describe('PUT /manage/applicants/:id/form', () => {
  it('changes only what is different, records it as people read it, and answers the student', async () => {
    const s = await makeApplication('SUBMITTED', { centre, account: { first_name: 'Kavita', last_name: 'Jadhav' } });
    const id = s.student.id;
    const res = await edit(id, {
      first_name: '  Kaveri ',
      last_name: 'Patil',
      gender: 'Male',
      education_id: await optionId('EDUCATION', 'BE_BTECH'),
      pin_code: '411001',
      district_id: await districtId('PUN'),
      /* Unchanged values and the mask change nothing. */
      father_name: ' Ramesh Testkar ',
      aadhaar_number: `XXXX-XXXX-${s.aadhaar.slice(-4)}`,
      email: s.student.email.toUpperCase(),
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Form saved');
    const d = res.body.data;
    expect(d.form).toMatchObject({ first_name: 'Kaveri', last_name: 'Patil', gender: 'Male', pin_code: '411001' });
    expect(d.account.name).toBe('Kaveri Patil');
    expect(d.edits).toEqual([
      {
        at: expect.any(String),
        by: 'Program Auditor',
        changes: [
          { key: 'first_name', label: 'First Name', from: 'Kavita', to: 'Kaveri' },
          { key: 'last_name', label: 'Last Name', from: 'Jadhav', to: 'Patil' },
          { key: 'pin_code', label: 'PIN Code', from: '422001', to: '411001' },
          { key: 'district_id', label: 'District', from: 'Nashik', to: 'Pune' },
          { key: 'gender', label: 'Gender', from: 'Female', to: 'Male' },
          { key: 'education_id', label: 'Education Qualification', from: 'BCA', to: 'B.E. / B.Tech' },
        ],
      },
    ]);
    /* The lists and the search follow. */
    expect(await listed('?name=kaveri')).toEqual([expect.objectContaining({ id, name: 'Kaveri Patil', district: 'Pune' })]);
    expect((await listed(`?district_id=${await districtId('PUN')}`)).map((r) => r.id)).toEqual([id]);
    /* The same again changes nothing, and records nothing. */
    const again = await edit(id, { first_name: 'Kaveri', pin_code: ' 411001 ' });
    expect(again.status).toBe(200);
    expect(again.body.data.edits).toHaveLength(1);
    expect((await edit(id, {})).body.data.edits).toHaveLength(1);

    const log = await audits('edp.application.edit');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      resource: 'student_account',
      resource_id: id,
      actor_id: admin.id,
      details: {
        applicationId: s.applicationId,
        fields: ['first_name', 'last_name', 'pin_code', 'district_id', 'gender', 'education_id'],
        stage: null,
      },
    });
    expect(JSON.stringify(log)).not.toMatch(/Kaveri|411001/);
  });

  it('checks the changed values as the student’s form is checked, every problem at once', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const bad = await edit(s.student.id, {
      mother_name: '',
      pin_code: '12',
      gender: 'X',
      caste_id: UNKNOWN_ID,
      centre_id: UNKNOWN_ID,
      email: 'someone@example.test',
      date_of_birth: '2999-01-01',
      aadhaar_number: '123412341234',
      x_none: 'x',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toBe('Validation failed');
    expect(detailsOf(bad)).toEqual([
      { field: 'body.email', message: 'Email is the sign-in and cannot be changed' },
      { field: 'body.x_none', message: 'Unknown field' },
      { field: 'body.mother_name', message: 'Mother Name is required' },
      { field: 'body.date_of_birth', message: 'Date of Birth cannot be in the future' },
      { field: 'body.pin_code', message: 'PIN Code must be exactly 6 digits' },
      { field: 'body.aadhaar_number', message: 'Aadhaar Number must be 12 digits with a valid checksum' },
      { field: 'body.caste_id', message: 'Caste not found or inactive' },
      { field: 'body.gender', message: 'Select a valid Gender' },
      { field: 'body.centre_id', message: 'Center Name not found or inactive' },
    ]);
    /* Nothing is saved, not even what was right. */
    expect((await edit(s.student.id, { landmark: 'Near the temple', pin_code: 'x' })).status).toBe(422);
    const d = await view(s.student.id);
    expect(d.edits).toEqual([]);
    expect(d.form.landmark).toBe('');
    /* Only what is changed is checked: a stored value that is wrong now does not stand in the way. */
    await pool.query(`UPDATE applications SET data = data || '{"pin_code":"1"}' WHERE id = $1`, [s.applicationId]);
    expect((await edit(s.student.id, { landmark: 'Near the temple' })).status).toBe(200);
  });

  it('checks and clears what depends on a changed value', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const id = s.student.id;
    expect(fieldsOf(await edit(id, { disability_status: 'Yes' }))).toEqual([
      'body.disability_certificate_number',
      'body.disability_type',
    ]);
    const yes = { disability_status: 'Yes', disability_type: 'Low vision', disability_certificate_number: 'MH-1234' };
    expect((await edit(id, yes)).status).toBe(200);
    const cleared = await edit(id, { disability_status: 'No' });
    expect(cleared.body.data.form).toMatchObject({
      disability_status: 'No',
      disability_type: '',
      disability_certificate_number: '',
    });
    expect(changesOf(cleared)).toEqual(['disability_status', 'disability_type', 'disability_certificate_number']);

    expect(fieldsOf(await edit(id, { grading_type: 'CGPA' }))).toEqual(['body.cgpa_scale']);
    expect(detailsOf(await edit(id, { grading_type: 'CGPA', cgpa_scale: '10' }))).toEqual([
      { field: 'body.score', message: 'CGPA must be between 0 and 10' },
    ]);
    expect((await edit(id, { grading_type: 'CGPA', cgpa_scale: '10', score: '8.25' })).status).toBe(200);
    const percent = await edit(id, { grading_type: 'PERCENTAGE', score: '82.5' });
    expect(changesOf(percent)).toEqual(['grading_type', 'cgpa_scale', 'score']);
    expect(percent.body.data.form.cgpa_scale).toBe('');

    const same = await edit(id, { alternate_mobile_number: `+91 ${s.student.mobile}` });
    expect(detailsOf(same)).toEqual([
      { field: 'body.alternate_mobile_number', message: 'Alternate Mobile Number must be different from Mobile Number' },
    ]);
    expect((await edit(id, { alternate_mobile_number: '9123456780' })).status).toBe(200);
    expect(fieldsOf(await edit(id, { mobile_number: '9123456780' }))).toEqual(['body.alternate_mobile_number']);
    expect(fieldsOf(await edit(id, { alternate_email: s.student.email }))).toEqual(['body.alternate_email']);
  });

  it('accepts a value no longer offered while it stays, and offers the technologies of the new district', async () => {
    const s = await makeApplication('SUBMITTED', { centre, values: { technology: 'T03' } });
    const id = s.student.id;
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'GENDER' AND code = 'Female'`);
    await pool.query(
      `UPDATE program_options SET is_active = false, deleted_at = now() WHERE kind = 'TECHNOLOGY' AND code = 'T03'`,
    );
    await pool.query(`INSERT INTO district_technologies (district_id, option_id) VALUES ($1, $2)`, [
      await districtId('PUN'),
      await optionId('TECHNOLOGY', 'T05'),
    ]);
    expect((await edit(id, { landmark: 'Near the school', gender: 'Female', technology: 'T03' })).status).toBe(200);
    const texts = new Map(((await view(id)).view_fields as { key: string; text: string }[]).map((f) => [f.key, f.text]));
    expect(texts.get('technology')).toBe('Web Design & Development');
    /* Not with another district, whose technologies it is checked against. */
    expect(detailsOf(await edit(id, { district_id: await districtId('PUN') }))).toEqual([
      { field: 'body.technology', message: 'Select a valid Technology' },
    ]);
    expect((await edit(id, { gender: 'Male', technology: 'T07' })).status).toBe(200);
    /* Back to the one switched off: no. */
    expect(fieldsOf(await edit(id, { gender: 'Female' }))).toEqual(['body.gender']);
    expect(detailsOf(await edit(id, { district_id: await districtId('PUN') }))).toEqual([
      { field: 'body.technology', message: 'Technology is not offered in the selected district' },
    ]);
    expect((await edit(id, { district_id: await districtId('PUN'), technology: 'T05' })).status).toBe(200);
    /* A center switched off since stays too. */
    await pool.query(`UPDATE centres SET is_active = false WHERE id = $1`, [centre]);
    expect((await edit(id, { centre_id: centre, landmark: 'Near the river' })).status).toBe(200);
  });

  it('leaves switched-off fields out, and takes own fields by their type', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const id = s.student.id;
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'marital_status'`);
    await pool.query(
      `INSERT INTO program_fields (key, step, type, label_en, required, is_custom, display_order)
       VALUES ('x_hobby', 2, 'DROPDOWN', 'Hobby', true, true, 900), ('x_marks', 2, 'NUMBER', 'Marks', false, true, 910)`,
    );
    await pool.query(
      `INSERT INTO program_options (kind, code, name_en) VALUES ('FIELD:x_hobby', 'chess', 'Chess'), ('FIELD:x_hobby', 'music', 'Music')`,
    );
    /* Ignored: it is not part of the form now. An own field added since is not missed either. */
    const ignored = await edit(id, { marital_status: 'Married', landmark: 'Near the temple' });
    expect(changesOf(ignored)).toEqual(['landmark']);
    expect((await applicationRow(id)).data.marital_status).toBe('Unmarried');
    expect(detailsOf(await edit(id, { x_hobby: 'Golf', x_marks: 'many' }))).toEqual([
      { field: 'body.x_hobby', message: 'Select a valid Hobby' },
      { field: 'body.x_marks', message: 'Marks must be a number' },
    ]);
    const res = await edit(id, { x_hobby: 'music', x_marks: '12.5' });
    expect(res.body.data.edits[0].changes).toEqual([
      { key: 'x_hobby', label: 'Hobby', from: '', to: 'Music' },
      { key: 'x_marks', label: 'Marks', from: '', to: '12.5' },
    ]);
    expect((await applicationRow(id)).data).toMatchObject({ x_hobby: 'music', x_marks: '12.5' });
  });

  it('changes the Aadhaar number only by a full, valid one that no other submitted form has', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const id = s.student.id;
    const other = await makeApplication('SUBMITTED', { centre });
    const aadhaar = newAadhaar();
    for (const same of [
      '',
      '   ',
      s.aadhaar.slice(-4),
      `XXXX-XXXX-${s.aadhaar.slice(-4)}`,
      s.aadhaar,
      s.aadhaar.replace(/(.{4})/g, '$1 '),
    ])
      expect((await edit(id, { aadhaar_number: same })).status).toBe(200);
    expect((await view(id)).edits).toEqual([]);
    expect(detailsOf(await edit(id, { aadhaar_number: other.aadhaar }))).toEqual([
      { field: 'body.aadhaar_number', message: 'A registration with this Aadhaar number already exists' },
    ]);
    const res = await edit(id, { aadhaar_number: aadhaar.replace(/(\d{4})(?=\d)/g, '$1-') });
    expect(res.status).toBe(200);
    expect(res.body.data.aadhaar_masked).toBe(`XXXX-XXXX-${aadhaar.slice(-4)}`);
    expect(res.body.data.edits[0].changes).toEqual([
      {
        key: 'aadhaar_number',
        label: 'Aadhaar Number',
        from: `XXXX-XXXX-${s.aadhaar.slice(-4)}`,
        to: `XXXX-XXXX-${aadhaar.slice(-4)}`,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(aadhaar);
    const p = (await one<{ data: object; aadhaar_enc: Buffer; aadhaar_index: string; aadhaar_last4: string }>(
      `SELECT data, aadhaar_enc, aadhaar_index, aadhaar_last4 FROM applications WHERE account_id = $1`,
      [id],
    ))!;
    expect(decryptAadhaar(p.aadhaar_enc)).toBe(aadhaar);
    expect(p).toMatchObject({ aadhaar_index: aadhaarBlindIndex(aadhaar), aadhaar_last4: aadhaar.slice(-4) });
    expect(p.data).not.toHaveProperty('aadhaar_number');
    expect(JSON.stringify(await rows(`SELECT changes FROM application_edits`))).not.toContain(aadhaar);
    expect(JSON.stringify(await audits('edp.application.edit'))).not.toContain(aadhaar.slice(-4));
  });

  it('gives one new Aadhaar number to one of two forms edited at the same moment', async () => {
    const [a, b] = [await makeApplication('SUBMITTED', { centre }), await makeApplication('SUBMITTED', { centre })];
    const aadhaar = newAadhaar();
    const both = await Promise.all([a, b].map((s) => edit(s.student.id, { aadhaar_number: aadhaar })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(
      await one(`SELECT count(*)::int AS n FROM applications WHERE aadhaar_index = $1`, [aadhaarBlindIndex(aadhaar)]),
    ).toEqual({ n: 1 });
  });

  it('keeps the account in step: the name, and the mobile number as 10 digits', async () => {
    const s = await makeApplication('SUBMITTED', {
      centre,
      account: { first_name: 'Asha', last_name: 'Testkar', mobile: '9765412345' },
    });
    const id = s.student.id;
    await pool.query(`UPDATE student_accounts SET middle_name = 'Ramesh' WHERE id = $1`, [id]);
    const res = await edit(id, { mobile_number: '+91 98765-01234' });
    expect(res.body.data.account.mobile_number).toBe('9876501234');
    expect(res.body.data.form.mobile_number).toBe('+91 98765-01234');
    expect(await listed('?mobile=9876501234')).toEqual([expect.objectContaining({ id, mobile_number: '9876501234' })]);
    expect(await listed('?search=9765412345')).toEqual([]);
    expect(await listed('?name=asha')).toHaveLength(1);
    /* The name of the account was another one than the form's: both parts follow, the middle name stays. */
    await pool.query(`UPDATE student_accounts SET last_name = 'Other' WHERE id = $1`, [id]);
    const renamed = await edit(id, { first_name: 'Usha' });
    expect(renamed.body.data.account).toMatchObject({ name: 'Usha Ramesh Testkar', mobile_number: '9876501234' });
    /* Anything else leaves the account alone. */
    const before = await one(`SELECT * FROM student_accounts WHERE id = $1`, [id]);
    expect((await edit(id, { father_name: 'Suresh Testkar' })).status).toBe(200);
    expect(await one(`SELECT * FROM student_accounts WHERE id = $1`, [id])).toEqual(before);
  });

  it('is possible at every stage until the final approval; in a batch the district is fixed', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const o = { centre, by: admin, batch };
    const pune = await districtId('PUN');
    const waiting = await makeApplication('BATCH', o);
    expect((await edit(waiting.student.id, { district_id: pune })).status).toBe(200);
    for (const state of ['DIVISION', 'RETURNED'] as const) {
      const s = await makeApplication(state, o);
      expect(detailsOf(await edit(s.student.id, { district_id: pune }))).toEqual([
        { field: 'body.district_id', message: 'District cannot be changed: the student is in a batch' },
      ]);
      /* The same district is no change; everything else can be corrected. */
      expect((await edit(s.student.id, { district_id: await districtId(), landmark: 'Near the temple' })).status).toBe(200);
    }
    const coep = await makeApplication('DIVISION', o);
    await setStage(coep.student.id, 'COEP');
    const res = await edit(coep.student.id, { qualification_board: 'Fergusson College' });
    expect(res.body.data).toMatchObject({ approval: { stage: 'COEP' }, can_edit: true });
    expect((await audits('edp.application.edit')).at(-1)!.details).toMatchObject({ stage: 'COEP' });

    const refused = async (id: string) => {
      const r = await edit(id, { landmark: 'x' });
      return [r.status, r.body.message];
    };
    expect(await refused((await makeApplication('APPROVED', o)).student.id)).toEqual([
      409,
      'This form is finally approved and can no longer be changed.',
    ]);
    for (const id of [(await makeApplication('MAIN_DONE', o)).student.id, (await makeAccount()).id])
      expect(await refused(id)).toEqual([409, 'Only a submitted form can be changed here.']);
    for (const id of [UNKNOWN_ID, 'abc']) expect(await refused(id)).toEqual([404, 'Student not found']);
  });

  it('refuses a body that is not a set of text values', async () => {
    const id = (await makeApplication('SUBMITTED', { centre })).student.id;
    expect(detailsOf(await put(`/manage/applicants/${id}/form`, admin.token, {}))).toEqual([
      { field: 'body.data', message: 'data is required' },
    ]);
    expect(detailsOf(await edit(id, { landmark: 5 }))).toEqual([{ field: 'body.data.landmark', message: 'Value must be text' }]);
    expect(detailsOf(await edit(id, { landmark: 'x'.repeat(2001) }))).toEqual([
      { field: 'body.data.landmark', message: 'Value is too long' },
    ]);
    expect(detailsOf(await edit(id, { landmark: 'a\u0000b' }))).toEqual([
      { field: 'body.data.landmark', message: 'Value contains characters that cannot be saved' },
    ]);
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`x_${i}`, '']));
    expect(detailsOf(await edit(id, many))).toEqual([{ field: 'body.data', message: 'Too many values' }]);
    expect(detailsOf(await put(`/manage/applicants/${id}/form`, admin.token, { data: {}, status: 'DRAFT' }))).toEqual([
      { field: 'body.status', message: 'Unknown field' },
    ]);
  });

  it('keeps both changes of two Auditors who edit other fields at the same moment', async () => {
    const id = (await makeApplication('SUBMITTED', { centre })).student.id;
    const second = await makePanelUser('ADMIN');
    const both = await Promise.all([
      edit(id, { landmark: 'Near the temple' }),
      edit(id, { father_name: 'Suresh Testkar' }, second.token),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const d = await view(id);
    expect(d.form).toMatchObject({ landmark: 'Near the temple', father_name: 'Suresh Testkar' });
    expect(d.edits).toHaveLength(2);
  });
});

describe('POST /manage/applicants/:id/documents', () => {
  const upload = (id: string, files: [code: string, data: Buffer, name: string][], token = admin.token) => {
    const r = request('post', `/manage/applicants/${id}/documents`, token);
    for (const [code, data, name] of files) r.attach(code, data, name);
    return r;
  };
  const fileRow = async (applicationId: string, code: string) =>
    (await one<{ storage_key: string; mime_type: string; size_bytes: number; sha256: string; uploaded_at: Date }>(
      `SELECT * FROM application_files WHERE application_id = $1 AND document_code = $2`,
      [applicationId, code],
    ))!;

  it('replaces a document, which has to be verified again, and adds one', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const s = await makeApplication('DIVISION', {
      centre,
      by: admin,
      batch,
      account: { first_name: 'Kavya', last_name: 'Jadhav' },
    });
    const id = s.student.id;
    await pool.query(`UPDATE application_files SET uploaded_at = '2026-01-01T00:00:00Z' WHERE application_id = $1`, [
      s.applicationId,
    ]);
    const n = (await activeDocuments()).length;
    const old = await fileRow(s.applicationId, 'PHOTO');
    const data = Buffer.concat([FILES.pdf, Buffer.from('new')]);
    const res = await upload(id, [['PHOTO', data, 'photo-new.pdf']]);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Documents saved');
    const d = res.body.data;
    expect(d.documents[0]).toMatchObject({
      code: 'PHOTO',
      file: { original_name: 'photo-new.pdf', mime_type: 'application/pdf', size_bytes: data.length },
      verified: { verified: false, at: null, by: null },
    });
    expect(Date.now() - Date.parse(d.documents[0].file.uploaded_at)).toBeLessThan(60_000);
    /* The others keep their check, and when they were uploaded. */
    expect(d.documents[1]).toMatchObject({ verified: { verified: true }, file: { uploaded_at: '2026-01-01T00:00:00.000Z' } });
    expect(d.documents_verified).toEqual({ verified: false, at: null, by: null });
    expect(d.edits[0].changes).toEqual([{ key: 'PHOTO', label: 'Photo', from: 'photo.pdf', to: 'photo-new.pdf' }]);
    expect(d.approval.stage).toBe('DIVISION');

    /* Never over the old file, which is gone once the new one is saved. */
    const now = await fileRow(s.applicationId, 'PHOTO');
    expect(now.storage_key).not.toBe(old.storage_key);
    expect(now.storage_key).toMatch(/^candidates\/IPP-\d{6}_Kavya_Jadhav\/[\w-]+-PHOTO\.pdf$/);
    expect(await storage.exists(now.storage_key)).toBe(true);
    expect(await storage.exists(old.storage_key)).toBe(false);

    const added = await upload(id, [
      ['APPLICANT_VIDEO', FILES.mp4, 'video.mp4'],
      ['signature', FILES.png, 'sign.PNG'],
    ]);
    expect(added.status).toBe(200);
    expect(added.body.data.edits[0].changes).toEqual([
      { key: 'APPLICANT_VIDEO', label: 'Applicant Video with Aadhaar', from: '', to: 'video.mp4' },
      { key: 'SIGNATURE', label: 'Signature', from: 'signature.pdf', to: 'sign.PNG' },
    ]);
    expect(await fileRow(s.applicationId, 'SIGNATURE')).toMatchObject({ mime_type: 'image/png' });
    expect((await listed(''))[0]).toMatchObject({ documents: { uploaded: n + 1, verified: n - 2 }, documents_verified: false });
    const log = await audits('edp.application.documents');
    expect(log[0]).toMatchObject({
      resource: 'student_account',
      resource_id: id,
      actor_id: admin.id,
      details: {
        applicationId: s.applicationId,
        stage: 'DIVISION',
        documents: [{ document: 'PHOTO', size: data.length, sha256: now.sha256 }],
      },
    });
    expect(JSON.stringify(log)).not.toContain('photo-new');
    /* Verified again, the form is too. */
    for (const code of ['PHOTO', 'SIGNATURE', 'APPLICANT_VIDEO'])
      await post(`/manage/applicants/${id}/documents/${code}/verify`, admin.token, { verified: true });
    expect((await view(id)).documents_verified.verified).toBe(true);
  });

  it('keeps the name of a file in Marathi', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const name = 'माझा फोटो.pdf';
    const res = await upload(s.student.id, [['PHOTO', FILES.pdf, name]]);
    expect(res.body.data.documents[0].file.original_name).toBe(name);
    expect(res.body.data.edits[0].changes[0]).toMatchObject({ from: 'photo.pdf', to: name });
    const opened = await get(`/manage/applicants/${s.student.id}/documents/PHOTO/file`, admin.token);
    expect(opened.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  it('refuses a wrong file with the document it is for', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const id = s.student.id;
    const refused = async (...files: [string, Buffer, string][]) => {
      const res = await upload(id, files);
      expect(res.status).toBe(422);
      return detailsOf(res);
    };
    expect(await refused()).toEqual([{ field: 'files', message: 'Choose a file to upload' }]);
    expect(await refused(['FITNESS', FILES.pdf, 'x.pdf'])).toEqual([
      { field: 'files.FITNESS', message: 'Unknown or inactive document type' },
    ]);
    expect(await refused(['HSC_DIPLOMA', FILES.pdf, 'x.pdf'])).toEqual([
      { field: 'files.HSC_DIPLOMA', message: 'Unknown or inactive document type' },
    ]);
    expect(await refused(['PHOTO', FILES.pdf, 'a.pdf'], ['photo', FILES.pdf, 'b.pdf'])).toEqual([
      { field: 'files.photo', message: 'Only one Photo file may be uploaded' },
    ]);
    const only = (name: string) => `${name}: only PDF, JPG, JPEG or PNG files are accepted`;
    expect(await refused(['PHOTO', FILES.mp4, 'a.mp4'], ['PAN_CARD', Buffer.from('MZ'), 'pan.pdf'])).toEqual([
      { field: 'files.PHOTO', message: only('Photo') },
      { field: 'files.PAN_CARD', message: only('PAN Card') },
    ]);
    /* The content and the name must agree. */
    expect(await refused(['PHOTO', FILES.pdf, 'a.exe'])).toEqual([{ field: 'files.PHOTO', message: only('Photo') }]);
    expect(await refused(['PHOTO', FILES.png, 'a.pdf'])).toEqual([{ field: 'files.PHOTO', message: only('Photo') }]);
    expect(await refused(['APPLICANT_VIDEO', FILES.pdf, 'a.pdf'])).toEqual([
      { field: 'files.APPLICANT_VIDEO', message: 'Applicant Video with Aadhaar: only MP4 videos are accepted' },
    ]);
    const mb = (n: number) => Buffer.concat([FILES.pdf, Buffer.alloc(n * 1024 * 1024)]);
    expect(await refused(['PHOTO', mb(5), 'large.pdf'])).toEqual([
      { field: 'files.PHOTO', message: 'Photo: file is larger than 5 MB' },
    ]);
    /* Nothing is changed by any of them. */
    expect((await view(id)).edits).toEqual([]);
    expect((await upload(id, [['PHOTO', FILES.jpg, 'photo.jpeg']])).status).toBe(200);
  });

  it('takes a file for a document that is no longer asked for, when there is one already', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'DOMICILE'`);
    const res = await upload(s.student.id, [['DOMICILE', FILES.pdf, 'domicile-new.pdf']]);
    expect(res.status).toBe(200);
    expect(res.body.data.documents.at(-1)).toMatchObject({ code: 'DOMICILE', file: { original_name: 'domicile-new.pdf' } });
  });

  it('is refused for a draft, a finally approved form and an unknown student', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const refused = async (id: string) => {
      const r = await upload(id, [['PHOTO', FILES.pdf, 'photo.pdf']]);
      return [r.status, r.body.message];
    };
    expect(await refused((await makeApplication('APPROVED', { centre, by: admin, batch })).student.id)).toEqual([
      409,
      'This form is finally approved and can no longer be changed.',
    ]);
    for (const id of [(await makeApplication('DRAFT', { centre })).student.id, (await makeAccount()).id])
      expect(await refused(id)).toEqual([409, 'Only a submitted form can be changed here.']);
    for (const id of [UNKNOWN_ID, 'abc']) expect(await refused(id)).toEqual([404, 'Student not found']);
  });

  it('leaves the old file and no new one behind when it fails', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    const old = await fileRow(s.applicationId, 'PHOTO');
    /* The second file cannot be stored. */
    const write = storage.write;
    let n = 0;
    const failing = vi.spyOn(storage, 'write').mockImplementation(async (key, data) => {
      if (++n === 2) throw new Error('the disk is full');
      await write(key, data);
    });
    const res = await upload(s.student.id, [
      ['PHOTO', FILES.jpg, 'photo.jpg'],
      ['SIGNATURE', FILES.jpg, 'sign.jpg'],
    ]);
    expect(res.status).toBe(500);
    const keys = failing.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect([key, await storage.exists(key)]).toEqual([key, false]);
    expect(await fileRow(s.applicationId, 'PHOTO')).toMatchObject({ storage_key: old.storage_key });
    expect(await storage.exists(old.storage_key)).toBe(true);
    const d = await view(s.student.id);
    expect(d.documents_verified.verified).toBe(true);
    expect(d.edits).toEqual([]);
  });

  it('keeps the last of two replacements made at the same moment, and no stray file', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    const write = vi.spyOn(storage, 'write');
    const both = await Promise.all([
      upload(s.student.id, [['PHOTO', FILES.jpg, 'one.jpg']]),
      upload(s.student.id, [['PHOTO', FILES.png, 'two.png']]),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const current = (await fileRow(s.applicationId, 'PHOTO')).storage_key;
    const keys = write.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect([key, await storage.exists(key)]).toEqual([key, key === current]);
    const d = await view(s.student.id);
    expect(d.edits).toHaveLength(2);
    expect(d.documents_verified.verified).toBe(false);
  });
});
