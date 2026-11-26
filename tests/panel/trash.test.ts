import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { makeApplication, makeCentre, makePanelUser, request } from '../helpers/factory';
import { applicationRow, audits, get, post } from './helpers';

afterAll(closeDatabase);
beforeEach(resetDatabase);

describe('management trash', () => {
  it('moves and restores a record without changing its application, stage or account access', async () => {
    const admin = await makePanelUser('ADMIN');
    const viewer = await makePanelUser('VIEWER');
    const application = await makeApplication('SUBMITTED', { centre: await makeCentre() });
    const student = application.student;
    const before = await applicationRow(student.id);
    expect((await request('delete', `/manage/applicants/${student.id}`, viewer.token)).status).toBe(403);
    expect((await request('delete', `/manage/applicants/${student.id}`, admin.token)).status).toBe(200);
    expect((await request('delete', `/manage/applicants/${student.id}`, admin.token)).status).toBe(404);
    expect((await get('/manage/applicants', admin.token)).body.data).toHaveLength(0);
    expect((await get('/manage/summary', admin.token)).body.data.total).toBe(0);
    const trashed = await get('/manage/applicants/trash', viewer.token);
    expect(trashed.status).toBe(200);
    expect(trashed.body.data.map((r: { id: string }) => r.id)).toContain(student.id);
    expect((await get(`/manage/applicants/${student.id}`, admin.token)).status).toBe(200);
    expect(await applicationRow(student.id)).toEqual(before);
    expect((await pool.query('SELECT deleted_at, is_active FROM student_accounts WHERE id = $1', [student.id])).rows[0]).toEqual({ deleted_at: null, is_active: true });
    expect((await post(`/manage/applicants/${student.id}/restore`, viewer.token)).status).toBe(403);
    expect((await post(`/manage/applicants/${student.id}/restore`, admin.token)).status).toBe(200);
    expect((await post(`/manage/applicants/${student.id}/restore`, admin.token)).status).toBe(404);
    expect((await get('/manage/applicants/trash', admin.token)).body.data).toHaveLength(0);
    expect((await get('/manage/applicants', admin.token)).body.data[0].id).toBe(student.id);
    expect(await applicationRow(student.id)).toEqual(before);
    expect(await audits('STUDENT_TRASHED')).toHaveLength(1);
    expect(await audits('STUDENT_RESTORED')).toHaveLength(1);
  });
});

