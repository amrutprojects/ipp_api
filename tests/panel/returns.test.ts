import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { config } from '../../src/config';
import { emails, mailer } from '../../src/services/mailer';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { activeDocuments, FILES, makeApplication, makeBatch, makeCentre, makePanelUser, request, type TestPanelUser } from '../helpers/factory';
import { audits, get, post, put } from './helpers';

/*
 * "Enable Rejection Email Notification and Resubmission": the Auditor sends a submitted form back to the candidate with a
 * reason (e-mailed), the candidate corrects it and saves, which resubmits it to the Auditor. Off, nothing of it is offered.
 */

let admin: TestPanelUser;
let centre: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  centre = await makeCentre({ name: 'Nashik Center' });
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeDatabase);

const switchOn = (on = true, token = admin.token) => put('/manage/settings/rejection', token, { enabled: on });
const sendBack = (id: string, reason = 'The Aadhaar card photo is not readable', token = admin.token) =>
  post(`/manage/applicants/${id}/return`, token, { reason });
const returnsOf = (applicationId: string) =>
  rows<{ reason: string; actor_name: string; email_status: string; resubmitted_at: Date | null }>(
    `SELECT reason, actor_name, email_status, resubmitted_at FROM application_returns WHERE application_id = $1 ORDER BY seq`,
    [applicationId],
  );
const listed = async (query: string) => ((await get(`/manage/applicants${query}`, admin.token)).body.data as { id: string }[]).map((r) => r.id);
/* As the candidate: request(…, student token). */
const asStudent = (method: 'get' | 'put' | 'post', path: string, token: string) => request(method, path, token);

describe('the setting', () => {
  it('is off until an ADMIN switches it on; a viewer reads it but cannot change it', async () => {
    const before = await get('/manage/settings/rejection', admin.token);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ enabled: false, updated_at: null });

    const viewer = await makePanelUser('VIEWER');
    expect((await get('/manage/settings/rejection', viewer.token)).status).toBe(200);
    expect((await switchOn(true, viewer.token)).status).toBe(403);
    expect((await put('/manage/settings/rejection', admin.token, {})).status).toBe(422);

    const saved = await switchOn();
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ enabled: true, updated_by: 'Program Auditor' });
    expect((await switchOn(false)).body.data.enabled).toBe(false);
  });
});

describe('POST /manage/applicants/:id/return (the Auditor rejects to the candidate)', () => {
  it('is refused while the setting is off, and nothing changes', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const res = await sendBack(s.student.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REJECTION_OFF');
    expect(await returnsOf(s.applicationId)).toEqual([]);
    expect((await get(`/manage/applicants/${s.student.id}/returns`, admin.token)).body.data).toMatchObject({
      enabled: false,
      can_return: false,
      returns: [],
    });
  });

  it('sends a form that is with the Auditor back, e-mails the candidate the reason, and keeps it from the Auditor', async () => {
    await switchOn();
    const send = vi.spyOn(mailer, 'sendFormReturned').mockResolvedValue('SENT');
    const s = await makeApplication('VERIFIED_DOCS', { centre });
    expect((await get(`/manage/applicants/${s.student.id}/returns`, admin.token)).body.data.can_return).toBe(true);

    const res = await sendBack(s.student.id, '  Upload a clear photo of the Aadhaar card  ');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ email: 'SENT' });
    expect(send).toHaveBeenCalledWith(s.student.email, s.student.first_name, 'Upload a clear photo of the Aadhaar card');
    expect(await returnsOf(s.applicationId)).toEqual([
      { reason: 'Upload a clear photo of the Aadhaar card', actor_name: 'Program Auditor', email_status: 'SENT', resubmitted_at: null },
    ]);
    expect(await audits('edp.application.return')).toHaveLength(1);

    /* With the candidate: not approvable, not editable, not "awaiting the Auditor", listed as sent back. */
    const detail = (await get(`/manage/applicants/${s.student.id}`, admin.token)).body.data;
    expect(detail.can_edit).toBe(false);
    expect(detail.returned).toMatchObject({ reason: 'Upload a clear photo of the Aadhaar card', by: 'Program Auditor' });
    const approve = await post(`/manage/applicants/${s.student.id}/approve`, admin.token, { reason: 'All fine' });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('WITH_CANDIDATE');
    const edit = await put(`/manage/applicants/${s.student.id}/form`, admin.token, { data: { father_name: 'Suresh Testkar' } });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('WITH_CANDIDATE');
    expect(await listed('?approval=WITH_CANDIDATE')).toEqual([s.student.id]);
    expect(await listed('?approval=AWAITING')).toEqual([]);
    const row = (await get('/manage/applicants', admin.token)).body.data[0];
    expect(row).toMatchObject({ can_approve: false });
    expect(row.returned_at).toBeTruthy();
    expect((await get('/manage/summary', admin.token)).body.data.approvals).toMatchObject({ WITH_CANDIDATE: 1, AWAITING: 0 });

    /* Only once at a time. */
    const again = await sendBack(s.student.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('WITH_CANDIDATE');
  });

  it('says when the e-mail could not be sent, and keeps that with the return', async () => {
    await switchOn();
    vi.spyOn(mailer, 'sendFormReturned').mockResolvedValue('FAILED');
    const s = await makeApplication('SUBMITTED', { centre });
    const res = await sendBack(s.student.id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/could not be sent/);
    expect((await returnsOf(s.applicationId))[0]!.email_status).toBe('FAILED');
  });

  it('without a mail server (development and tests) logs the e-mail instead: NOT_SENT', async () => {
    await switchOn();
    const s = await makeApplication('SUBMITTED', { centre });
    const res = await sendBack(s.student.id);
    expect(res.body.data).toEqual({ email: config.smtp.host ? expect.any(String) : 'NOT_SENT' });
  });

  it('only for a submitted form that is with the Auditor; a reason of 3–500 characters; ADMIN only', async () => {
    await switchOn();
    const draft = await makeApplication('MAIN_DONE', { centre });
    expect((await sendBack(draft.student.id)).status).toBe(409);
    const batch = await makeApplication('BATCH', { centre });
    expect((await sendBack(batch.student.id)).status).toBe(409);
    const s = await makeApplication('SUBMITTED', { centre });
    expect((await sendBack(s.student.id, 'no')).status).toBe(422);
    const viewer = await makePanelUser('VIEWER');
    expect((await sendBack(s.student.id, 'Not readable', viewer.token)).status).toBe(403);
    /* Sent back by the Divisional Officer and with the Auditor again: it can go to the candidate too. */
    const returned = await makeApplication('RETURNED', { centre });
    expect((await sendBack(returned.student.id)).status).toBe(200);
  });
});

describe('the candidate corrects and resubmits', () => {
  it('sees the reason, saves the changes and documents, and saving resubmits the form to the Auditor', async () => {
    await switchOn();
    const s = await makeApplication('VERIFIED_DOCS', { centre });
    await sendBack(s.student.id, 'Father name is misspelt');

    const seen = await asStudent('get', '/application', s.student.token);
    expect(seen.body.data.returned).toMatchObject({ reason: 'Father name is misspelt' });
    expect(seen.body.data.locked_fields).toEqual(['email']);

    const saved = await asStudent('put', '/application/correction', s.student.token).send({ data: { father_name: 'Ramesh Testkarr' } });
    expect(saved.status).toBe(200);
    const edit = (await one<{ panel_user_id: string | null; actor_name: string; changes: { key: string; to: string }[] }>(
      `SELECT panel_user_id, actor_name, changes FROM application_edits WHERE application_id = $1`,
      [s.applicationId],
    ))!;
    expect(edit).toMatchObject({ panel_user_id: null, actor_name: `${s.student.first_name} ${s.student.last_name} (candidate)` });
    expect(edit.changes).toEqual([expect.objectContaining({ key: 'father_name', to: 'Ramesh Testkarr' })]);

    const code = (await activeDocuments())[0]!;
    const file = await asStudent('post', '/application/correction/documents', s.student.token).attach(code, FILES.pdf, 'new.pdf');
    expect(file.status).toBe(200);
    /* A replaced document is verified again by the Auditor. */
    expect(await one(`SELECT 1 FROM document_checks WHERE application_id = $1 AND document_code = $2`, [s.applicationId, code])).toBeNull();

    const back = await asStudent('post', '/application/resubmit', s.student.token);
    expect(back.status).toBe(200);
    expect(back.body.data.returned).toBeNull();
    expect((await returnsOf(s.applicationId))[0]!.resubmitted_at).not.toBeNull();
    expect(await audits('edp.application.resubmitted')).toHaveLength(1);
    expect(await listed('?approval=AWAITING')).toEqual([s.student.id]);
    expect((await get(`/manage/applicants/${s.student.id}`, admin.token)).body.data.can_edit).toBe(true);

    /* With the Auditor again: verify the new document, then approve as before. */
    expect((await post(`/manage/applicants/${s.student.id}/documents/${code}/verify`, admin.token, { verified: true })).status).toBe(200);
    expect((await post(`/manage/applicants/${s.student.id}/approve`, admin.token, { reason: 'Corrected' })).status).toBe(200);
    /* And nothing more for the candidate to change. */
    expect((await asStudent('post', '/application/resubmit', s.student.token)).status).toBe(409);
  });

  it('cannot change a form that was not sent back', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    const res = await asStudent('put', '/application/correction', s.student.token).send({ data: { father_name: 'Someone Else' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_RETURNED');
    expect((await asStudent('post', '/application/resubmit', s.student.token)).body.error.code).toBe('NOT_RETURNED');
  });

  it('checks the whole form and its required documents before resubmitting', async () => {
    await switchOn();
    const s = await makeApplication('SUBMITTED', { centre });
    await sendBack(s.student.id);
    const code = (await activeDocuments())[0]!;
    await pool.query(`DELETE FROM application_files WHERE application_id = $1 AND document_code = $2`, [s.applicationId, code]);
    const res = await asStudent('post', '/application/resubmit', s.student.token);
    expect(res.status).toBe(422);
    expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toContain(`files.${code}`);
    expect((await returnsOf(s.applicationId))[0]!.resubmitted_at).toBeNull();
  });

  it('a form already sent back can still be corrected and resubmitted after the setting is switched off', async () => {
    await switchOn();
    const s = await makeApplication('SUBMITTED', { centre });
    await sendBack(s.student.id);
    await switchOn(false);
    expect((await asStudent('put', '/application/correction', s.student.token).send({ data: { father_name: 'Ramesh Patil' } })).status).toBe(200);
    expect((await asStudent('post', '/application/resubmit', s.student.token)).status).toBe(200);
  });
});

describe('the e-mail', () => {
  it('names the candidate, gives the reason (escaped, lines kept) and how to log in, and says saving resubmits', () => {
    const mail = emails.formReturnedEmail('Asha', 'Photo <blurred>\nUpload again', 'https://ipp.example/login', {
      message: '',
      email: null,
      mobile: null,
    });
    expect(mail.subject).toMatch(/correct your application/i);
    expect(mail.text).toContain('Dear Asha');
    expect(mail.text).toContain('Photo <blurred>\nUpload again');
    expect(mail.text).toContain('https://ipp.example/login');
    expect(mail.text).toMatch(/existing e-mail ID and password/);
    expect(mail.text).toMatch(/sent back to the Auditor automatically/);
    expect(mail.html).toContain('Photo &#60;blurred&#62;<br>Upload again');
    expect(mail.html).not.toContain('<blurred>');
    expect(mail.html).toContain('href="https://ipp.example/login"');
  });
});

describe('the candidate sees the final approval', () => {
  it('the status is Submitted until the final approval, then Approved', async () => {
    const batch = await makeBatch({ centre, by: admin, size: 30 });
    const submitted = await makeApplication('DIVISION', { centre, by: admin, batch });
    const seen = async (token: string) => (await request('get', '/application', token)).body.data.registration.status;
    expect(await seen(submitted.student.token)).toBe('SUBMITTED');
    await pool.query(`UPDATE applications SET approval_stage = 'APPROVED' WHERE id = $1`, [submitted.applicationId]);
    expect(await seen(submitted.student.token)).toBe('APPROVED');
    /* Still a submitted form that cannot be changed. */
    const view = (await request('get', '/application', submitted.student.token)).body.data;
    expect([view.status, view.editable]).toEqual(['SUBMITTED', false]);
    /* Counted and listed as Final Approved Students on the panel. */
    expect((await get('/manage/summary', admin.token)).body.data.approvals.APPROVED).toBe(1);
    expect(await listed('?application_stage=APPROVED')).toEqual([submitted.student.id]);
  });
});
