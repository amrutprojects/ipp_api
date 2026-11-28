import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  districtId,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  optionId,
  type TestPanelUser,
} from '../helpers/factory';
import { get } from './helpers';

let admin: TestPanelUser;
let viewer: TestPanelUser;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  viewer = await makePanelUser('VIEWER');
});
afterAll(closeDatabase);

const total = async (query: string) => (await get(`/manage/applicants?${query}`, admin.token)).body.meta.total as number;

describe('GET /manage/dashboard', () => {
  it('counts the students of the list by District, Category, Technology, Centre, Documents and Final verification', async () => {
    const nashik = await makeCentre({ name: 'Nashik Center', code: 'NC-1' });
    const pune = await makeCentre({ name: 'Pune Center', code: 'PC-1', district: 'PUN' });
    const batch = await makeBatch({ centre: nashik, by: admin, size: 30 });
    const s1 = await makeApplication('SUBMITTED', { centre: nashik, by: admin });
    await makeApplication('SUBMITTED', {
      centre: pune,
      by: admin,
      values: { district_id: await districtId('PUN'), caste_id: await optionId('CASTE', 'SAR02'), technology: 'T02' },
    });
    await makeApplication('APPROVED', { centre: nashik, by: admin, batch });
    await makeApplication('DRAFT', { centre: nashik }); // no form yet: nothing filled in
    /* A record in the trash is left out. */
    const trashed = await makeApplication('SUBMITTED', { centre: nashik, by: admin });
    await pool.query(`UPDATE student_accounts SET manage_deleted_at = now() WHERE id = $1`, [trashed.student.id]);
    await pool.query(`UPDATE applications SET documents_verified_at = NULL`);
    await pool.query(`UPDATE applications SET documents_verified_at = now() WHERE account_id = $1`, [s1.student.id]);

    const res = await get('/manage/dashboard', admin.token);
    expect(res.status).toBe(200);
    const nas = await districtId('NAS');
    const pun = await districtId('PUN');
    const t01 = await optionId('TECHNOLOGY', 'T01');
    const t02 = await optionId('TECHNOLOGY', 'T02');
    expect(res.body.data).toEqual({
      districts: [
        { id: nas, name: 'Nashik', count: 2 },
        { id: pun, name: 'Pune', count: 1 },
        { id: null, name: null, count: 1 },
      ],
      categories: [
        { id: await optionId('CASTE', 'SAR01'), name: 'मराठा', count: 2 },
        { id: await optionId('CASTE', 'SAR02'), name: 'मराठा-कुणबी', count: 1 },
        { id: null, name: null, count: 1 },
      ],
      technologies: [
        { id: t01, name: 'Data Analytics & Business Intelligence', count: 2 },
        { id: t02, name: 'Graphic Design & Digital Branding', count: 1 },
        { id: null, name: null, count: 1 },
      ],
      centres: [
        { id: nashik, name: 'Nashik Center', count: 2 },
        { id: pune, name: 'Pune Center', count: 1 },
        { id: null, name: null, count: 1 },
      ],
      documents: { VERIFIED: 1, NOT_VERIFIED: 3 },
      final: { VERIFIED: 1, NOT_VERIFIED: 3 },
    });
    /* Each count opens the same students in the list's filter. */
    expect(await total(`district_id=${nas}`)).toBe(2);
    expect(await total(`technology_id=${t02}`)).toBe(1);
    expect(await total(`centre_id=${nashik}`)).toBe(2);
    expect(await total('documents=VERIFIED')).toBe(1);
    expect(await total('documents=NOT_VERIFIED')).toBe(3);
    expect(await total('final=VERIFIED')).toBe(1);
    /* A viewer reads it too. */
    expect((await get('/manage/dashboard', viewer.token)).body.data).toEqual(res.body.data);
  });

  it('is empty without students, and needs a panel session', async () => {
    expect((await get('/manage/dashboard', admin.token)).body.data).toEqual({
      districts: [],
      categories: [],
      technologies: [],
      centres: [],
      documents: { VERIFIED: 0, NOT_VERIFIED: 0 },
      final: { VERIFIED: 0, NOT_VERIFIED: 0 },
    });
    expect((await get('/manage/dashboard')).status).toBe(401);
  });
});
