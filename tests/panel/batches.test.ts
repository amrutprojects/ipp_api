import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
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
import {
  applicationRow,
  audits,
  detailsOf,
  eventsOf,
  fieldsOf,
  get,
  patch,
  post,
  put,
  setBatchSize,
  setStage,
  UNKNOWN_ID,
} from './helpers';

let admin: TestPanelUser;
let viewer: TestPanelUser;
let centre: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  viewer = await makePanelUser('VIEWER');
  centre = await makeCentre({ name: 'Nashik Center', code: 'NC-1' });
});
afterAll(closeDatabase);

let n = 0;
const create = (ids: string[], over: object = {}, token = admin.token) =>
  post('/manage/batches', token, { name: `New batch ${++n}`, centre_id: centre, ids, ...over });
const change = (id: string, body: object, token = admin.token) => patch(`/manage/batches/${id}`, token, body);
const waiting = (o: Partial<Parameters<typeof makeApplication>[1]> = {}) => makeApplication('BATCH', { centre, by: admin, ...o });
const idsOf = (list: TestApplication[]) => list.map((a) => a.student.id);
const refusal = (res: Awaited<ReturnType<typeof create>>) => [res.status, res.body.message];
const batches = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM batches`))!.n;

const BATCH_KEYS = [
  'id',
  'code',
  'name',
  'centre',
  'district',
  'students',
  'size',
  'stages',
  'rejected',
  'other_centre',
  'start_date',
  'end_date',
  'delivery_mode',
  'technology',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
].sort();

describe('POST /manage/batches', () => {
  it('makes a batch of exactly the batch size and sends its students to the Divisional Officer', async () => {
    await setBatchSize(2);
    const other = await makeCentre({ name: 'Other Center' });
    const a = await waiting({ account: { first_name: 'Zoya', last_name: 'Adhav' } });
    const b = await waiting({
      account: { first_name: 'Anita', last_name: 'Bhosale' },
      values: { centre_id: other, technology: 'T08' },
    });
    const res = await create(idsOf([a, b]), {
      name: '  Nashik Batch 1 ',
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      delivery_mode: 'BLENDED',
      technology: 'T01',
    });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Batch created and sent to the Divisional Officer');
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual([...BATCH_KEYS, 'members'].sort());
    expect(d).toMatchObject({
      id: expect.any(String),
      code: 'IPP-B-0001',
      name: 'Nashik Batch 1',
      centre: { id: centre, name: 'Nashik Center', code: 'NC-1' },
      district: { id: await districtId(), name: 'Nashik' },
      students: 2,
      size: 2,
      stages: { AUDITOR: 0, DIVISION: 2, COEP: 0, HEAD_OFFICE: 0, ADMIN: 0, APPROVED: 0 },
      rejected: 0,
      other_centre: 1,
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      delivery_mode: 'BLENDED',
      technology: { code: 'T01', name: 'Data Analytics & Business Intelligence' },
      created_at: expect.any(String),
      created_by: 'Program Auditor',
      updated_at: expect.any(String),
      updated_by: 'Program Auditor',
    });
    /* By name. */
    expect(d.members.map((m: { name: string }) => m.name)).toEqual(['Anita Bhosale', 'Zoya Adhav']);
    expect(d.members[0]).toEqual({
      id: b.student.id,
      name: 'Anita Bhosale',
      email: b.student.email,
      mobile_number: b.student.mobile,
      registration_id: expect.stringMatching(/^IPP-\d{6}$/),
      register_id: null,
      district: 'Nashik',
      district_id: await districtId(),
      category: 'मराठा',
      centre: 'Other Center',
      centre_id: other,
      technology: 'AI/ML Engineer',
      documents_verified: true,
      final_verified: false,
      approval: {
        stage: 'DIVISION',
        stage_label: 'With Divisional Officer',
        stage_updated_at: expect.any(String),
        approved_at: expect.any(String),
        approved_by: 'Program Auditor',
        last_event: {
          action: 'APPROVE',
          from: { stage: 'BATCH', name: 'Batch' },
          to: { stage: 'DIVISION', name: 'Divisional Officer' },
          reason: null,
          by: 'Program Auditor',
          at: expect.any(String),
        },
        register_id: null,
        batch: { id: d.id, name: 'Nashik Batch 1' },
      },
    });
    expect((await get(`/manage/batches/${d.id}`, viewer.token)).body.data).toEqual(d);
    for (const s of [a, b]) {
      expect(await applicationRow(s.student.id)).toMatchObject({ approval_stage: 'DIVISION', batch_id: d.id });
      expect((await eventsOf(s.student.id)).map((e) => [e.action, e.from_stage, e.to_stage, e.panel_user_id])).toEqual([
        ['APPROVE', 'AUDITOR', 'BATCH', admin.id],
        ['APPROVE', 'BATCH', 'DIVISION', admin.id],
      ]);
    }
    const [event] = await audits('edp.batch.create');
    expect(event).toMatchObject({
      resource: 'batch',
      resource_id: d.id,
      actor_id: admin.id,
      details: { students: 2, centreId: centre },
    });
    expect(JSON.stringify(event)).not.toMatch(/Anita|Zoya/);
  });

  it('needs no dates, mode or technology: offline, the rest empty; codes go up by one', async () => {
    await setBatchSize(1);
    const first = await create(idsOf([await waiting()]));
    expect(first.body.data).toMatchObject({
      code: 'IPP-B-0001',
      start_date: null,
      end_date: null,
      delivery_mode: 'OFFLINE',
      technology: null,
      other_centre: 0,
    });
    /* A refused batch uses up no code. */
    expect((await create([UNKNOWN_ID])).status).toBe(409);
    expect((await create(idsOf([await waiting()]), { name: first.body.data.name })).status).toBe(409);
    const empty = await create(idsOf([await waiting()]), {
      start_date: null,
      end_date: '',
      delivery_mode: null,
      technology: null,
    });
    expect(empty.status).toBe(201);
    expect(empty.body.data).toMatchObject({ code: 'IPP-B-0002', delivery_mode: 'OFFLINE', start_date: null, end_date: null });
    const oneDate = await create(idsOf([await waiting()]), { end_date: '2026-08-31' });
    expect(oneDate.body.data).toMatchObject({ code: 'IPP-B-0003', start_date: null, end_date: '2026-08-31' });
  });

  it('takes exactly the size that is set now, and keeps it', async () => {
    const s = [await waiting(), await waiting(), await waiting()];
    /* Never saved: 30. */
    expect(detailsOf(await create(idsOf(s)))).toEqual([
      {
        field: 'body.ids',
        message: 'A batch must have exactly 30 students (Settings → Batch size); 3 selected.',
      },
    ]);
    await setBatchSize(2);
    expect(detailsOf(await create(idsOf(s)))).toEqual([
      { field: 'body.ids', message: 'A batch must have exactly 2 students (Settings → Batch size); 3 selected.' },
    ]);
    const made = await create(idsOf(s.slice(0, 2)));
    expect(made.status).toBe(201);
    await setBatchSize(1);
    expect((await get(`/manage/batches/${made.body.data.id}`, admin.token)).body.data.size).toBe(2);
    expect(detailsOf(await create(idsOf([s[2]!, await waiting()])))).toEqual([
      { field: 'body.ids', message: 'A batch must have exactly 1 student (Settings → Batch size); 2 selected.' },
    ]);
    expect((await create(idsOf([s[2]!]))).body.data.size).toBe(1);
  });

  it('checks what is sent, every problem at once', async () => {
    expect(detailsOf(await post('/manage/batches', admin.token, {}))).toEqual([
      { field: 'body.name', message: 'Batch name is required' },
      { field: 'body.centre_id', message: 'Centre is required' },
      { field: 'body.ids', message: 'Select at least one student' },
    ]);
    const bad = await create([], {
      name: ' x ',
      centre_id: 'abc',
      start_date: '2026-02-30',
      end_date: '31/08/2026',
      delivery_mode: 'EVENING',
      technology: 5,
      members: [],
    });
    expect(bad.status).toBe(422);
    expect(detailsOf(bad)).toEqual([
      { field: 'body.name', message: 'Batch name must be at least 2 characters' },
      { field: 'body.centre_id', message: 'Centre is not valid' },
      { field: 'body.ids', message: 'Select at least one student' },
      { field: 'body.start_date', message: 'Enter a valid start date' },
      { field: 'body.end_date', message: 'Enter a valid end date' },
      { field: 'body.delivery_mode', message: 'Select a valid delivery mode' },
      { field: 'body.technology', message: 'Select a valid technology' },
      { field: 'body.members', message: 'Unknown field' },
    ]);
    const id = UNKNOWN_ID;
    expect(detailsOf(await create([id, id]))).toEqual([{ field: 'body.ids', message: 'Each student may be listed only once' }]);
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(detailsOf(await create(many))).toEqual([{ field: 'body.ids', message: 'At most 100 students at a time' }]);
    expect(detailsOf(await create([id], { name: 'x'.repeat(121) }))).toEqual([
      { field: 'body.name', message: 'Batch name must be at most 120 characters' },
    ]);
    expect(detailsOf(await create([id], { name: 'Batch \u0000' }))).toEqual([
      { field: 'body.name', message: 'Batch name contains characters that cannot be saved' },
    ]);
    expect(detailsOf(await create([id], { technology: '\u0000' }))).toEqual([
      { field: 'body.technology', message: 'Select a valid technology' },
    ]);
    expect(await batches()).toBe(0);
  });

  it('needs an end after the start', async () => {
    await setBatchSize(1);
    const ids = idsOf([await waiting()]);
    for (const end_date of ['2026-06-01', '2026-05-31'])
      expect(detailsOf(await create(ids, { start_date: '2026-06-01', end_date }))).toEqual([
        { field: 'body.end_date', message: 'End date must be after the start date' },
      ]);
    expect((await create(ids, { start_date: '2026-06-01', end_date: '2026-06-02' })).status).toBe(201);
  });

  it('needs an active technology, by its code', async () => {
    await setBatchSize(1);
    const ids = idsOf([await waiting()]);
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'TECHNOLOGY' AND code = 'T02'`);
    await pool.query(
      `UPDATE program_options SET is_active = false, deleted_at = now() WHERE kind = 'TECHNOLOGY' AND code = 'T03'`,
    );
    for (const technology of ['T02', 'T03', 'T99', 'Male', await optionId('TECHNOLOGY', 'T01')])
      expect(detailsOf(await create(ids, { technology }))).toEqual([
        { field: 'body.technology', message: 'Select a valid technology' },
      ]);
    expect((await create(ids, { technology: 'T01' })).status).toBe(201);
  });

  it('needs an active center; its district does not matter', async () => {
    await setBatchSize(1);
    const ids = idsOf([await waiting()]);
    const off = await makeCentre({ active: false });
    const gone = await makeCentre();
    await pool.query(`UPDATE centres SET is_active = false, deleted_at = now() WHERE id = $1`, [gone]);
    for (const centre_id of [UNKNOWN_ID, gone])
      expect(detailsOf(await create(ids, { centre_id }))).toEqual([{ field: 'body.centre_id', message: 'Centre not found' }]);
    expect(detailsOf(await create(ids, { centre_id: off }))).toEqual([
      { field: 'body.centre_id', message: 'This centre is inactive. Choose an active centre.' },
    ]);
    const pune = await makeCentre({ district: 'PUN' });
    expect((await create(ids, { centre_id: pune })).body.data).toMatchObject({
      district: { name: 'Nashik' },
      centre: { id: pune },
      other_centre: 1,
    });
  });

  it('is of one district', async () => {
    await setBatchSize(2);
    const nashik = await waiting();
    const pune = await waiting({ values: { district_id: await districtId('PUN') } });
    expect(detailsOf(await create(idsOf([nashik, pune])))).toEqual([
      { field: 'body.ids', message: 'All students of a batch must be from one district. Selected: Nashik, Pune.' },
    ]);
    const none = await waiting();
    await pool.query(`UPDATE applications SET data = data - 'district_id' WHERE id = $1`, [none.applicationId]);
    expect(detailsOf(await create(idsOf([nashik, none])))).toEqual([
      { field: 'body.ids', message: 'All students of a batch must be from one district. Selected: Nashik, no district.' },
    ]);
    await setBatchSize(1);
    expect(detailsOf(await create(idsOf([none])))).toEqual([
      { field: 'body.ids', message: 'All students of a batch must be from one district. Selected: no district.' },
    ]);
    expect(await batches()).toBe(0);
  });

  it('has a name of its own', async () => {
    await setBatchSize(1);
    expect((await create(idsOf([await waiting()]), { name: 'Nashik Batch 1' })).status).toBe(201);
    const ids = idsOf([await waiting()]);
    const twice = await create(ids, { name: ' NASHIK batch 1' });
    expect(refusal(twice)).toEqual([409, 'A batch with this name already exists. Choose another name.']);
    expect(twice.body.error).toMatchObject({
      code: 'CONFLICT',
      details: [{ field: 'body.name', message: 'A batch with this name already exists. Choose another name.' }],
    });
    /* A deleted one's name is free again. */
    await pool.query(`UPDATE batches SET deleted_at = now()`);
    expect((await create(ids, { name: 'Nashik Batch 1' })).status).toBe(201);
  });

  it('takes only approved forms that wait for a batch', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const o = { centre, by: admin, batch };
    const ok = await waiting();
    const message = (people: string) =>
      `${people} of the selected cannot be added: only approved forms waiting for a batch can be.`;
    await setBatchSize(2);
    for (const state of ['MAIN_DONE', 'SUBMITTED', 'VERIFIED_DOCS', 'DIVISION', 'RETURNED', 'APPROVED'] as const) {
      const s = await makeApplication(state, o);
      expect([state, refusal(await create(idsOf([ok, s])))]).toEqual([state, [409, message('1 student')]]);
    }
    expect(refusal(await create([ok.student.id, UNKNOWN_ID]))).toEqual([409, message('1 student')]);
    expect(refusal(await create([(await makeAccount()).id, UNKNOWN_ID]))).toEqual([409, message('2 students')]);
    const deleted = await waiting();
    await pool.query(`UPDATE student_accounts SET deleted_at = now() WHERE id = $1`, [deleted.student.id]);
    expect(refusal(await create(idsOf([ok, deleted])))).toEqual([409, message('1 student')]);
    /* Nothing was saved by any of them. */
    expect(await batches()).toBe(1);
    expect(await applicationRow(ok.student.id)).toMatchObject({ approval_stage: 'BATCH', batch_id: null });
    expect(await eventsOf(ok.student.id)).toHaveLength(1);
  });

  it('takes only forms whose every document is verified now', async () => {
    await setBatchSize(3);
    const s = [await waiting(), await waiting(), await waiting()];
    const undo = (a: TestApplication, verified: boolean) =>
      post(`/manage/applicants/${a.student.id}/documents/PHOTO/verify`, admin.token, { verified });
    expect((await undo(s[0]!, false)).status).toBe(200);
    expect(refusal(await create(idsOf(s)))).toEqual([
      409,
      '1 student of the selected cannot be added: every document must be verified first.',
    ]);
    expect((await undo(s[1]!, false)).status).toBe(200);
    expect(refusal(await create(idsOf(s)))).toEqual([
      409,
      '2 students of the selected cannot be added: every document must be verified first.',
    ]);
    expect(await batches()).toBe(0);
    for (const a of s.slice(0, 2)) await undo(a, true);
    expect((await create(idsOf(s))).status).toBe(201);
  });

  it('has its checks in one order: size, center, technology, district, name, students, documents', async () => {
    await setBatchSize(2);
    await makeBatch({ centre, by: admin, name: 'Taken' });
    const pune = await waiting({ values: { district_id: await districtId('PUN') } });
    const draft = await makeApplication('MAIN_DONE', { centre });
    const unverified = await waiting();
    await pool.query(`DELETE FROM document_checks WHERE application_id = $1 AND document_code = 'PHOTO'`, [
      unverified.applicationId,
    ]);
    const wrong = { name: 'Taken', centre_id: UNKNOWN_ID, technology: 'T99' };
    expect(fieldsOf(await create(idsOf([pune]), wrong))).toEqual(['body.ids']);
    expect(fieldsOf(await create(idsOf([pune, draft]), wrong))).toEqual(['body.centre_id']);
    expect(fieldsOf(await create(idsOf([pune, draft]), { ...wrong, centre_id: centre }))).toEqual(['body.technology']);
    expect(fieldsOf(await create(idsOf([pune, draft]), { name: 'Taken' }))).toEqual(['body.ids']);
    expect(fieldsOf(await create(idsOf([unverified, draft]), { name: 'Taken' }))).toEqual(['body.name']);
    expect(refusal(await create(idsOf([unverified, draft])))[1]).toMatch(/waiting for a batch/);
    expect(refusal(await create(idsOf([unverified, await waiting()])))[1]).toMatch(/every document/);
  });

  it('puts a student into one batch only, whatever is asked for at the same moment', async () => {
    await setBatchSize(2);
    for (let round = 0; round < 3; round++) {
      const [a, b, c] = [await waiting(), await waiting(), await waiting()] as const;
      const both = await Promise.all([create(idsOf([a, b])), create(idsOf([c, b]))]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      const won = both.find((r) => r.status === 201)!.body.data;
      expect(won.students).toBe(2);
      expect(await applicationRow(b.student.id)).toMatchObject({ batch_id: won.id, approval_stage: 'DIVISION' });
      expect(await eventsOf(b.student.id)).toHaveLength(2);
      const left = [a, c].find((s) => !won.members.some((m: { id: string }) => m.id === s.student.id))!;
      expect(await applicationRow(left.student.id)).toMatchObject({ batch_id: null, approval_stage: 'BATCH' });
    }
    expect(await batches()).toBe(3);
  });

  it('gives a name to one batch only, whatever is asked for at the same moment', async () => {
    await setBatchSize(1);
    const [a, b] = [await waiting(), await waiting()];
    const both = await Promise.all([create(idsOf([a]), { name: 'Same' }), create(idsOf([b]), { name: 'same' })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(fieldsOf(both.find((r) => r.status === 409)!)).toEqual(['body.name']);
    expect(await batches()).toBe(1);
  });

  it('never differs from the district of its students, also when one is edited at the same moment', async () => {
    await setBatchSize(1);
    const pune = await districtId('PUN');
    for (let round = 0; round < 4; round++) {
      const s = await waiting();
      const [made, edited] = await Promise.all([
        create(idsOf([s])),
        put(`/manage/applicants/${s.student.id}/form`, admin.token, { data: { district_id: pune } }),
      ]);
      expect(made.status).toBe(201);
      expect([200, 422]).toContain(edited.status);
      const p = await applicationRow(s.student.id);
      expect(p.district_id).toBe(made.body.data.district.id);
      /* Edited first: the batch is of the new district. Batched first: the district is fixed. */
      expect(made.body.data.district.name).toBe(edited.status === 200 ? 'Pune' : 'Nashik');
    }
  });

  it('never holds a student whose document is taken back at the same moment before it is made', async () => {
    await setBatchSize(1);
    for (let round = 0; round < 4; round++) {
      const s = await waiting();
      const [made, undone] = await Promise.all([
        create(idsOf([s])),
        post(`/manage/applicants/${s.student.id}/documents/PHOTO/verify`, admin.token, { verified: false }),
      ]);
      expect(undone.status).toBe(200);
      if (made.status === 201) expect(await applicationRow(s.student.id)).toMatchObject({ approval_stage: 'DIVISION' });
      else {
        expect(refusal(made)).toEqual([409, '1 student of the selected cannot be added: every document must be verified first.']);
        expect(await applicationRow(s.student.id)).toMatchObject({ approval_stage: 'BATCH', batch_id: null });
      }
    }
  });
});

describe('GET /manage/batches', () => {
  it('lists the batches, newest first, with where their students are', async () => {
    const pune = await makeCentre({ name: 'Pune Center', code: 'PC-9', district: 'PUN' });
    const older = await makeBatch({ centre, by: admin, name: 'Zeta', size: 4 });
    const newer = await makeBatch({ centre: pune, by: admin, name: 'Alpha', district: 'PUN', size: 1 });
    const o = { centre, by: admin, batch: older };
    const [, coep] = [await makeApplication('DIVISION', o), await makeApplication('DIVISION', o)];
    await setStage(coep.student.id, 'COEP');
    await makeApplication('RETURNED', o);
    await makeApplication('APPROVED', o);
    await makeApplication('DIVISION', { ...o, batch: newer });
    const res = await get('/manage/batches', viewer.token);
    expect(res.status).toBe(200);
    /* The size new batches have now. */
    expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 2, totalPages: 1, size: 30 });
    expect(res.body.data.map((b: { id: string }) => b.id)).toEqual([newer, older]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(BATCH_KEYS);
    expect(res.body.data[1]).toMatchObject({
      name: 'Zeta',
      code: 'IPP-B-0001',
      students: 4,
      size: 4,
      stages: { AUDITOR: 1, DIVISION: 1, COEP: 1, HEAD_OFFICE: 0, ADMIN: 0, APPROVED: 1 },
      rejected: 1,
      other_centre: 0,
    });
    expect(res.body.data[0]).toMatchObject({ students: 1, rejected: 0, other_centre: 1, district: { name: 'Pune' } });

    const found = async (q: string) =>
      ((await get(`/manage/batches?${q}`, viewer.token)).body.data as { name: string }[]).map((b) => b.name);
    expect(await found('search=alp')).toEqual(['Alpha']);
    expect(await found('search=ipp-b-0001')).toEqual(['Zeta']);
    expect(await found('search=nashik%20center')).toEqual(['Zeta']);
    expect(await found('search=pc-9')).toEqual(['Alpha']);
    expect(await found('search=pune')).toEqual(['Alpha']);
    expect(await found('search=%25')).toEqual([]);
    expect(await found('search=&page=&limit=')).toEqual(['Alpha', 'Zeta']);
    expect(await found('sortBy=name&sortOrder=ASC')).toEqual(['Alpha', 'Zeta']);
    expect(await found('sortBy=name&sortOrder=DESC')).toEqual(['Zeta', 'Alpha']);
    expect(await found('sortBy=createdAt&sortOrder=ASC')).toEqual(['Zeta', 'Alpha']);
    const paged = await get('/manage/batches?page=2&limit=1', viewer.token);
    expect(paged.body).toMatchObject({ data: [{ name: 'Zeta' }], meta: { page: 2, limit: 1, total: 2, totalPages: 2 } });
    expect((await get('/manage/batches?page=9', viewer.token)).body).toMatchObject({
      data: [],
      meta: { total: 2, totalPages: 1 },
    });
    expect(fieldsOf(await get(`/manage/batches?limit=101&sortBy=size&search=${'x'.repeat(101)}`, viewer.token))).toEqual([
      'query.limit',
      'query.search',
      'query.sortBy',
    ]);
    await pool.query(`UPDATE batches SET deleted_at = now() WHERE id = $1`, [newer]);
    expect(await found('')).toEqual(['Zeta']);
    await setBatchSize(12);
    expect((await get('/manage/batches', viewer.token)).body.meta.size).toBe(12);
  });

  it('answers 404 for an unknown, malformed or deleted batch', async () => {
    const id = await makeBatch({ centre, by: admin });
    await pool.query(`UPDATE batches SET deleted_at = now() WHERE id = $1`, [id]);
    for (const x of [UNKNOWN_ID, 'abc', id])
      for (const res of [await get(`/manage/batches/${x}`, viewer.token), await change(x, { name: 'New name' })])
        expect([x, res.status, res.body.message]).toEqual([x, 404, 'Batch not found']);
  });

  it('shows members whose technology or center was switched off since, and a final one with its record', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const s = await makeApplication('APPROVED', { centre, by: admin, batch, values: { technology: 'T11' } });
    await pool.query(
      `UPDATE program_options SET is_active = false, deleted_at = now() WHERE kind = 'TECHNOLOGY' AND code = 'T11'`,
    );
    await pool.query(`UPDATE centres SET is_active = false WHERE id = $1`, [centre]);
    const d = (await get(`/manage/batches/${batch}`, viewer.token)).body.data;
    expect(d.members).toHaveLength(1);
    expect(d.members[0]).toMatchObject({
      id: s.student.id,
      technology: 'Blockchain',
      centre: 'Nashik Center',
      final_verified: true,
      register_id: d.members[0].registration_id,
      approval: { stage: 'APPROVED' },
    });
    await pool.query(`UPDATE applications SET data = data - 'technology'`);
    expect((await get(`/manage/batches/${batch}`, viewer.token)).body.data.members[0].technology).toBe(null);
  });
});

describe('PATCH /manage/batches/:id', () => {
  let id: string;
  beforeEach(async () => {
    id = await makeBatch({ centre, by: admin, name: 'Pune Batch 1' });
    await makeApplication('DIVISION', { centre, by: admin, batch: id });
  });

  it('changes the name, center, dates, mode and technology, at any stage; the students are fixed', async () => {
    const second = await makePanelUser('ADMIN', { name: 'Second Auditor' });
    const other = await makeCentre({ name: 'Other Center' });
    const res = await change(
      id,
      {
        name: ' Pune Batch A ',
        centre_id: other,
        start_date: '2026-06-01',
        end_date: '2026-08-31',
        delivery_mode: 'ONLINE',
        technology: 'T05',
      },
      second.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Batch saved');
    expect(res.body.data).toMatchObject({
      id,
      code: 'IPP-B-0001',
      name: 'Pune Batch A',
      centre: { id: other, name: 'Other Center' },
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      delivery_mode: 'ONLINE',
      technology: { code: 'T05', name: 'IT Infrastructure & Smart Technologies' },
      students: 1,
      other_centre: 1,
      created_by: 'Program Auditor',
      updated_by: 'Second Auditor',
    });
    expect(res.body.data.members).toHaveLength(1);
    const [event] = await audits('edp.batch.update');
    expect(event).toMatchObject({
      resource: 'batch',
      resource_id: id,
      actor_id: second.id,
      details: { fields: ['name', 'centre_id', 'start_date', 'end_date', 'delivery_mode', 'technology_id'] },
    });
    /* Also after the final approval. */
    await pool.query(`UPDATE applications SET approval_stage = 'APPROVED'`);
    expect((await change(id, { name: 'Pune Batch B' })).status).toBe(200);
    expect(detailsOf(await change(id, { add_ids: [UNKNOWN_ID] }))[0]).toEqual({
      field: 'body.add_ids',
      message: 'Unknown field',
    });
    for (const key of ['ids', 'size', 'code', 'district_id'])
      expect(fieldsOf(await change(id, { name: 'X1', [key]: '1' }))).toEqual([`body.${key}`]);
  });

  it('changes only what is given: null clears the dates and the technology, never the mode', async () => {
    const all = { start_date: '2026-06-01', end_date: '2026-08-31', delivery_mode: 'BLENDED', technology: 'T05' };
    expect((await change(id, all)).status).toBe(200);
    const named = await change(id, { name: 'Renamed' });
    expect(named.body.data).toMatchObject({ ...all, technology: { code: 'T05' }, name: 'Renamed' });
    const mode = await change(id, { name: 'Renamed again', delivery_mode: null });
    expect(mode.body.data.delivery_mode).toBe('BLENDED');
    const noStart = await change(id, { start_date: null });
    expect(noStart.body.data).toMatchObject({ start_date: null, end_date: '2026-08-31' });
    const cleared = await change(id, { end_date: null, technology: null });
    expect(cleared.body.data).toMatchObject({ start_date: null, end_date: null, technology: null, delivery_mode: 'BLENDED' });
  });

  it('refuses nothing to change, and records nothing when everything stays as it is', async () => {
    for (const body of [{}, { delivery_mode: null }])
      expect(detailsOf(await change(id, body))).toEqual([{ field: 'body', message: 'Nothing to change' }]);
    const before = (await get(`/manage/batches/${id}`, admin.token)).body.data;
    const second = await makePanelUser('ADMIN');
    const same = await change(
      id,
      { name: 'Pune Batch 1', centre_id: centre.toUpperCase(), start_date: null, delivery_mode: 'OFFLINE', technology: null },
      second.token,
    );
    expect(same.status).toBe(200);
    expect(same.body.data).toEqual(before);
    expect(await audits('edp.batch.update')).toEqual([]);
  });

  it('checks the dates against the ones it has', async () => {
    const late = 'End date must be after the start date';
    expect((await change(id, { start_date: '2026-06-01' })).status).toBe(200);
    for (const end_date of ['2026-06-01', '2026-05-01'])
      expect(detailsOf(await change(id, { end_date }))).toEqual([{ field: 'body.end_date', message: late }]);
    expect((await change(id, { end_date: '2026-06-30' })).status).toBe(200);
    expect(detailsOf(await change(id, { start_date: '2026-06-30' }))).toEqual([{ field: 'body.end_date', message: late }]);
    expect((await change(id, { start_date: '2026-07-01', end_date: '2026-07-31' })).status).toBe(200);
    expect((await change(id, { start_date: '2026-09-01', end_date: null })).status).toBe(200);
    expect(detailsOf(await change(id, { start_date: '2026-13-01', end_date: 'soon' }))).toEqual([
      { field: 'body.start_date', message: 'Enter a valid start date' },
      { field: 'body.end_date', message: 'Enter a valid end date' },
    ]);
  });

  it('keeps a center or technology switched off since while it is unchanged, and takes only active ones', async () => {
    expect((await change(id, { technology: 'T05' })).status).toBe(200);
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'TECHNOLOGY' AND code IN ('T05', 'T06')`);
    await pool.query(`UPDATE centres SET is_active = false WHERE id = $1`, [centre]);
    const kept = await change(id, { name: 'Renamed', technology: 'T05', centre_id: centre });
    expect(kept.status).toBe(200);
    expect(kept.body.data).toMatchObject({ name: 'Renamed', technology: { code: 'T05' }, centre: { id: centre } });
    expect(detailsOf(await change(id, { technology: 'T06' }))).toEqual([
      { field: 'body.technology', message: 'Select a valid technology' },
    ]);
    const off = await makeCentre({ active: false });
    expect(detailsOf(await change(id, { centre_id: off }))).toEqual([
      { field: 'body.centre_id', message: 'This centre is inactive. Choose an active centre.' },
    ]);
    expect(detailsOf(await change(id, { centre_id: UNKNOWN_ID }))).toEqual([
      { field: 'body.centre_id', message: 'Centre not found' },
    ]);
    /* Once changed, the one switched off is no longer there to go back to. */
    expect((await change(id, { technology: 'T01' })).status).toBe(200);
    expect(fieldsOf(await change(id, { technology: 'T05' }))).toEqual(['body.technology']);
  });

  it('refuses the name of another batch; its own in another case is fine', async () => {
    await makeBatch({ centre, by: admin, name: 'Nashik Batch' });
    const res = await change(id, { name: 'NASHIK BATCH' });
    expect(refusal(res)).toEqual([409, 'A batch with this name already exists. Choose another name.']);
    expect(fieldsOf(res)).toEqual(['body.name']);
    expect((await change(id, { name: 'PUNE batch 1' })).body.data.name).toBe('PUNE batch 1');
    expect(fieldsOf(await change(id, { name: 'x' }))).toEqual(['body.name']);
    const second = await makeBatch({ centre, by: admin, name: 'Third' });
    const both = await Promise.all([change(id, { name: 'Same' }), change(second, { name: 'same' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rows(`SELECT lower(name) AS name FROM batches WHERE lower(name) = 'same'`)).toHaveLength(1);
  });
});
