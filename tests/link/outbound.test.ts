import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { one, pool, rows, transaction } from '../../src/db/pool';
import { linkProblems } from '../../src/config/link';
import { enqueueApplications, enqueueBatch, enqueueMissingBatches } from '../../src/program/link/outbox';
import { createLinkWorker, waitAfter } from '../../src/program/link/worker';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  FILES,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  optionId,
  request,
  type TestApplication,
  type TestPanelUser,
} from '../helpers/factory';
import { fakeSarthi, linkOff, linkOn, linkStop, SECRET, type FakeSarthi } from '../helpers/sarthi';
import { get, patch, post, put, setBatchSize } from '../panel/helpers';

/* The messages to Sarthi: what makes one, what it says, and how it is sent. */
let admin: TestPanelUser;
let centre: string;
let sarthi: FakeSarthi;
let clock: Date;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  centre = await makeCentre({ name: 'Nashik Center', code: 'NC-1' });
  sarthi = await fakeSarthi();
  clock = new Date(Date.now() + 1000);
});
afterEach(async () => {
  await linkStop();
  await sarthi.close();
});
afterAll(closeDatabase);

const worker = () => createLinkWorker({ fetch, now: () => clock });
/* One run of the worker, with the link on. */
async function deliver() {
  /* The clock of the worker is never behind the database's. */
  if (clock.getTime() < Date.now() + 1000) clock = new Date(Date.now() + 1000);
  linkOn(sarthi.url);
  try {
    return await worker().run();
  } finally {
    linkOff();
  }
}
const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
const outbox = () =>
  rows<{
    kind: string;
    batch_id: string;
    application_id: string | null;
    status: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: Date;
  }>(`SELECT kind, batch_id, application_id, status, attempts, last_error, next_attempt_at FROM link_outbox ORDER BY seq`);
const kinds = async () => (await outbox()).map((m) => m.kind);
const waiting = (o: Partial<Parameters<typeof makeApplication>[1]> = {}) => makeApplication('BATCH', { centre, by: admin, ...o });
let n = 0;
async function makeRealBatch(list: TestApplication[], over: object = {}) {
  await setBatchSize(list.length);
  const res = await post('/manage/batches', admin.token, {
    name: `Batch ${++n}`,
    centre_id: centre,
    ids: list.map((a) => a.student.id),
    technology: await optionId('TECHNOLOGY', 'T01'),
    ...over,
  });
  expect([res.status, res.body.error]).toEqual([201, undefined]);
  return res.body.data as { id: string; code: string; sync: object | null };
}
const sync = async (id: string) => (await get(`/manage/batches/${id}`, admin.token)).body.data.sync;
/* As Sarthi would: back with the Auditor. */
const sendBack = (a: TestApplication) =>
  pool.query(`UPDATE applications SET approval_stage = NULL, approved_at = NULL, approved_by = NULL WHERE id = $1`, [
    a.applicationId,
  ]);

describe('what is told to Sarthi', () => {
  it('a new batch with its students, as people read the forms; never the Aadhaar number', async () => {
    await post('/manage/fields', admin.token, {
      step: 1,
      label_en: 'Days',
      label_mr: 'दिवस',
      type: 'CHECKBOXES',
      options: [{ name_en: 'Monday' }, { name_en: 'Friday' }],
    });
    const a = await waiting({
      account: { first_name: 'Anita', last_name: 'Bhosale' },
      values: { x_days: '["Friday","Monday"]', landmark: '' },
    });
    const b = await waiting({
      account: { first_name: 'Zoya', last_name: 'Adhav' },
      values: {
        grading_type: 'CGPA',
        cgpa_scale: '10',
        score: '8.2',
        disability_status: 'Yes',
        disability_type: 'Vision',
        technology: 'T08',
      },
    });
    const made = await makeRealBatch([a, b], { start_date: '2027-01-04', delivery_mode: 'BLENDED', technology: await optionId('TECHNOLOGY', 'T01') });
    expect(await outbox()).toEqual([
      expect.objectContaining({ kind: 'BATCH', batch_id: made.id, application_id: null, status: 'PENDING', attempts: 0 }),
    ]);
    expect(made.sync).toEqual({ status: 'WAITING', error: null, sent_at: null });

    expect(await deliver()).toEqual({ sent: 1, failed: 0, later: 0 });
    expect(sarthi.received).toHaveLength(1);
    const { path, method, signed, message } = sarthi.received[0]!;
    expect({ path, method, signed }).toEqual({ path: '/integration/v1/ipp/messages', method: 'POST', signed: true });
    expect(Object.keys(message).sort()).toEqual(['applications', 'batch', 'id', 'sent_at', 'seq']);
    expect(message.batch).toEqual({
      id: made.id,
      code: 'IPP-B-0001',
      name: expect.any(String),
      size: 2,
      district: { code: 'NAS', name: 'Nashik', state_code: 'MH' },
      centre: { code: 'NC-1', name: 'Nashik Center' },
      start_date: '2027-01-04',
      end_date: null,
      delivery_mode: 'BLENDED',
      technology: { code: 'T01', name: 'Data Analytics & Business Intelligence' },
      created_at: expect.any(String),
      created_by: 'Program Auditor',
      /* Not started: the Auditor starts it once every student of it is final approved. */
      status: 'NOT_STARTED',
      started_at: null,
      ended_at: null,
    });
    const first = message.applications[0]!;
    expect(first).toMatchObject({
      action: 'SUBMIT',
      id: a.applicationId,
      registration_id: expect.stringMatching(/^IPP-\d{6}$/),
      registration_number: expect.any(String),
      name: 'Anita Bhosale',
      email: a.student.email,
      mobile_number: a.student.mobile,
      aadhaar_masked: `XXXX-XXXX-${a.aadhaar.slice(-4)}`,
      district: 'Nashik',
      category: 'मराठा',
      centre: 'Nashik Center',
      technology: 'Data Analytics & Business Intelligence',
      auditor_approved_by: 'Program Auditor',
      auditor_approval_reason: 'Every document checked',
      edits: [],
    });
    const texts = (i: number) => Object.fromEntries(message.applications[i]!.fields.map((f) => [f.key, f.text]));
    expect(texts(0)).toMatchObject({
      first_name: 'Anita',
      email: a.student.email,
      district_id: 'Nashik',
      caste_id: 'मराठा',
      gender: 'Female',
      date_of_birth: '2003-04-15',
      aadhaar_number: `XXXX-XXXX-${a.aadhaar.slice(-4)}`,
      score: '72.5%',
      landmark: '',
      x_days: 'Friday, Monday',
    });
    /* What does not apply is left out; what does is there. */
    expect(texts(0)).not.toHaveProperty('disability_type');
    expect(texts(0)).not.toHaveProperty('cgpa_scale');
    expect(texts(1)).toMatchObject({
      score: '8.2 / 10',
      cgpa_scale: '10',
      disability_type: 'Vision',
      technology: 'AI/ML Engineer',
    });
    expect(first.fields.find((f) => f.key === 'x_days')).toMatchObject({
      step: 1,
      label_en: 'Days',
      label_mr: 'दिवस',
      type: 'CHECKBOXES',
    });
    expect(first.documents.find((d) => d.code === 'PHOTO')).toEqual({
      code: 'PHOTO',
      name: 'Photo',
      name_mr: 'छायाचित्र',
      required: true,
      kind: 'DOCUMENT',
      file: { name: 'photo.pdf', mime: 'application/pdf', size: FILES.pdf.length, uploaded_at: expect.any(String) },
      verified: true,
      verified_at: expect.any(String),
      verified_by: 'Program Auditor',
    });
    expect(first.documents.find((d) => d.code === 'APPLICANT_VIDEO')).toMatchObject({
      kind: 'VIDEO',
      file: null,
      verified: false,
    });
    for (const s of [a, b]) expect(JSON.stringify(message)).not.toContain(s.aadhaar);
    expect(await sync(made.id)).toEqual({ status: 'SENT', error: null, sent_at: expect.any(String) });
  });

  it('a changed batch, once for each change', async () => {
    const made = await makeRealBatch([await waiting()]);
    expect((await patch(`/manage/batches/${made.id}`, admin.token, { name: 'New name', technology: await optionId('TECHNOLOGY', 'T02') })).status).toBe(200);
    /* Nothing changed. */
    expect((await patch(`/manage/batches/${made.id}`, admin.token, { name: 'New name' })).status).toBe(200);
    expect(await kinds()).toEqual(['BATCH', 'BATCH_UPDATE']);
    await deliver();
    const [, update] = sarthi.messages();
    expect(update).toMatchObject({ batch: { name: 'New name', technology: { code: 'T02' } }, applications: [] });
    expect(update!.seq).toBeGreaterThan(sarthi.messages()[0]!.seq);
  });

  it('a corrected form, replaced documents and their checks, wherever the form is until the final approval', async () => {
    const a = await waiting();
    /* Not in a batch yet: nothing to tell. */
    await put(`/manage/applicants/${a.student.id}/form`, admin.token, { data: { landmark: 'Mill' } });
    expect(await kinds()).toEqual([]);
    await makeRealBatch([a]);
    const edit = (data: object) => put(`/manage/applicants/${a.student.id}/form`, admin.token, { data });
    expect((await edit({ landmark: 'Temple', aadhaar_number: '' })).status).toBe(200);
    expect((await edit({ landmark: 'Temple' })).status).toBe(200);
    await request('post', `/manage/applicants/${a.student.id}/documents`, admin.token).attach('PAN_CARD', FILES.jpg, 'pan.jpg');
    const verify = (verified: boolean) =>
      post(`/manage/applicants/${a.student.id}/documents/PAN_CARD/verify`, admin.token, { verified });
    await verify(true);
    /* Verified already. */
    await verify(true);
    expect(await kinds()).toEqual(['BATCH', 'UPDATE', 'UPDATE', 'UPDATE']);
    expect((await outbox()).slice(1).map((m) => m.application_id)).toEqual([a.applicationId, a.applicationId, a.applicationId]);
    await deliver();
    const last = sarthi.messages().at(-1)!;
    expect(last.applications[0]).toMatchObject({ action: 'UPDATE', id: a.applicationId });
    expect(last.applications[0]!.fields.find((f) => f.key === 'landmark')!.text).toBe('Temple');
    expect(last.applications[0]!.documents.find((d) => d.code === 'PAN_CARD')).toMatchObject({
      file: { name: 'pan.jpg', mime: 'image/jpeg' },
      verified: true,
    });
    expect(last.applications[0]!.edits.map((e) => e.changes.map((c) => c.key))).toEqual([
      ['PAN_CARD'],
      ['landmark'],
      ['landmark'],
    ]);
    /* Finally approved: nothing is changed any more, so nothing is told. */
    await pool.query(`UPDATE applications SET approval_stage = 'APPROVED' WHERE id = $1`, [a.applicationId]);
    await transaction((db) => enqueueApplications(db, 'UPDATE', [a.applicationId]));
    expect(await kinds()).toHaveLength(4);
  });

  it('a student who was sent back and is approved again', async () => {
    const [a, b] = [await waiting(), await waiting()];
    await makeRealBatch([a, b]);
    await deliver();
    await sendBack(a);
    await sendBack(b);
    expect((await post(`/manage/applicants/${a.student.id}/approve`, admin.token, { reason: 'Corrected and checked again' })).status).toBe(200);
    expect((await post('/manage/applicants/approve-selected', admin.token, { ids: [b.student.id], reason: 'Corrected and checked again' })).body.data.approved).toBe(1);
    expect((await kinds()).slice(1)).toEqual(['RESUBMIT', 'RESUBMIT']);
    await deliver();
    expect(
      sarthi
        .messages()
        .slice(1)
        .map((m) => m.applications.map((x) => [x.action, x.id])),
    ).toEqual([[['RESUBMIT', a.applicationId]], [['RESUBMIT', b.applicationId]]]);
    /* With the reason of the new approval, not the first one's. */
    expect(sarthi.messages().slice(1).map((m) => m.applications[0]!.auditor_approval_reason)).toEqual([
      'Corrected and checked again',
      'Corrected and checked again',
    ]);
    /* The first approval of a form is no message: it waits for a batch. */
    const fresh = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    await post(`/manage/applicants/${fresh.student.id}/approve`, admin.token, { reason: 'Every document checked' });
    expect(await kinds()).toHaveLength(3);
  });

  it('nothing is told of a change that is undone', async () => {
    const a = await waiting();
    await makeRealBatch([a]);
    await expect(
      transaction(async (db) => {
        await enqueueApplications(db, 'UPDATE', [a.applicationId]);
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await kinds()).toEqual(['BATCH']);
  });

  it('a batch of before the link is queued once', async () => {
    const batch = await makeBatch({ centre, by: admin });
    await makeApplication('DIVISION', { centre, by: admin, batch });
    await makeApplication('RETURNED', { centre, by: admin, batch });
    await makeBatch({ centre, by: admin });
    expect(await enqueueMissingBatches(pool)).toBe(1);
    expect(await enqueueMissingBatches(pool)).toBe(0);
    await deliver();
    /* The one who was sent back follows when approved again. */
    expect(sarthi.messages()[0]!.applications).toHaveLength(1);
  });

  it('a batch that is gone is passed over', async () => {
    const batch = await makeBatch({ centre, by: admin });
    await transaction((db) => enqueueBatch(db, 'BATCH', batch));
    await pool.query(`UPDATE batches SET deleted_at = now()`);
    expect(await deliver()).toEqual({ sent: 1, failed: 0, later: 0 });
    expect(sarthi.received).toEqual([]);
  });

  it('a message that cannot be made is tried again, and the others go out', async () => {
    const one_ = await makeRealBatch([await waiting()]);
    const two = await makeRealBatch([await waiting()]);
    /* Something impossible in the form's data. */
    await pool.query(`UPDATE applications SET data = data || '{"district_id": "x"}'::jsonb WHERE batch_id = $1`, [one_.id]);
    await pool.query(`ALTER TABLE application_edits RENAME TO application_edits_away`);
    try {
      expect(await deliver()).toEqual({ sent: 0, failed: 0, later: 2 });
    } finally {
      await pool.query(`ALTER TABLE application_edits_away RENAME TO application_edits`);
    }
    expect((await outbox())[0]).toMatchObject({
      status: 'PENDING',
      last_error: 'The message could not be made (see the server log)',
    });
    later(31_000);
    expect(await deliver()).toEqual({ sent: 2, failed: 0, later: 0 });
    expect(await sync(two.id)).toMatchObject({ status: 'SENT' });
  });
});

describe('how it is sent', () => {
  it('waits while the link is off, and goes out when it is on', async () => {
    const made = await makeRealBatch([await waiting()]);
    linkOff();
    expect(await worker().run()).toBeNull();
    expect(sarthi.received).toEqual([]);
    expect(await sync(made.id)).toEqual({ status: 'WAITING', error: null, sent_at: null });
    expect(await deliver()).toMatchObject({ sent: 1 });
    expect(await deliver()).toEqual({ sent: 0, failed: 0, later: 0 });
  });

  it('not reachable or broken: again after 30 s, 1, 2, 5, 10, 30 min, then every hour; the reason without any value', async () => {
    const a = await waiting();
    const made = await makeRealBatch([a]);
    const answers: [reply: FakeSarthi['replies'][number], error: string][] = [
      ['drop', 'Sarthi could not be reached'],
      [
        { status: 500, body: { success: false, message: 'Something went wrong', error: { code: 'INTERNAL_ERROR' } } },
        'Sarthi answered 500 (INTERNAL_ERROR: Something went wrong)',
      ],
      [{ status: 401, body: {} }, 'Sarthi refused the signature (check the secret and the clocks of both servers)'],
      [{ status: 429, body: 'slow down' }, 'Sarthi answered 429'],
      [{ status: 408, body: {} }, 'Sarthi answered 408 (Sarthi answered 408)'],
      [{ status: 503, body: { error: { code: 'LINK_NOT_CONFIGURED' } } }, 'Sarthi answered 503 (LINK_NOT_CONFIGURED)'],
      [{ status: 200, body: '<html>' }, 'The answer is not from the Sarthi API (check SARTHI_API_URL)'],
      [
        { status: 200, body: { success: true, data: { id: 'another' } } },
        'The answer is not from the Sarthi API (check SARTHI_API_URL)',
      ],
      [{ status: 302, body: {} }, 'Sarthi could not be reached'],
    ];
    const minutes = [0.5, 1, 2, 5, 10, 30, 60, 60, 60];
    for (const [i, [reply, error]] of answers.entries()) {
      sarthi.replies.push(reply);
      expect(await deliver()).toEqual({ sent: 0, failed: 0, later: 1 });
      const [m] = await outbox();
      expect(m).toMatchObject({ status: 'PENDING', attempts: i + 1, last_error: error });
      expect(m!.next_attempt_at.getTime() - clock.getTime()).toBe(minutes[i]! * 60_000);
      expect(await sync(made.id)).toEqual({ status: 'WAITING', error, sent_at: null });
      /* Not before its time. */
      later(minutes[i]! * 60_000 - 1);
      expect(await deliver()).toEqual({ sent: 0, failed: 0, later: 0 });
      later(1);
    }
    expect(await deliver()).toEqual({ sent: 1, failed: 0, later: 0 });
    expect(await sync(made.id)).toMatchObject({ status: 'SENT', error: null });
    /* Always the same message. */
    expect(new Set(sarthi.messages().map((m) => m.id)).size).toBe(1);
    expect(JSON.stringify(await outbox())).not.toContain(a.student.email);
    expect([1, 6, 7, 40].map(waitAfter)).toEqual([30_000, 1_800_000, 3_600_000, 3_600_000]);
  });

  it('too slow an answer is an answer that did not come', async () => {
    await makeRealBatch([await waiting()]);
    linkOn(sarthi.url);
    const slow = createLinkWorker({
      fetch: (_url, init) =>
        new Promise((_done, fail) => init!.signal!.addEventListener('abort', () => fail(init!.signal!.reason as Error))),
      now: () => clock,
    });
    const { config } = await import('../../src/config');
    config.link.timeoutMs = 30;
    try {
      expect(await slow.run()).toMatchObject({ later: 1 });
    } finally {
      config.link.timeoutMs = 15_000;
    }
    expect((await outbox())[0]!.last_error).toBe('Sarthi did not answer in time');
  });

  it.each([400, 404, 409, 413, 422])('refused (%i): failed until somebody tries it again', async (status) => {
    const made = await makeRealBatch([await waiting()]);
    sarthi.replies.push({
      status,
      body: { success: false, status, message: 'Nashik is not in the District Master', error: { code: 'DISTRICT_UNKNOWN' } },
    });
    expect(await deliver()).toEqual({ sent: 0, failed: 1, later: 0 });
    later(24 * 3_600_000);
    expect(await deliver()).toEqual({ sent: 0, failed: 0, later: 0 });
    expect(await sync(made.id)).toEqual({
      status: 'FAILED',
      error: 'DISTRICT_UNKNOWN: Nashik is not in the District Master',
      sent_at: null,
    });
    const res = await post('/manage/link/retry', admin.token, { batch_id: made.id });
    expect([res.status, res.body.data]).toEqual([200, { retried: 1 }]);
    expect((await outbox())[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    clock = new Date(Date.now() + 2000);
    expect(await deliver()).toMatchObject({ sent: 1 });
  });

  it('in the order of the changes within a batch; a batch that is stuck does not hold up another', async () => {
    const a = await waiting();
    const first = await makeRealBatch([a]);
    await patch(`/manage/batches/${first.id}`, admin.token, { name: 'Stuck' });
    await put(`/manage/applicants/${a.student.id}/form`, admin.token, { data: { landmark: 'Mill' } });
    const second = await makeRealBatch([await waiting()]);
    sarthi.replies.push({ status: 409, body: { error: { code: 'DISTRICT_UNKNOWN' } } });
    expect(await deliver()).toEqual({ sent: 1, failed: 1, later: 0 });
    expect(sarthi.messages().map((m) => m.batch.id)).toEqual([first.id, second.id]);
    expect((await outbox()).map((m) => m.status)).toEqual(['FAILED', 'PENDING', 'PENDING', 'SENT']);
    await post('/manage/link/retry', admin.token, {});
    clock = new Date(Date.now() + 2000);
    expect(await deliver()).toMatchObject({ sent: 3 });
    expect(
      sarthi
        .messages()
        .slice(2)
        .map((m) => m.applications.map((x) => x.action).join() || 'batch'),
    ).toEqual(['SUBMIT', 'batch', 'UPDATE']);
    const seqs = sarthi
      .messages()
      .slice(2)
      .map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it('two changes of one batch at the same moment are numbered in the order they are kept', async () => {
    const [a, b] = [await waiting(), await waiting()];
    await makeRealBatch([a, b]);
    const order: string[] = [];
    let go!: () => void;
    const held = new Promise<void>((done) => (go = done));
    const slow = transaction(async (db) => {
      await enqueueApplications(db, 'UPDATE', [a.applicationId]);
      await held;
      order.push('a');
    });
    await new Promise((done) => setTimeout(done, 100));
    const fast = transaction(async (db) => {
      await enqueueApplications(db, 'UPDATE', [b.applicationId]);
      order.push('b');
    });
    await new Promise((done) => setTimeout(done, 100));
    expect(order).toEqual([]);
    go();
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a', 'b']);
    expect((await outbox()).slice(1).map((m) => m.application_id)).toEqual([a.applicationId, b.applicationId]);
  });

  it('one worker at a time', async () => {
    await makeRealBatch([await waiting()]);
    await makeRealBatch([await waiting()]);
    linkOn(sarthi.url);
    const runs = await Promise.all([worker().run(), worker().run(), worker().run()]);
    expect(runs.filter((r) => r !== null)).toEqual([{ sent: 2, failed: 0, later: 0 }]);
    expect(sarthi.messages()).toHaveLength(2);
  });

  it('a hundred students go in one message', async () => {
    const list = [];
    for (let i = 0; i < 100; i++) list.push(await waiting());
    await makeRealBatch(list);
    await deliver();
    expect(sarthi.messages()[0]!.applications).toHaveLength(100);
    expect(JSON.stringify(sarthi.messages()[0]).length).toBeLessThan(5_000_000);
  }, 120_000);

  it('of a running server: at once after the change', async () => {
    linkOn(sarthi.url);
    const made = await makeRealBatch([await waiting()]);
    for (let i = 0; i < 100 && !sarthi.messages().length; i++) await new Promise((done) => setTimeout(done, 50));
    expect(sarthi.messages().map((m) => m.batch.id)).toEqual([made.id]);
    for (let i = 0; i < 100 && (await sync(made.id)).status !== 'SENT'; i++) await new Promise((done) => setTimeout(done, 50));
    expect(await sync(made.id)).toMatchObject({ status: 'SENT' });
  });
});

describe('GET /manage/link', () => {
  it('says whether the link is on, and what is not sent and why', async () => {
    expect((await get('/manage/link', admin.token)).body.data).toEqual({
      enabled: false,
      configured: false,
      host: null,
      pending: 0,
      failed: 0,
      last_sent_at: null,
      last_received_at: null,
      items: [],
    });
    const a = await waiting({ account: { first_name: 'Anita', last_name: 'Bhosale' } });
    const made = await makeRealBatch([a]);
    await put(`/manage/applicants/${a.student.id}/form`, admin.token, { data: { landmark: 'Mill' } });
    sarthi.replies.push({ status: 409, body: { message: 'Not there', error: { code: 'DISTRICT_UNKNOWN' } } });
    await deliver();
    linkOn(sarthi.url);
    const viewer = await makePanelUser('VIEWER');
    const { body } = await get('/manage/link', viewer.token);
    expect(body.data).toMatchObject({ enabled: true, configured: true, host: new URL(sarthi.url).host, pending: 1, failed: 1 });
    expect(body.data.items).toEqual([
      {
        id: expect.any(String),
        kind: 'BATCH',
        batch: { id: made.id, code: made.code, name: expect.any(String) },
        student: null,
        status: 'FAILED',
        attempts: 1,
        next_attempt_at: expect.any(String),
        error: 'DISTRICT_UNKNOWN: Not there',
        created_at: expect.any(String),
      },
      expect.objectContaining({
        kind: 'UPDATE',
        student: { id: a.student.id, name: 'Anita Bhosale', registration_id: expect.stringMatching(/^IPP-/) },
        status: 'PENDING',
        error: null,
      }),
    ]);
    expect(JSON.stringify(body.data)).not.toContain(SECRET);
    linkOff();
    const list = (await get('/manage/batches', admin.token)).body.data[0];
    expect(list.sync).toEqual({ status: 'FAILED', error: 'DISTRICT_UNKNOWN: Not there', sent_at: null });
  });

  it('retry: the given ones, those of a batch, or all; recorded', async () => {
    const one_ = await makeRealBatch([await waiting()]);
    const two = await makeRealBatch([await waiting()]);
    sarthi.replies.push({ status: 409, body: {} }, { status: 500, body: {} });
    await deliver();
    const items = (await get('/manage/link', admin.token)).body.data.items as { id: string; batch: { id: string } }[];
    expect((await post('/manage/link/retry', admin.token, { ids: [items[0]!.id] })).body).toMatchObject({
      message: '1 message(s) will be sent again',
      data: { retried: 1 },
    });
    expect((await post('/manage/link/retry', admin.token, { batch_id: two.id })).body.data).toEqual({ retried: 1 });
    clock = new Date(Date.now() + 2000);
    expect(await deliver()).toMatchObject({ sent: 2 });
    expect((await post('/manage/link/retry', admin.token, {})).body).toMatchObject({
      message: 'Nothing is waiting to be sent',
      data: { retried: 0 },
    });
    expect((await post('/manage/link/retry', admin.token, { ids: ['x'] })).status).toBe(422);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'edp.link.retry'`))!.n).toBe(3);
    expect(one_.id).not.toBe(two.id);
  });

  it('test: asks Sarthi', async () => {
    const test = async () => (await post('/manage/link/test', admin.token, {})).body.data;
    expect(await test()).toEqual({ ok: false, message: 'The connection is switched off.' });
    linkOn(sarthi.url);
    expect(await test()).toEqual({ ok: true, message: 'Sarthi answered.' });
    expect(sarthi.received.at(-1)).toMatchObject({ method: 'GET', path: '/integration/v1/ipp/ping', signed: true });
    sarthi.replies.push({ status: 401, body: {} });
    expect(await test()).toEqual({
      ok: false,
      message: 'Sarthi refused the signature (check the secret and the clocks of both servers)',
    });
    linkOn('http://127.0.0.1:9');
    expect(await test()).toEqual({ ok: false, message: 'Sarthi could not be reached' });
  });
});

describe('the settings of the link', () => {
  const base = {
    NODE_ENV: 'production',
    SARTHI_LINK_ENABLED: true,
    SARTHI_API_URL: 'https://sarthi.example.org',
    SARTHI_LINK_SECRET: SECRET,
  };
  it.each([
    ['complete', {}, []],
    ['off and empty', { SARTHI_LINK_ENABLED: false, SARTHI_API_URL: undefined, SARTHI_LINK_SECRET: undefined }, []],
    [
      'on without the address',
      { SARTHI_API_URL: undefined },
      ['SARTHI_LINK_ENABLED=true needs SARTHI_API_URL and SARTHI_LINK_SECRET'],
    ],
    [
      'on without the secret',
      { SARTHI_LINK_SECRET: undefined },
      ['SARTHI_LINK_ENABLED=true needs SARTHI_API_URL and SARTHI_LINK_SECRET'],
    ],
    [
      'with a path',
      { SARTHI_API_URL: 'https://x.example.org/api' },
      ['SARTHI_API_URL must be an address without a path, e.g. https://api.example.org'],
    ],
    ['with a slash at its end', { SARTHI_API_URL: 'https://x.example.org/' }, []],
    ['not https', { SARTHI_API_URL: 'http://x.example.org' }, ['SARTHI_API_URL must be https']],
    ['not https, on the same server', { SARTHI_API_URL: 'http://127.0.0.1:5001' }, []],
    ['not https, on a developer’s machine', { NODE_ENV: 'development', SARTHI_API_URL: 'http://x.example.org' }, []],
  ])('%s', (_what, over, problems) => {
    expect(linkProblems({ ...base, ...over })).toEqual(problems);
  });
});

it('the caste of a message is the choice’s name, also of one since deleted', async () => {
  const id = await optionId('CASTE', 'SAR02');
  const a = await waiting({ values: { caste_id: id } });
  await pool.query(`UPDATE program_options SET is_active = false, deleted_at = now() WHERE id = $1`, [id]);
  await makeRealBatch([a]);
  await deliver();
  expect(sarthi.messages()[0]!.applications[0]!.category).toBe('मराठा-कुणबी');
});
