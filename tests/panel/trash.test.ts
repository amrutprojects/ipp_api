import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { makeApplication, makeBatch, makeCentre, makePanelUser, request } from '../helpers/factory';
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

  it('cannot delete a record once the Auditor has approved its form: at every later stage, after the final approval, and when sent back', async () => {
    const admin = await makePanelUser('ADMIN');
    const centre = await makeCentre();
    const batch = await makeBatch({ centre, by: admin, size: 30 });
    const approved = [
      await makeApplication('BATCH', { centre, by: admin }),
      await makeApplication('DIVISION', { centre, by: admin, batch }),
      await makeApplication('APPROVED', { centre, by: admin, batch }),
      /* Approved, then sent back to the Auditor by the Divisional Officer: approved once all the same. */
      await makeApplication('RETURNED', { centre, by: admin, batch }),
    ];
    const open = [await makeApplication('SUBMITTED', { centre }), await makeApplication('VERIFIED_DOCS', { centre, by: admin })];
    const rows = (await get('/manage/applicants?limit=100', admin.token)).body.data as { id: string; can_delete: boolean }[];
    const canDelete = (id: string) => rows.find((r) => r.id === id)!.can_delete;
    for (const a of approved) {
      expect(canDelete(a.student.id)).toBe(false);
      const res = await request('delete', `/manage/applicants/${a.student.id}`, admin.token);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('APPROVED_NOT_DELETABLE');
    }
    for (const a of open) {
      expect(canDelete(a.student.id)).toBe(true);
      expect((await request('delete', `/manage/applicants/${a.student.id}`, admin.token)).status).toBe(200);
    }
    expect(await audits('STUDENT_TRASHED')).toHaveLength(open.length);
  });
});

