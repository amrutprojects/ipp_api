import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  activeDocuments,
  districtId,
  makeAccount,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  optionId,
  type TestApplication,
  type TestPanelUser,
} from '../helpers/factory';
import { applicationRow, audits, detailsOf, fieldsOf, get, post, put, setStage, UNKNOWN_ID } from './helpers';

afterAll(closeDatabase);

interface Row {
  id: string;
  email: string;
  stage: string;
  [key: string]: unknown;
}
const list = (token: string, query = '') => get(`/manage/applicants${query}`, token);
const ids = async (token: string, query: string) => {
  const res = await list(token, query);
  expect([query, res.status]).toEqual([query, 200]);
  return (res.body.data as Row[]).map((r) => r.id).sort();
};
const sorted = (...students: { id: string }[]) => students.map((s) => s.id).sort();

describe('counts, filters and the list', () => {
  let admin: TestPanelUser;
  let viewer: TestPanelUser;
  let centre: string;
  let puneCentre: string;
  let pending: { id: string };
  let verified: { id: string };
  let basic: TestApplication;
  let main: TestApplication;
  let submitted: TestApplication;
  let ready: TestApplication;
  let waiting: TestApplication;
  let division: TestApplication;
  let returned: TestApplication;
  let approved: TestApplication;
  let batchId: string;

  beforeAll(async () => {
    await resetDatabase();
    admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
    viewer = await makePanelUser('VIEWER');
    centre = await makeCentre({ name: 'Nashik Center' });
    puneCentre = await makeCentre({ name: 'Pune Center', district: 'PUN', active: false });
    batchId = await makeBatch({ centre, by: admin, name: 'Nashik Batch 1', size: 3 });
    const o = { centre, by: admin, batch: batchId };
    pending = await makeAccount({ verified: false, email: 'pending@example.test' });
    verified = await makeAccount({ first_name: 'Zeenat', last_name: 'Verified' });
    basic = await makeApplication('BASIC_DONE', { ...o, account: { email: 'stepone@example.test' } });
    main = await makeApplication('MAIN_DONE', o);
    submitted = await makeApplication('SUBMITTED', {
      ...o,
      account: { first_name: 'Kavya', last_name: 'Jadhav', mobile: '9765412345' },
      values: { district_id: await districtId('PUN'), centre_id: puneCentre, caste_id: await optionId('CASTE', 'SAR02') },
    });
    ready = await makeApplication('VERIFIED_DOCS', o);
    waiting = await makeApplication('BATCH', o);
    division = await makeApplication('DIVISION', o);
    returned = await makeApplication('RETURNED', o);
    approved = await makeApplication('APPROVED', o);
  });

  it('counts every student by stage, follow-up and approval, whatever is filtered', async () => {
    expect((await post(`/manage/applicants/${verified.id}/follow-ups`, admin.token, { status: 'CALLED' })).status).toBe(201);
    expect((await post(`/manage/applicants/${verified.id}/follow-ups`, admin.token, { status: 'SECOND_CALL' })).status).toBe(201);
    const deleted = await makeAccount();
    await pool.query(`UPDATE student_accounts SET deleted_at = now() WHERE id = $1`, [deleted.id]);
    const res = await get('/manage/summary', viewer.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      total: 10,
      counts: { OTP_PENDING: 1, VERIFIED: 1, BASIC_DONE: 1, MAIN_DONE: 1, SUBMITTED: 6 },
      stages: [
        { code: 'OTP_PENDING', label: 'Account created – OTP not verified', count: 1 },
        { code: 'VERIFIED', label: 'OTP verified – form not started', count: 1 },
        { code: 'BASIC_DONE', label: 'Step 1 filled (Basic Details)', count: 1 },
        { code: 'MAIN_DONE', label: 'Step 2 filled (Main Form)', count: 1 },
        { code: 'SUBMITTED', label: 'Form submitted', count: 6 },
      ],
      follow_ups: { NONE: 9, PENDING: 0, CALLED: 0, SECOND_CALL: 1, FORM_FILLED: 0 },
      approvals: {
        AWAITING: 3,
        RETURNED: 1,
        WITH_CANDIDATE: 0,
        BATCH: 1,
        DIVISION: 1,
        COEP: 0,
        HEAD_OFFICE: 0,
        ADMIN: 0,
        APPROVED: 1,
      },
    });
  });

  it('offers the choices of the filters', async () => {
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'CASTE' AND code = 'SAR03'`);
    await pool.query(`UPDATE districts SET is_active = false WHERE code = 'AKO'`);
    const data = (await get('/manage/filters', viewer.token)).body.data;
    expect(Object.keys(data).sort()).toEqual(['categories', 'centres', 'districts', 'stages']);
    expect(data.districts).toHaveLength(35);
    expect(data.districts[0]).toEqual({ id: await districtId('AHL'), name: 'Ahilyanagar' });
    const names = data.districts.map((d: { name: string }) => d.name);
    expect(names).toEqual([...names].sort());
    /* The castes by their Marathi names, also one switched off. */
    expect(data.categories).toEqual([
      { id: await optionId('CASTE', 'SAR01'), name: 'मराठा' },
      { id: await optionId('CASTE', 'SAR02'), name: 'मराठा-कुणबी' },
      { id: await optionId('CASTE', 'SAR03'), name: 'कुणबी-मराठा' },
    ]);
    expect(data.centres).toEqual([
      { id: centre, name: 'Nashik Center' },
      { id: puneCentre, name: 'Pune Center' },
    ]);
    expect(data.stages).toEqual([
      { code: 'OTP_PENDING', label: 'OTP pending' },
      { code: 'VERIFIED', label: 'Account verified' },
      { code: 'BASIC_DONE', label: 'Step 1 filled' },
      { code: 'MAIN_DONE', label: 'Step 2 filled' },
      { code: 'AUDITOR', label: 'Submitted: with the Auditor' },
      { code: 'RETURNED', label: 'Sent back to the Auditor' },
      { code: 'WITH_CANDIDATE', label: 'Sent back to the candidate' },
      { code: 'BATCH', label: 'Approved: waiting for a batch' },
      { code: 'DIVISION', label: 'With Divisional Officer' },
      { code: 'COEP', label: 'With COEP' },
      { code: 'HEAD_OFFICE', label: 'With Head Office' },
      { code: 'ADMIN', label: 'With Super Admin (final approval)' },
      { code: 'APPROVED', label: 'Final approved' },
    ]);
  });

  it('lists every account, newest first, page by page', async () => {
    const all = await list(viewer.token);
    expect(all.body.meta).toEqual({ page: 1, limit: 25, total: 10, totalPages: 1 });
    expect((all.body.data as Row[]).map((r) => r.id)).toEqual([
      approved.student.id,
      returned.student.id,
      division.student.id,
      waiting.student.id,
      ready.student.id,
      submitted.student.id,
      main.student.id,
      basic.student.id,
      verified.id,
      pending.id,
    ]);
    const second = await list(viewer.token, '?page=2&limit=4');
    expect(second.body.meta).toEqual({ page: 2, limit: 4, total: 10, totalPages: 3 });
    expect((second.body.data as Row[]).map((r) => r.id)).toEqual((all.body.data as Row[]).slice(4, 8).map((r) => r.id));
    /* A page beyond the end is empty, with the real number of pages (never 0). */
    const beyond = await list(viewer.token, '?page=9&limit=4');
    expect(beyond.body).toMatchObject({ data: [], meta: { page: 9, limit: 4, total: 10, totalPages: 3 } });
    expect((await list(viewer.token, '?name=nobody')).body.meta).toEqual({ page: 1, limit: 25, total: 0, totalPages: 1 });
    const oldest = await list(viewer.token, '?sortBy=createdAt&sortOrder=asc&limit=2');
    expect((oldest.body.data as Row[]).map((r) => r.id)).toEqual([pending.id, verified.id]);
  });

  it('shows everything of a row', async () => {
    const row = (await list(viewer.token, `?search=${encodeURIComponent('kavya jadhav')}`)).body.data[0];
    const p = await applicationRow(submitted.student.id);
    const { registration_code, registration_number } = (await one<{ registration_code: string; registration_number: string }>(
      `SELECT registration_code, registration_number FROM applications WHERE id = $1`,
      [p.id],
    ))!;
    expect(row).toEqual({
      id: submitted.student.id,
      name: 'Kavya Jadhav',
      email: submitted.student.email,
      mobile_number: '9765412345',
      stage: 'SUBMITTED',
      stage_label: 'Form submitted',
      account_created_at: expect.any(String),
      otp_verified_at: expect.any(String),
      last_login_at: null,
      basic_completed_at: expect.any(String),
      main_completed_at: expect.any(String),
      submitted_at: expect.any(String),
      registration_id: registration_code,
      registration_number,
      district_id: await districtId('PUN'),
      district: 'Pune',
      category: 'मराठा-कुणबी',
      centre: 'Pune Center',
      centre_id: puneCentre,
      documents: { uploaded: (await activeDocuments()).length, verified: 0 },
      documents_verified: false,
      final_verified: false,
      last_activity_at: expect.any(String),
      follow_up: null,
      can_approve: false,
      can_batch: false,
      returned_at: null,
      approval: {
        stage: null,
        stage_label: null,
        stage_updated_at: null,
        approved_at: null,
        approved_by: null,
        last_event: null,
        register_id: null,
        batch: null,
        reason_required: false,
      },
    });
    expect(row.registration_id).toMatch(/^IPP-\d{6}$/);

    const rows = new Map(((await list(viewer.token)).body.data as Row[]).map((r) => [r.id, r]));
    /* A draft, and an account without a form, have no approval. */
    for (const s of [pending, verified, basic.student, main.student])
      expect(rows.get(s.id)).toMatchObject({
        approval: null,
        registration_id: null,
        submitted_at: null,
        can_approve: false,
        can_batch: false,
        documents: { uploaded: 0, verified: 0 },
      });
    expect(rows.get(pending.id)).toMatchObject({
      stage: 'OTP_PENDING',
      otp_verified_at: null,
      district: null,
      centre: null,
      centre_id: null,
    });
    expect(rows.get(verified.id)).toMatchObject({ stage: 'VERIFIED', stage_label: 'OTP verified – form not started' });
    expect(rows.get(basic.student.id)).toMatchObject({ stage: 'BASIC_DONE', main_completed_at: null, district: 'Nashik' });
    expect(rows.get(main.student.id)).toMatchObject({ stage: 'MAIN_DONE', stage_label: 'Step 2 filled (Main Form)' });

    expect(rows.get(ready.student.id)).toMatchObject({
      can_approve: true,
      can_batch: false,
      documents_verified: true,
      approval: { stage: null },
    });
    expect(rows.get(waiting.student.id)).toMatchObject({
      can_approve: false,
      can_batch: true,
      approval: {
        stage: 'BATCH',
        stage_label: 'Approved: waiting for a batch',
        approved_at: expect.any(String),
        approved_by: 'Program Auditor',
        last_event: {
          action: 'APPROVE',
          from: { stage: 'AUDITOR', name: 'Auditor' },
          to: { stage: 'BATCH', name: 'Batch' },
          /* The Auditor's approval reason. */
          reason: 'Every document checked',
          by: 'Program Auditor',
          at: expect.any(String),
        },
        register_id: null,
        batch: null,
      },
    });
    expect(rows.get(division.student.id)).toMatchObject({
      can_approve: false,
      can_batch: false,
      approval: { stage: 'DIVISION', stage_label: 'With Divisional Officer', batch: { id: batchId, name: 'Nashik Batch 1' } },
    });
    /* Sent back: with the Auditor again, still in the batch. */
    expect(rows.get(returned.student.id)).toMatchObject({
      can_approve: true,
      can_batch: false,
      approval: {
        stage: null,
        stage_label: null,
        approved_at: null,
        approved_by: null,
        last_event: {
          action: 'REJECT',
          from: { stage: 'DIVISION', name: 'Divisional Officer' },
          to: { stage: 'AUDITOR', name: 'Auditor' },
          reason: 'Photo is not clear',
          by: 'Test Officer',
        },
        batch: { id: batchId },
      },
    });
    const final = rows.get(approved.student.id)!;
    expect(final).toMatchObject({ final_verified: true, approval: { stage: 'APPROVED', stage_label: 'Final approved' } });
    expect((final.approval as { register_id: string }).register_id).toBe(final.registration_id);
  });

  it('filters by stage, approval, documents and the final verification', async () => {
    const T = viewer.token;
    expect(await ids(T, '?stage=SUBMITTED')).toEqual(
      sorted(...[submitted, ready, waiting, division, returned, approved].map((a) => a.student)),
    );
    expect(await ids(T, '?stage=BASIC_DONE')).toEqual([basic.student.id]);
    expect(await ids(T, '?application_stage=OTP_PENDING')).toEqual([pending.id]);
    expect(await ids(T, '?application_stage=VERIFIED')).toEqual([verified.id]);
    expect(await ids(T, '?application_stage=MAIN_DONE')).toEqual([main.student.id]);
    expect(await ids(T, '?application_stage=AUDITOR')).toEqual(sorted(submitted.student, ready.student, returned.student));
    expect(await ids(T, '?application_stage=RETURNED')).toEqual([returned.student.id]);
    expect(await ids(T, '?application_stage=BATCH')).toEqual([waiting.student.id]);
    expect(await ids(T, '?application_stage=DIVISION')).toEqual([division.student.id]);
    expect(await ids(T, '?application_stage=COEP')).toEqual([]);
    expect(await ids(T, '?application_stage=APPROVED')).toEqual([approved.student.id]);
    expect(await ids(T, '?approval=AWAITING')).toEqual(sorted(submitted.student, ready.student, returned.student));
    expect(await ids(T, '?approval=RETURNED')).toEqual([returned.student.id]);
    expect(await ids(T, '?approval=BATCH')).toEqual([waiting.student.id]);
    expect(await ids(T, '?documents=VERIFIED')).toEqual(
      sorted(...[ready, waiting, division, returned, approved].map((a) => a.student)),
    );
    expect(await ids(T, '?documents=NOT_VERIFIED')).toEqual(
      sorted(pending, verified, basic.student, main.student, submitted.student),
    );
    expect(await ids(T, '?final=VERIFIED')).toEqual([approved.student.id]);
    expect(await ids(T, '?final=NOT_VERIFIED')).toHaveLength(9);
  });

  it('filters by the form, the name, the mobile number and the follow-up', async () => {
    const T = viewer.token;
    expect(await ids(T, `?district_id=${await districtId('PUN')}`)).toEqual([submitted.student.id]);
    expect(await ids(T, `?caste_id=${await optionId('CASTE', 'SAR02')}`)).toEqual([submitted.student.id]);
    expect(await ids(T, `?centre_id=${puneCentre}`)).toEqual([submitted.student.id]);
    expect(await ids(T, '?name=ZEENAT%20ver')).toEqual([verified.id]);
    expect(await ids(T, '?mobile=654123')).toEqual([submitted.student.id]);
    expect(await ids(T, '?follow_up=SECOND_CALL')).toEqual([verified.id]);
    /* Only the latest follow-up counts. */
    expect(await ids(T, '?follow_up=CALLED')).toEqual([]);
    expect(await ids(T, '?follow_up=NONE')).toHaveLength(9);
    const [row] = (await list(T, '?follow_up=SECOND_CALL')).body.data;
    expect(row.follow_up).toEqual({
      status: 'SECOND_CALL',
      status_label: 'Second follow-up',
      note: null,
      at: expect.any(String),
      by: 'Program Auditor',
    });
    /* All together, and blank ones are the same as none. */
    expect(await ids(T, `?district_id=${await districtId('PUN')}&name=kavya&stage=SUBMITTED&final=NOT_VERIFIED`)).toEqual([
      submitted.student.id,
    ]);
    expect(await ids(T, `?district_id=${await districtId('PUN')}&name=zeenat`)).toEqual([]);
    expect(
      await ids(
        T,
        '?name=&mobile=&district_id=&documents=&final=&application_stage=&stage=&follow_up=&approval=&search=&page=&limit=',
      ),
    ).toHaveLength(10);
  });

  it('searches name, email, mobile and registration ID; wildcards are literal', async () => {
    const T = viewer.token;
    expect(await ids(T, '?search=pending@')).toEqual([pending.id]);
    expect(await ids(T, '?search=KAVYA')).toEqual([submitted.student.id]);
    expect(await ids(T, '?search=97654123')).toEqual([submitted.student.id]);
    const code = (await list(T, '?name=kavya')).body.data[0].registration_id as string;
    expect(await ids(T, `?search=${code.toLowerCase()}`)).toEqual([submitted.student.id]);
    expect(await ids(T, '?search=%25')).toEqual([]);
    expect(await ids(T, '?search=_')).toEqual([]);
    /* With a middle name, also without it. */
    await pool.query(`UPDATE student_accounts SET middle_name = 'Suresh' WHERE id = $1`, [submitted.student.id]);
    expect(await ids(T, '?search=kavya%20suresh%20jad')).toEqual([submitted.student.id]);
    expect(await ids(T, '?search=kavya%20jad')).toEqual([submitted.student.id]);
    expect(await ids(T, '?name=kavya%20jad')).toEqual([submitted.student.id]);
    expect((await list(T, '?search=kavya')).body.data[0].name).toBe('Kavya Suresh Jadhav');
  });

  it('refuses wrong filters with the field that is wrong', async () => {
    const bad = await list(
      viewer.token,
      '?mobile=abc&district_id=x&caste_id=x&centre_id=x&documents=MAYBE&final=x&stage=x&application_stage=SUBMITTED&follow_up=x&approval=x&page=0&limit=101&sortBy=email',
    );
    expect(bad.status).toBe(422);
    expect(fieldsOf(bad)).toEqual(
      [
        'application_stage',
        'approval',
        'caste_id',
        'centre_id',
        'district_id',
        'documents',
        'final',
        'follow_up',
        'limit',
        'mobile',
        'page',
        'sortBy',
        'stage',
      ].map((f) => `query.${f}`),
    );
    expect(detailsOf(await list(viewer.token, '?mobile=98x'))).toEqual([
      { field: 'query.mobile', message: 'Mobile number must be digits' },
    ]);
    expect(fieldsOf(await list(viewer.token, `?search=${'x'.repeat(101)}`))).toEqual(['query.search']);
    expect(fieldsOf(await list(viewer.token, `?name=${'x'.repeat(101)}`))).toEqual(['query.name']);
    /* What the database would refuse is refused here, never a 500. */
    expect(fieldsOf(await list(viewer.token, '?search=a%00b&name=%00'))).toEqual(['query.name', 'query.search']);
    expect(fieldsOf(await list(viewer.token, '?page=1e300'))).toEqual(['query.page']);
    /* Unknown parameters are ignored. */
    expect((await list(viewer.token, '?colour=red')).status).toBe(200);
  });
});

describe('last activity', () => {
  it('is what the student did last: made the account, verified it, signed in or changed the form', async () => {
    await resetDatabase();
    const admin = await makePanelUser();
    const centre = await makeCentre();
    const { student, applicationId } = await makeApplication('SUBMITTED', { centre, by: admin });
    const at = async () => (await list(admin.token)).body.data[0].last_activity_at as string;
    const set = async (account: Record<string, string | null>, active: string) => {
      await pool.query(`UPDATE student_accounts SET created_at = $2, verified_at = $3, last_login_at = $4 WHERE id = $1`, [
        student.id,
        account.created,
        account.verified,
        account.login,
      ]);
      await pool.query(`UPDATE applications SET student_active_at = $2 WHERE id = $1`, [applicationId, active]);
    };
    const [d1, d2, d3, d4] = [1, 2, 3, 4].map((d) => `2026-06-0${d}T10:00:00.000Z`) as [string, string, string, string];
    await set({ created: d1, verified: d2, login: null }, d1);
    expect(await at()).toBe(d2);
    await set({ created: d1, verified: d2, login: d4 }, d3);
    expect(await at()).toBe(d4);
    await set({ created: d1, verified: d2, login: d3 }, d4);
    expect(await at()).toBe(d4);
    /* Not what the panel does. */
    await post(`/manage/applicants/${student.id}/follow-ups`, admin.token, { status: 'CALLED' });
    await post(`/manage/applicants/${student.id}/documents/PHOTO/verify`, admin.token, { verified: true });
    const edit = await put(`/manage/applicants/${student.id}/form`, admin.token, { data: { landmark: 'Near the temple' } });
    expect(edit.status).toBe(200);
    expect(await at()).toBe(d4);
  });
});

describe('GET /manage/applicants/:id', () => {
  let admin: TestPanelUser;
  let viewer: TestPanelUser;
  let centre: string;
  beforeEach(async () => {
    await resetDatabase();
    admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
    viewer = await makePanelUser('VIEWER');
    centre = await makeCentre({ name: 'Nashik Center' });
  });
  const view = (id: string, token = viewer.token) => get(`/manage/applicants/${id}`, token);

  it('shows a submitted student in full, the Aadhaar only masked', async () => {
    const s = await makeApplication('RETURNED', {
      centre,
      by: admin,
      batch: await makeBatch({ centre, by: admin, name: 'Batch A' }),
      account: { first_name: 'Kavya', last_name: 'Jadhav' },
      values: {
        disability_status: 'Yes',
        disability_type: 'Locomotor',
        disability_certificate_number: 'UDID1234',
        taluka: 'Haveli',
      },
    });
    const res = await view(s.student.id, admin.token);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual(
      [
        'account',
        'status',
        'steps',
        'registration',
        'aadhaar_masked',
        'form',
        'display',
        'view_fields',
        'documents',
        'documents_verified',
        'edits',
        'can_edit',
        'locked_fields',
        'returned',
        'approval',
        'history',
      ].sort(),
    );
    expect(d.account).toEqual({
      id: s.student.id,
      name: 'Kavya Jadhav',
      email: s.student.email,
      mobile_number: s.student.mobile,
      created_at: expect.any(String),
      email_verified_at: expect.any(String),
      last_login_at: null,
    });
    expect(d.status).toBe('SUBMITTED');
    expect(d.steps).toEqual({
      basic_completed_at: expect.any(String),
      main_completed_at: expect.any(String),
      submitted_at: expect.any(String),
    });
    expect(d.registration).toEqual({
      registration_id: expect.stringMatching(/^IPP-\d{6}$/),
      registration_number: expect.stringMatching(/^\d{16}$/),
    });
    expect(d.aadhaar_masked).toBe(`XXXX-XXXX-${s.aadhaar.slice(-4)}`);
    expect(JSON.stringify(d)).not.toContain(s.aadhaar);
    /* Every field of the form is there, also without a value; the email is the account's. */
    expect(Object.keys(d.form)).toHaveLength(36);
    expect(d.form).toMatchObject({
      aadhaar_number: '',
      email: s.student.email,
      disability_type: 'Locomotor',
      landmark: '',
      cgpa_scale: '',
    });
    expect(d.display).toMatchObject({
      caste: 'मराठा',
      course_centre: 'Nashik',
      education: 'BCA',
      centre: 'Nashik Center',
      district: 'Nashik',
      taluka: 'Haveli',
      religion: 'हिंदू',
      technology: 'Data Analytics & Business Intelligence',
      gender: 'Female',
      marital_status: 'Unmarried',
    });
    expect(d.view_fields).toHaveLength(36);
    const fields = new Map((d.view_fields as { key: string }[]).map((f) => [f.key, f]));
    expect(fields.get('caste_id')).toEqual({
      key: 'caste_id',
      step: 1,
      label_en: 'Caste',
      label_mr: 'जात',
      type: 'DROPDOWN',
      value: await optionId('CASTE', 'SAR01'),
      text: 'मराठा',
      custom: false,
    });
    expect(fields.get('aadhaar_number')).toMatchObject({ value: '', text: d.aadhaar_masked });
    expect(fields.get('date_of_birth')).toMatchObject({ value: '2003-04-15', text: '2003-04-15' });

    const codes = await activeDocuments();
    expect(d.documents.map((x: { code: string }) => x.code)).toEqual([
      ...codes.slice(0, 4),
      'APPLICANT_VIDEO',
      ...codes.slice(4),
    ]);
    expect(d.documents[0]).toEqual({
      code: 'PHOTO',
      name: 'Photo',
      name_mr: 'छायाचित्र',
      required: true,
      kind: 'DOCUMENT',
      file: {
        doc_type: 'PHOTO',
        name: 'Photo',
        original_name: 'photo.pdf',
        mime_type: 'application/pdf',
        size_bytes: expect.any(Number),
        uploaded_at: expect.any(String),
      },
      verified: { verified: true, at: expect.any(String), by: 'Program Auditor' },
    });
    expect(d.documents[4]).toMatchObject({
      code: 'APPLICANT_VIDEO',
      required: false,
      kind: 'VIDEO',
      file: null,
      verified: { verified: false, at: null, by: null },
    });
    expect(d.documents_verified).toEqual({ verified: true, at: expect.any(String), by: 'Program Auditor' });
    expect(d).toMatchObject({
      edits: [],
      can_edit: true,
      locked_fields: ['email', 'district_id'],
      approval: { stage: null, batch: { name: 'Batch A' }, last_event: { action: 'REJECT', reason: 'Photo is not clear' } },
    });
    expect(
      d.history.map((e: { action: string; from: { stage: string }; to: { stage: string }; by: string }) => [
        e.action,
        e.from.stage,
        e.to.stage,
        e.by,
      ]),
    ).toEqual([
      ['REJECT', 'DIVISION', 'AUDITOR', 'Test Officer'],
      ['APPROVE', 'BATCH', 'DIVISION', 'Program Auditor'],
      ['APPROVE', 'AUDITOR', 'BATCH', 'Program Auditor'],
    ]);
    expect((await view(s.student.id, viewer.token)).body.data.can_edit).toBe(false);
  });

  it('shows a draft, and an account that has no form yet', async () => {
    const draft = await makeApplication('BASIC_DONE', { centre });
    const d = (await view(draft.student.id)).body.data;
    expect(d).toMatchObject({
      status: 'DRAFT',
      registration: null,
      aadhaar_masked: `XXXX-XXXX-${draft.aadhaar.slice(-4)}`,
      approval: null,
      history: [],
      edits: [],
      can_edit: false,
      locked_fields: ['email'],
      documents_verified: { verified: false, at: null, by: null },
    });
    expect(d.form.father_name).toBe('Ramesh Testkar');
    expect(JSON.stringify(d)).not.toContain(draft.aadhaar);
    const account = await makeAccount();
    const empty = (await view(account.id, admin.token)).body.data;
    expect(empty).toMatchObject({
      status: 'DRAFT',
      steps: { basic_completed_at: null, main_completed_at: null, submitted_at: null },
      registration: null,
      aadhaar_masked: null,
      approval: null,
      history: [],
      edits: [],
      can_edit: false,
      locked_fields: ['email'],
      documents_verified: { verified: false, at: null, by: null },
    });
    expect(empty.form).toMatchObject({ first_name: '', email: account.email });
    expect(empty.documents).toHaveLength(10);
    expect(empty.documents.every((x: { file: null; verified: { verified: boolean } }) => !x.file && !x.verified.verified)).toBe(
      true,
    );
    /* Looking changes nothing: no form is made. */
    expect(await one(`SELECT 1 FROM applications WHERE account_id = $1`, [account.id])).toBe(null);
    expect(Object.keys(empty).sort()).toEqual(Object.keys(d).sort());
  });

  it('keeps showing choices, fields and documents that were switched off or deleted since', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin, values: { gender: 'Female', x_hobby: 'Chess' } });
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'GENDER' AND code = 'Female'`);
    await pool.query(
      `UPDATE program_options SET is_active = false, deleted_at = now() WHERE kind = 'TECHNOLOGY' AND code = 'T01'`,
    );
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'marital_status'`);
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'landmark'`);
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'PHOTO'`);
    await pool.query(`UPDATE centres SET is_active = false, deleted_at = now() WHERE id = $1`, [centre]);
    const d = (await view(s.student.id)).body.data;
    const fields = new Map((d.view_fields as { key: string; text: string }[]).map((f) => [f.key, f.text]));
    expect(fields.get('gender')).toBe('Female');
    expect(fields.get('technology')).toBe('Data Analytics & Business Intelligence');
    expect(fields.get('centre_id')).toBe('Nashik Center');
    /* A switched-off field only with a value; a value without a field only in the form. */
    expect(fields.get('marital_status')).toBe('Unmarried');
    expect(fields.has('landmark')).toBe(false);
    expect(fields.has('x_hobby')).toBe(false);
    expect(d.form.x_hobby).toBe('Chess');
    /* A document no longer asked for is last. */
    expect(d.documents.at(-1)).toMatchObject({
      code: 'PHOTO',
      file: { original_name: 'photo.pdf' },
      verified: { verified: true },
    });
  });

  it('answers 404 for an unknown, malformed or deleted student', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    await pool.query(`UPDATE student_accounts SET deleted_at = now() WHERE id = $1`, [s.student.id]);
    for (const id of [UNKNOWN_ID, 'abc', s.student.id]) {
      const res = await view(id);
      expect([id, res.status, res.body.message, res.body.error.code]).toEqual([id, 404, 'Student not found', 'NOT_FOUND']);
    }
    expect(await ids(viewer.token, '')).toEqual([]);
  });

  it('says at which stage it can be changed', async () => {
    const batch = await makeBatch({ centre, by: admin });
    for (const [state, can, locked] of [
      ['SUBMITTED', true, ['email']],
      ['BATCH', true, ['email']],
      ['DIVISION', true, ['email', 'district_id']],
      ['APPROVED', false, ['email', 'district_id']],
    ] as const) {
      const s = await makeApplication(state, { centre, by: admin, batch });
      const d = (await view(s.student.id, admin.token)).body.data;
      expect([state, d.can_edit, d.locked_fields]).toEqual([state, can, locked]);
    }
    const coep = await makeApplication('DIVISION', { centre, by: admin, batch });
    await setStage(coep.student.id, 'COEP');
    expect((await view(coep.student.id, admin.token)).body.data).toMatchObject({
      can_edit: true,
      approval: { stage: 'COEP', stage_label: 'With COEP' },
    });
  });
});

describe('follow-ups', () => {
  let admin: TestPanelUser;
  let student: { id: string };
  beforeEach(async () => {
    await resetDatabase();
    admin = await makePanelUser('ADMIN', { name: 'Follow Admin' });
    student = await makeAccount({ verified: false });
  });
  const url = (id = student.id) => `/manage/applicants/${id}/follow-ups`;

  it('are kept, newest first, and the newest is the current one', async () => {
    const first = await post(url(), admin.token, { status: 'CALLED', note: '  Did not pick up; call again tomorrow  ' });
    expect(first.status).toBe(201);
    expect(first.body.message).toBe('Follow-up saved');
    expect(first.body.data).toEqual([
      {
        status: 'CALLED',
        status_label: 'Follow-up call',
        note: 'Did not pick up; call again tomorrow',
        at: expect.any(String),
        by: 'Follow Admin',
      },
    ]);
    const second = await post(url(), admin.token, { status: 'SECOND_CALL' });
    expect(second.body.data.map((f: { status: string; note: string | null }) => [f.status, f.note])).toEqual([
      ['SECOND_CALL', null],
      ['CALLED', 'Did not pick up; call again tomorrow'],
    ]);
    expect((await get(url(), admin.token)).body.data).toEqual(second.body.data);
    expect((await list(admin.token)).body.data[0].follow_up).toEqual(second.body.data[0]);
    /* Recorded without the note. */
    const [event] = await audits('edp.follow_up.create');
    expect(event).toMatchObject({
      resource: 'student_account',
      resource_id: student.id,
      actor_id: admin.id,
      details: { status: 'CALLED', hasNote: true },
    });
    expect(JSON.stringify(event)).not.toContain('pick up');
  });

  it('check the status and the note', async () => {
    expect(detailsOf(await post(url(), admin.token, { status: 'MAYBE', note: 'x'.repeat(1001) }))).toEqual([
      { field: 'body.status', message: 'Choose a follow-up status' },
      { field: 'body.note', message: 'Note must be at most 1000 characters' },
    ]);
    expect(detailsOf(await post(url(), admin.token, {}))).toEqual([
      { field: 'body.status', message: 'Choose a follow-up status' },
    ]);
    expect(detailsOf(await post(url(), admin.token, { status: 'CALLED', note: 'a\u0000b' }))).toEqual([
      { field: 'body.note', message: 'Note contains characters that cannot be saved' },
    ]);
    expect(detailsOf(await post(url(), admin.token, { status: 'CALLED', by: 'me' }))).toEqual([
      { field: 'body.by', message: 'Unknown field' },
    ]);
    const lines = await post(url(), admin.token, { status: 'CALLED', note: 'line one\nline two' });
    expect(lines.body.data[0].note).toBe('line one\nline two');
    const blank = await post(url(), admin.token, { status: 'PENDING', note: '   ' });
    expect(blank.body.data[0]).toMatchObject({ status: 'PENDING', note: null });
    expect((await post(url(), admin.token, { status: 'FORM_FILLED', note: 'x'.repeat(1000) })).status).toBe(201);
  });

  it('answer 404 for an unknown, malformed or deleted student', async () => {
    await pool.query(`UPDATE student_accounts SET deleted_at = now() WHERE id = $1`, [student.id]);
    for (const id of [UNKNOWN_ID, 'abc', student.id]) {
      for (const res of [await get(url(id), admin.token), await post(url(id), admin.token, { status: 'PENDING' })]) {
        expect([id, res.status, res.body.message]).toEqual([id, 404, 'Student not found']);
      }
    }
    expect(await audits('edp.follow_up.create')).toEqual([]);
  });

  it('stay when the one who recorded them is gone', async () => {
    const gone = await makePanelUser('ADMIN');
    await post(url(), gone.token, { status: 'FORM_FILLED', note: 'Done' });
    await pool.query(`UPDATE panel_users SET deleted_at = now(), is_active = false WHERE id = $1`, [gone.id]);
    expect((await get(url(), admin.token)).body.data).toEqual([
      expect.objectContaining({ status: 'FORM_FILLED', note: 'Done', by: gone.name }),
    ]);
  });
});
