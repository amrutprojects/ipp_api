import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { checkForm } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { districtId, formValues, makeCentre, makePanelUser, optionId, type TestPanelUser } from '../helpers/factory';
import { audits, del, get, issues, patch, post, put, refused } from './helpers';

interface District {
  district_id: string;
  district: string;
  all: boolean;
  codes: string[];
}

let admin: TestPanelUser;
let pune: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  pune = await districtId('PUN');
});
afterAll(closeDatabase);

const districts = async () => (await get(admin, '/technologies/districts')).body.data as District[];
const rowOf = async (id: string) => (await districts()).find((d) => d.district_id === id);
const set = (id: string, codes: string[]) => put(admin, `/technologies/districts/${id}`, { codes });
const technology = async (code: string) => `/masters/TECHNOLOGY/${await optionId('TECHNOLOGY', code)}`;

describe('GET /manage/technologies/districts', () => {
  it('lists the active districts, A to Z; nothing selected = all', async () => {
    const all = await districts();
    expect(all).toHaveLength(36);
    expect(all[0]).toEqual({ district_id: await districtId('AHL'), district: 'Ahilyanagar', all: true, codes: [] });
    expect(all.map((d) => d.district)).toEqual([...all.map((d) => d.district)].sort((a, b) => a.localeCompare(b, 'en')));
    await patch(admin, `/districts/${pune}`, { is_active: false });
    expect(await rowOf(pune)).toBeUndefined();
    await del(admin, `/districts/${await districtId('AHL')}`);
    expect(await districts()).toHaveLength(34);
  });
});

describe('PUT /manage/technologies/districts/:districtId', () => {
  it('replaces the selection, in the order of the list', async () => {
    const res = await put(admin, `/technologies/districts/${pune}`, { codes: ['t07', ' T03 '] });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Saved');
    expect(res.body.data).toEqual({ district_id: pune, district: 'Pune', all: false, codes: ['T03', 'T07'] });
    expect(await rowOf(pune)).toEqual(res.body.data);
    expect((await loadProgram()).districtTechnologies()).toEqual({ [pune]: ['T03', 'T07'] });
    expect((await set(pune, ['T05'])).body.data.codes).toEqual(['T05']);
    expect((await set(pune, [])).body.data).toEqual({ district_id: pune, district: 'Pune', all: true, codes: [] });
    expect((await loadProgram()).districtTechnologies()).toEqual({});
    /* Also of a district that is switched off. */
    await patch(admin, `/districts/${pune}`, { is_active: false });
    expect((await set(pune, ['T01'])).body.data).toMatchObject({ district_id: pune, codes: ['T01'] });
  });

  it('takes technologies of the list only, each once', async () => {
    await set(pune, ['T01']);
    const bad = async (body: object) => issues(await put(admin, `/technologies/districts/${pune}`, body));
    expect(await bad({ codes: ['T01', 'T99'] })).toEqual({ 'body.codes': 'Choose technologies of the Technology master only' });
    expect(await bad({ codes: ['T01', 't01'] })).toEqual({ 'body.codes': 'Each technology may be listed only once' });
    expect(await bad({ codes: Array.from({ length: 201 }, (_x, i) => `T${i + 100}`) })).toEqual({
      'body.codes': 'At most 200 technologies',
    });
    expect(await bad({})).toEqual({ 'body.codes': 'codes is required' });
    expect(await bad({ codes: 'T01' })).toEqual({ 'body.codes': 'codes must be a list' });
    await del(admin, await technology('T02'));
    expect(await bad({ codes: ['T02'] })).toEqual({ 'body.codes': 'Choose technologies of the Technology master only' });
    expect((await rowOf(pune))!.codes).toEqual(['T01']);
    /* A switched-off one may be kept. */
    await patch(admin, await technology('T04'), { is_active: false });
    expect((await set(pune, ['T01', 'T04'])).body.data.codes).toEqual(['T01', 'T04']);
  });

  it('knows no deleted district', async () => {
    const id = await districtId('AHL');
    await del(admin, `/districts/${id}`);
    refused(await set(id, []), 404, 'District not found');
  });

  it('none of the selected ones active any more is the same as none selected; a deleted one is gone', async () => {
    await set(pune, ['T03', 'T05']);
    await patch(admin, await technology('T03'), { is_active: false });
    expect(await rowOf(pune)).toMatchObject({ all: false, codes: ['T03', 'T05'] });
    await del(admin, await technology('T05'));
    expect(await rowOf(pune)).toMatchObject({ all: true, codes: ['T03'] });
    expect((await loadProgram()).districtTechnologies()).toEqual({});
    /* A new one of the same name is another technology: it is not selected. */
    await post(admin, '/masters/TECHNOLOGY', { name_en: 'IT Infrastructure & Smart Technologies' });
    expect(await rowOf(pune)).toMatchObject({ all: true, codes: ['T03'] });
  });

  it('decides what a student of the district may choose', async () => {
    const centre = await makeCentre();
    const nashik = await districtId('NAS');
    const errors = async (district: string, technologyCode: string) =>
      (
        await checkForm(await loadProgram(), await formValues(centre, { district_id: district, technology: technologyCode }), {
          step: 2,
        })
      ).errors;
    const { code } = (await post(admin, '/masters/TECHNOLOGY', { name_en: 'Drone Technology' })).body.data as { code: string };
    await set(pune, ['T03', code]);
    const notOffered = [{ field: 'body.technology', message: 'Technology is not offered in the selected district' }];
    /* Step 2 is checked with the district of step 1. */
    expect(await errors(pune, 'T05')).toEqual(notOffered);
    expect(await errors(pune, code)).toEqual([]);
    expect(await errors(nashik, 'T05')).toEqual([]);
    expect(await errors(nashik, 'T14')).toEqual([{ field: 'body.technology', message: 'Select a valid Technology' }]);
    await patch(admin, await technology('T03'), { is_active: false });
    await patch(admin, await technology(code), { is_active: false });
    expect(await errors(pune, 'T05')).toEqual([]);
  });

  it('is recorded with how many were selected; a refused one is not', async () => {
    await set(pune, ['T01', 'T02']);
    await set(pune, ['T99']);
    expect(await audits('edp.master.district_technologies')).toEqual([
      {
        action: 'edp.master.district_technologies',
        resource: 'district',
        resource_id: pune,
        actor_kind: 'PANEL',
        actor_id: admin.id,
        details: { count: 2 },
      },
    ]);
    expect((await pool.query('SELECT 1 FROM district_technologies WHERE district_id = $1', [pune])).rowCount).toBe(2);
  });
});
