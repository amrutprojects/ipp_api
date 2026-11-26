import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  activeDocuments,
  addFile,
  FILES,
  makeAccount,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  type TestPanelUser,
} from '../helpers/factory';
import { applicationRow, audits, detailsOf, eventsOf, get, post, setStage, UNKNOWN_ID } from './helpers';

let admin: TestPanelUser;
let centre: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  centre = await makeCentre();
});
afterAll(closeDatabase);

const REASON = 'Every document checked against the originals';
const approve = (id: string, token = admin.token, reason: unknown = REASON) =>
  post(`/manage/applicants/${id}/approve`, token, { reason } as object);
const approveSelected = (ids: unknown, token = admin.token, reason: unknown = REASON) =>
  post('/manage/applicants/approve-selected', token, { ids, reason } as object);
const verify = (id: string, code: string, verified: unknown = true, token = admin.token) =>
  post(`/manage/applicants/${id}/documents/${code}/verify`, token, { verified } as object);
const listed = async (id: string) =>
  ((await get('/manage/applicants?limit=100', admin.token)).body.data as { id: string }[]).find(
    (r) => r.id === id,
  ) as unknown as {
    can_approve: boolean;
    documents_verified: boolean;
    documents: { uploaded: number; verified: number };
    approval: { stage: string | null };
  };

describe('the check of each document', () => {
  it('a form can be approved only when every uploaded document is verified', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const id = s.student.id;
    const codes = await activeDocuments();
    const n = codes.length;
    expect(await listed(id)).toMatchObject({
      documents: { uploaded: n, verified: 0 },
      can_approve: false,
      documents_verified: false,
    });
    const none = await approve(id);
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({
      message: `Verify every document first (0 of ${n} verified).`,
      error: { code: 'CONFLICT' },
    });

    for (const [i, code] of codes.slice(0, n - 1).entries()) {
      const res = await verify(id, code);
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Document marked as verified');
      expect(res.body.data).toEqual({
        verified: true,
        at: expect.any(String),
        by: 'Program Auditor',
        documents: { uploaded: n, verified: i + 1 },
      });
    }
    expect((await approve(id)).body.message).toBe(`Verify every document first (${n - 1} of ${n} verified).`);
    expect((await approveSelected([id])).body.data).toEqual({ approved: 0, skipped: 1 });

    /* The last one marks the form; any case of the code will do. */
    expect((await verify(id, codes[n - 1]!.toLowerCase())).body.data.documents).toEqual({ uploaded: n, verified: n });
    expect(await listed(id)).toMatchObject({ documents: { verified: n }, can_approve: true, documents_verified: true });
    expect(await applicationRow(id)).toMatchObject({ documents_verified_at: expect.any(Date), documents_verified_by: admin.id });

    /* Taken back: the form's mark goes too. */
    const undone = await verify(id, 'PHOTO', false);
    expect(undone.body.message).toBe('Document marked as not verified');
    expect(undone.body.data).toEqual({ verified: false, at: null, by: null, documents: { uploaded: n, verified: n - 1 } });
    expect(await applicationRow(id)).toMatchObject({ documents_verified_at: null, documents_verified_by: null });
    expect((await approve(id)).status).toBe(409);
    expect((await verify(id, 'PHOTO')).status).toBe(200);
    expect((await approve(id)).status).toBe(200);
    expect((await listed(id)).approval.stage).toBe('BATCH');
  });

  it('keeps who verified first when it is verified again, and records only real changes', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const first = (await verify(s.student.id, 'PHOTO')).body.data;
    const second = await makePanelUser('ADMIN', { name: 'Second Auditor' });
    expect((await verify(s.student.id, 'PHOTO', true, second.token)).body.data).toEqual(first);
    await verify(s.student.id, 'PHOTO', false, second.token);
    await verify(s.student.id, 'PHOTO', false, second.token);
    expect((await verify(s.student.id, 'PHOTO', true, second.token)).body.data.by).toBe('Second Auditor');
    const log = [...(await audits('edp.document.verify')), ...(await audits('edp.document.unverify'))];
    expect(log.map((a) => [a.action, a.actor_id])).toEqual([
      ['edp.document.verify', admin.id],
      ['edp.document.verify', second.id],
      ['edp.document.unverify', second.id],
    ]);
    expect(log[0]).toMatchObject({
      resource: 'student_account',
      resource_id: s.student.id,
      actor_kind: 'PANEL',
      details: { applicationId: s.applicationId, document: 'PHOTO' },
      request_id: expect.any(String),
    });
  });

  it('is possible at every stage from the submission to the final approval', async () => {
    const batch = await makeBatch({ centre, by: admin });
    for (const state of ['SUBMITTED', 'VERIFIED_DOCS', 'BATCH', 'DIVISION', 'RETURNED'] as const) {
      const s = await makeApplication(state, { centre, by: admin, batch });
      expect([state, (await verify(s.student.id, 'PHOTO', state === 'SUBMITTED')).status]).toEqual([state, 200]);
    }
    const later = await makeApplication('DIVISION', { centre, by: admin, batch });
    for (const stage of ['COEP', 'HEAD_OFFICE', 'ADMIN']) {
      await setStage(later.student.id, stage);
      expect([stage, (await verify(later.student.id, 'PHOTO', stage !== 'COEP')).status]).toEqual([stage, 200]);
      /* The stage stays as it is. */
      expect((await applicationRow(later.student.id)).approval_stage).toBe(stage);
    }
    const final = await makeApplication('APPROVED', { centre, by: admin, batch });
    const refused = await verify(final.student.id, 'PHOTO', false);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('This form is finally approved and can no longer be changed.');
    const draft = await makeApplication('MAIN_DONE', { centre });
    await addFile(draft.applicationId, 'PHOTO');
    for (const id of [draft.student.id, (await makeAccount()).id]) {
      const res = await verify(id, 'PHOTO');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("Only a submitted form's documents can be verified.");
    }
  });

  it('answers 404 for an unknown student or a document without a file, and 422 for a wrong body', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    for (const id of [UNKNOWN_ID, 'abc']) {
      const res = await verify(id, 'PHOTO');
      expect([res.status, res.body.message]).toEqual([404, 'Student not found']);
    }
    for (const code of ['APPLICANT_VIDEO', 'FITNESS', 'not%20a%20code', '%00', 'x'.repeat(41)]) {
      const res = await verify(s.student.id, code);
      expect([code, res.status, res.body.message]).toEqual([code, 404, 'No file has been uploaded for this document']);
    }
    expect(detailsOf(await verify(s.student.id, 'PHOTO', 'yes'))).toEqual([
      { field: 'body.verified', message: 'verified must be true or false' },
    ]);
    expect(detailsOf(await post(`/manage/applicants/${s.student.id}/documents/PHOTO/verify`, admin.token, {}))).toEqual([
      { field: 'body.verified', message: 'verified is required' },
    ]);
  });

  it('counts a document that is no longer asked for, as long as it has a file', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'DOMICILE'`);
    const n = (await activeDocuments()).length + 1;
    expect((await verify(s.student.id, 'DOMICILE', false)).body.data.documents).toEqual({ uploaded: n, verified: n - 1 });
    expect((await approve(s.student.id)).status).toBe(409);
    expect((await verify(s.student.id, 'DOMICILE')).status).toBe(200);
    expect((await approve(s.student.id)).status).toBe(200);
  });
});

describe('the approval of one form', () => {
  it('sends it to wait for a batch', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    const res = await approve(s.student.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Form approved', data: { approved: 1 } });
    expect(await applicationRow(s.student.id)).toMatchObject({
      approval_stage: 'BATCH',
      batch_id: null,
      approved_at: expect.any(Date),
      approved_by: admin.id,
      stage_updated_at: expect.any(Date),
    });
    expect(await eventsOf(s.student.id)).toEqual([
      { action: 'APPROVE', from_stage: 'AUDITOR', to_stage: 'BATCH', actor_kind: 'PANEL', panel_user_id: admin.id },
    ]);
    const [event] = await audits('edp.application.approve');
    expect(event).toMatchObject({
      resource: 'student_account',
      resource_id: s.student.id,
      actor_id: admin.id,
      details: { applicationId: s.applicationId },
    });
    const view = (await get(`/manage/applicants/${s.student.id}`, admin.token)).body.data;
    expect(view.history).toEqual([
      {
        action: 'APPROVE',
        from: { stage: 'AUDITOR', name: 'Auditor' },
        to: { stage: 'BATCH', name: 'Batch' },
        reason: REASON,
        by: 'Program Auditor',
        role: null,
        at: expect.any(String),
      },
    ]);
  });

  it('a first approval needs no reason; one given must be 3 to 500 characters, kept trimmed in the history', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    const id = s.student.id;
    expect((await listed(id)).approval).toMatchObject({ stage: null, reason_required: false });
    const refused = async (reason: unknown) => {
      const res = await approve(id, admin.token, reason);
      expect(res.status).toBe(422);
      return detailsOf(res);
    };
    expect(await refused('  ok  ')).toEqual([{ field: 'body.reason', message: 'Approval reason must be at least 3 characters' }]);
    expect(await refused('x'.repeat(501))).toEqual([{ field: 'body.reason', message: 'Approval reason must be at most 500 characters' }]);
    expect(await refused(42)).toEqual([{ field: 'body.reason', message: 'Approval reason must be text' }]);
    expect(await refused('bad\u0000text')).toEqual([{ field: 'body.reason', message: 'Approval reason contains characters that cannot be saved' }]);
    /* Nothing was approved by a refused call. */
    expect(await eventsOf(id)).toEqual([]);

    expect((await post(`/manage/applicants/${id}/approve`, admin.token, {})).status).toBe(200);
    const [event] = (await get(`/manage/applicants/${id}`, admin.token)).body.data.history;
    expect(event).toMatchObject({ action: 'APPROVE', reason: null });

    const other = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    expect((await approve(other.student.id, admin.token, `  ${'y'.repeat(500)}  `)).status).toBe(200);
    const [kept] = (await get(`/manage/applicants/${other.student.id}`, admin.token)).body.data.history;
    expect(kept).toMatchObject({ action: 'APPROVE', reason: 'y'.repeat(500) });
  });

  it('a second approval, after a rejection by the Divisional Officer, needs the reason', async () => {
    const batch = await makeBatch({ centre, by: admin, size: 30 });
    const s = await makeApplication('RETURNED', { centre, by: admin, batch });
    const id = s.student.id;
    expect((await listed(id)).approval).toMatchObject({ stage: null, reason_required: true });
    for (const body of [{}, { reason: undefined }]) {
      const res = await post(`/manage/applicants/${id}/approve`, admin.token, body);
      expect([res.status, detailsOf(res)]).toEqual([
        422,
        [{ field: 'body.reason', message: 'Approval reason is required: the form was rejected before, so this is its second approval.' }],
      ]);
    }
    expect((await applicationRow(id)).approval_stage).toBe(null);
    expect((await approve(id, admin.token, 'Photo replaced and verified')).status).toBe(200);
    const [latest] = (await get(`/manage/applicants/${id}`, admin.token)).body.data.history;
    expect(latest).toMatchObject({ action: 'APPROVE', from: { stage: 'AUDITOR' }, reason: 'Photo replaced and verified' });
  });

  it('a second approval, after a return to the candidate, needs the reason', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    /* Returned to the candidate and resubmitted (program/returns). */
    await pool.query(
      `INSERT INTO application_returns (application_id, reason, panel_user_id, actor_name, email_status, resubmitted_at)
       VALUES ($1, 'Marks card is not clear', $2, $3, 'SENT', now())`,
      [s.applicationId, admin.id, admin.name],
    );
    expect((await listed(s.student.id)).approval).toMatchObject({ reason_required: true });
    expect(detailsOf(await post(`/manage/applicants/${s.student.id}/approve`, admin.token, {}))).toEqual([
      { field: 'body.reason', message: 'Approval reason is required: the form was rejected before, so this is its second approval.' },
    ]);
    expect((await approve(s.student.id, admin.token, 'Clear marks card uploaded')).status).toBe(200);
  });

  it('sends one that was sent back straight to the Divisional Officer again, in the same batch', async () => {
    const batch = await makeBatch({ centre, by: admin, size: 30 });
    const s = await makeApplication('RETURNED', { centre, by: admin, batch });
    expect((await approve(s.student.id)).status).toBe(200);
    expect(await applicationRow(s.student.id)).toMatchObject({
      approval_stage: 'DIVISION',
      batch_id: batch,
      approved_at: expect.any(Date),
      approved_by: admin.id,
    });
    expect((await eventsOf(s.student.id)).map((e) => [e.action, e.from_stage, e.to_stage])).toEqual([
      ['APPROVE', 'AUDITOR', 'BATCH'],
      ['APPROVE', 'BATCH', 'DIVISION'],
      ['REJECT', 'DIVISION', 'AUDITOR'],
      ['APPROVE', 'AUDITOR', 'DIVISION'],
    ]);
    expect(await listed(s.student.id)).toMatchObject({ approval: { stage: 'DIVISION', last_event: { action: 'APPROVE' } } });
    expect((await get('/manage/applicants?application_stage=RETURNED', admin.token)).body.meta.total).toBe(0);
  });

  it('is refused with the reason', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const reasonOf = async (id: string) => {
      const res = await approve(id);
      return [res.status, res.body.message];
    };
    for (const state of ['DRAFT', 'BASIC_DONE', 'MAIN_DONE'] as const)
      expect(await reasonOf((await makeApplication(state, { centre })).student.id)).toEqual([
        409,
        'Only a submitted form can be approved.',
      ]);
    expect(await reasonOf((await makeAccount()).id)).toEqual([409, 'Only a submitted form can be approved.']);
    for (const state of ['BATCH', 'DIVISION', 'APPROVED'] as const)
      expect(await reasonOf((await makeApplication(state, { centre, by: admin, batch })).student.id)).toEqual([
        409,
        'This form is already approved.',
      ]);
    const bare = await makeApplication('SUBMITTED', { centre });
    await pool.query(`DELETE FROM application_files WHERE application_id = $1`, [bare.applicationId]);
    expect(await reasonOf(bare.student.id)).toEqual([
      409,
      'No document has been uploaded for this form, so it cannot be approved.',
    ]);
    expect(await reasonOf(UNKNOWN_ID)).toEqual([404, 'Student not found']);
    expect(await reasonOf('abc')).toEqual([404, 'Student not found']);
    const deleted = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    await pool.query(`UPDATE student_accounts SET deleted_at = now() WHERE id = $1`, [deleted.student.id]);
    expect(await reasonOf(deleted.student.id)).toEqual([404, 'Student not found']);
    expect(await audits('edp.application.approve')).toEqual([]);
  });

  it('happens once, however often it is asked for at the same moment', async () => {
    const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    const all = await Promise.all([
      approve(s.student.id),
      approve(s.student.id),
      approveSelected([s.student.id]),
      approve(s.student.id),
    ]);
    expect(all.filter((r) => r.status === 200 && r.body.data.approved === 1)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409).every((r) => r.body.message === 'This form is already approved.')).toBe(true);
    expect(await eventsOf(s.student.id)).toHaveLength(1);
  });

  it('never approves a form whose document is taken back at the same moment', async () => {
    for (let round = 0; round < 5; round++) {
      const s = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
      const [approval, undo] = await Promise.all([approve(s.student.id), verify(s.student.id, 'PHOTO', false)]);
      expect(undo.status).toBe(200);
      /* Either the approval came first, or it saw the document as it ended up. */
      const events = await eventsOf(s.student.id);
      if (approval.status === 200) expect(events).toHaveLength(1);
      else {
        expect(approval.body.message).toMatch(/^Verify every document first \(\d+ of \d+ verified\)\.$/);
        expect(events).toHaveLength(0);
        expect((await applicationRow(s.student.id)).approval_stage).toBe(null);
      }
    }
  });
});

describe('the approval of the selected forms', () => {
  it('approves what can be approved and skips the rest', async () => {
    const batch = await makeBatch({ centre, by: admin });
    const o = { centre, by: admin, batch };
    const a = await makeApplication('VERIFIED_DOCS', o);
    const b = await makeApplication('VERIFIED_DOCS', o);
    const back = await makeApplication('RETURNED', o);
    const unverified = await makeApplication('SUBMITTED', o);
    const draft = await makeApplication('MAIN_DONE', o);
    const done = await makeApplication('BATCH', o);
    const res = await approveSelected([...[a, b, back, unverified, draft, done].map((x) => x.student.id), UNKNOWN_ID]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: '3 form(s) approved', data: { approved: 3, skipped: 4 } });
    expect((await applicationRow(a.student.id)).approval_stage).toBe('BATCH');
    expect((await applicationRow(b.student.id)).approval_stage).toBe('BATCH');
    expect((await applicationRow(back.student.id)).approval_stage).toBe('DIVISION');
    expect((await applicationRow(unverified.student.id)).approval_stage).toBe(null);
    expect((await applicationRow(draft.student.id)).approval_stage).toBe(null);
    expect(await eventsOf(done.student.id)).toHaveLength(1);
    const [event] = await audits('edp.application.approve_selected');
    expect(event).toMatchObject({ resource: 'application', actor_id: admin.id, details: { count: 3, selected: 7 } });
    /* The reason is free text: kept in the history, not in the audit. */
    expect(JSON.stringify(await audits('edp.application.approve_selected'))).not.toContain(REASON);
    /* Each form approved keeps the one reason in its own history. */
    for (const x of [a, b, back]) {
      const [latest] = (await get(`/manage/applicants/${x.student.id}`, admin.token)).body.data.history;
      expect(latest).toMatchObject({ action: 'APPROVE', from: { stage: 'AUDITOR' }, reason: REASON, by: 'Program Auditor' });
    }

    const again = await approveSelected([a.student.id]);
    expect(again.body).toMatchObject({
      message: 'None of the selected forms was waiting for approval',
      data: { approved: 0, skipped: 1 },
    });
    expect(await audits('edp.application.approve_selected')).toHaveLength(1);
  });

  it('checks the selection', async () => {
    const id = UNKNOWN_ID;
    expect(detailsOf(await approveSelected([]))).toEqual([{ field: 'body.ids', message: 'Select at least one student' }]);
    expect(detailsOf(await approveSelected(undefined))).toEqual([{ field: 'body.ids', message: 'Select at least one student' }]);
    expect(detailsOf(await approveSelected('all'))).toEqual([{ field: 'body.ids', message: 'ids must be a list' }]);
    expect(detailsOf(await approveSelected([id, id.toUpperCase()]))).toEqual([
      { field: 'body.ids', message: 'Each student may be selected only once' },
    ]);
    expect(detailsOf(await approveSelected(['abc']))).toEqual([{ field: 'body.ids.0', message: 'Student is not valid' }]);
    /* No reason: none of them is a second approval (unknown here: skipped). */
    expect((await post('/manage/applicants/approve-selected', admin.token, { ids: [id] })).body.data).toEqual({ approved: 0, skipped: 1 });
    expect(detailsOf(await approveSelected([id], admin.token, 'no'))).toEqual([
      { field: 'body.reason', message: 'Approval reason must be at least 3 characters' },
    ]);
    const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(detailsOf(await approveSelected(many))).toEqual([{ field: 'body.ids', message: 'At most 500 students at a time' }]);
    expect((await approveSelected(many.slice(0, 500))).body.data).toEqual({ approved: 0, skipped: 500 });
  });

  it('asks the reason when any selected form is approved a second time, and approves none without it', async () => {
    const batch = await makeBatch({ centre, by: admin, size: 30 });
    const first = await makeApplication('VERIFIED_DOCS', { centre, by: admin });
    const again = await makeApplication('RETURNED', { centre, by: admin, batch });
    const ids = [first.student.id, again.student.id];
    const res = await post('/manage/applicants/approve-selected', admin.token, { ids });
    expect([res.status, detailsOf(res)]).toEqual([
      422,
      [
        {
          field: 'body.reason',
          message: 'Approval reason is required: 1 of the selected forms were rejected before, so this is their second approval.',
        },
      ],
    ]);
    for (const id of ids) expect((await applicationRow(id)).approval_stage).toBe(null);
    expect((await approveSelected(ids, admin.token, 'Checked again')).body.data).toEqual({ approved: 2, skipped: 0 });
  });

  it('gives each form one event when two selections overlap', async () => {
    const students = await Promise.all([1, 2, 3, 4].map(() => makeApplication('VERIFIED_DOCS', { centre, by: admin })));
    const ids = students.map((s) => s.student.id);
    const both = await Promise.all([approveSelected(ids), approveSelected([...ids].reverse())]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.reduce((n, r) => n + r.body.data.approved, 0)).toBe(4);
    for (const id of ids) expect(await eventsOf(id)).toHaveLength(1);
  });
});

describe('a form after the approval', () => {
  it('keeps its stage when a document is added to its files', async () => {
    const s = await makeApplication('BATCH', { centre, by: admin });
    await addFile(s.applicationId, 'APPLICANT_VIDEO', FILES.mp4, 'video.mp4');
    expect((await verify(s.student.id, 'APPLICANT_VIDEO')).status).toBe(200);
    expect((await applicationRow(s.student.id)).approval_stage).toBe('BATCH');
    expect(await one(`SELECT count(*)::int AS n FROM approval_events`)).toEqual({ n: 1 });
  });
});
