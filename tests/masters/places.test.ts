import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  districtId,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  request,
  type TestPanelUser,
} from '../helpers/factory';
import { audits, del, get, issues, NOBODY, oneOf, patch, post, refused, stored } from './helpers';

/* States, districts and talukas, and the public lists of them. */
interface Row {
  id: string;
  name: string;
  code: string | null;
  is_active: boolean;
  in_use: boolean;
}

let admin: TestPanelUser;
let maharashtra: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  maharashtra = (await one<{ id: string }>(`SELECT id FROM states WHERE code = 'MH'`))!.id;
});
afterAll(closeDatabase);

const rowsOf = async (path: string, query: Record<string, string | number> = {}) =>
  (await get(admin, path, query)).body.data as Row[];
const add = async (path: string, body: object) => {
  const res = await post(admin, path, body);
  expect(res.status).toBe(201);
  return res.body.data as Row;
};
const addState = (name: string, code: string, over: object = {}) => add('/states', { name, code, ...over });
const addDistrict = (name: string, over: object = {}) => add('/districts', { name, ...over });
const addTaluka = (district: string, name: string, over: object = {}) =>
  add('/talukas', { district_id: district, name, ...over });
/* A district of its own, without anything in it. */
const emptyDistrict = async (name = 'Dharashiv Test') => (await addDistrict(name)).id;
const makeCentreIn = async (district: string, taluka: string | null = null) =>
  (await one<{ id: string }>(
    `INSERT INTO centres (district_id, taluka_id, name, code) VALUES ($1, $2, 'C ' || gen_random_uuid(), upper(left(gen_random_uuid()::text, 8)))
     RETURNING id`,
    [district, taluka],
  ))!.id;
const remove = (table: 'centres' | 'applications' | 'batches' | 'talukas' | 'districts', where: string, id: string) =>
  pool.query(
    `UPDATE ${table} SET deleted_at = now()${['centres', 'talukas', 'districts'].includes(table) ? ', is_active = false' : ''} WHERE ${where} = $1`,
    [id],
  );

const NAME_RULE = 'Use letters, digits, spaces and . , ( ) - / only';
const badNames: [unknown, string][] = [
  [undefined, 'Name is required'],
  [5, 'Name must be text'],
  [' x ', 'Must be at least 2 characters'],
  ['x'.repeat(101), 'Must be at most 100 characters'],
  ['1st place', NAME_RULE],
  ['A & B', NAME_RULE],
  ['a\u0000b', NAME_RULE],
];

/* -------------------------------------------------------------------------------------------------------------- states */

describe('states', () => {
  it('lists every state by name, with how many districts it has', async () => {
    expect((await get(admin, '/states')).body.data).toEqual([
      { id: maharashtra, name: 'Maharashtra', code: 'MH', districts: 36, is_active: true, in_use: true },
    ]);
    const goa = await addState('Goa', 'GA', { is_active: false });
    await addDistrict('North Goa', { state_id: maharashtra });
    await remove('districts', 'code', 'AHL');
    await pool.query(`UPDATE districts SET is_active = false WHERE code = 'PUN'`);
    /* Inactive districts count, deleted ones do not. */
    expect(await rowsOf('/states')).toEqual([
      { id: goa.id, name: 'Goa', code: 'GA', districts: 0, is_active: false, in_use: false },
      { id: maharashtra, name: 'Maharashtra', code: 'MH', districts: 36, is_active: true, in_use: true },
    ]);
  });

  it('adds a state', async () => {
    const res = await post(admin, '/states', { name: '  Madhya   Pradesh ', code: ' mp ' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('State added');
    expect(res.body.data).toEqual({
      id: expect.any(String),
      name: 'Madhya Pradesh',
      code: 'MP',
      districts: 0,
      is_active: true,
      in_use: false,
    });
    expect(await addState('कर्नाटक', 'KA')).toMatchObject({ name: 'कर्नाटक' });
  });

  it('says what is wrong, and refuses a name or code that is taken', async () => {
    for (const [name, message] of badNames)
      expect(issues(await post(admin, '/states', { name, code: 'XX' }))).toEqual({ 'body.name': message });
    for (const [code, message] of [
      [undefined, 'Code is required'],
      ['M', 'Must be at least 2 characters'],
      ['ABCDEFGHIJK', 'Must be at most 10 characters'],
      ['1A', 'Use A–Z and 0–9 only, starting with a letter'],
      ['M-H', 'Use A–Z and 0–9 only, starting with a letter'],
    ])
      expect(issues(await post(admin, '/states', { name: 'Goa', code }))).toEqual({ 'body.code': message });
    expect(issues(await post(admin, '/states', { name: 'Goa', code: 'GA', is_active: 'no', districts: 1 }))).toEqual({
      'body.is_active': 'is_active must be true or false',
      'body.districts': 'Unknown field',
    });
    refused(await post(admin, '/states', { name: 'MAHARASHTRA', code: 'GA' }), 409, 'A state with this name already exists');
    refused(await post(admin, '/states', { name: 'Goa', code: 'mh' }), 409, 'A state with this code already exists');
    const results = await Promise.all(['GA', 'GO'].map((code) => post(admin, '/states', { name: 'Goa', code })));
    oneOf(201, results, 409, 'A state with this name already exists');
  });

  it('renames a state, switches it on or off', async () => {
    const goa = await addState('Goa', 'GA');
    const res = await patch(admin, `/states/${goa.id}`, { name: 'Goa State', code: 'gs' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('State saved');
    expect(res.body.data).toEqual({ ...goa, name: 'Goa State', code: 'GS' });
    expect((await patch(admin, `/states/${goa.id}`, { is_active: false })).body.data).toEqual({
      ...goa,
      name: 'Goa State',
      code: 'GS',
      is_active: false,
    });
    /* With districts too: they keep their own status. */
    expect((await patch(admin, `/states/${maharashtra}`, { is_active: false })).body.data.is_active).toBe(false);
    expect((await rowsOf('/districts')).every((d) => d.is_active)).toBe(true);

    refused(await patch(admin, `/states/${goa.id}`, { name: 'maharashtra' }), 409, 'Another state already uses this name');
    refused(await patch(admin, `/states/${goa.id}`, { code: 'MH' }), 409, 'Another state already uses this code');
    expect(issues(await patch(admin, `/states/${goa.id}`, {}))).toEqual({ body: 'Nothing to change' });
    expect(issues(await patch(admin, `/states/${goa.id}`, { code: '' }))).toEqual({
      'body.code': 'Must be at least 2 characters',
    });
    refused(await patch(admin, `/states/${NOBODY}`, { name: 'Goa' }), 404, 'State not found');
  });

  it('deletes a state without districts only', async () => {
    refused(
      await del(admin, `/states/${maharashtra}`),
      409,
      'This state cannot be deleted while 36 districts reference it. Deactivate it instead, or move or delete the districts first.',
    );
    const goa = await addState('Goa', 'GA');
    const north = await addDistrict('North Goa', { state_id: goa.id });
    refused(
      await del(admin, `/states/${goa.id}`),
      409,
      'This state cannot be deleted while 1 district references it. Deactivate it instead, or move or delete the districts first.',
    );
    expect(await stored('states', goa.id)).toEqual({ is_active: true, deleted: false });
    await del(admin, `/districts/${north.id}`);
    const res = await del(admin, `/states/${goa.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'State deleted', data: null });
    expect(await stored('states', goa.id)).toEqual({ is_active: false, deleted: true });
    refused(await del(admin, `/states/${goa.id}`), 404, 'State not found');
    refused(await patch(admin, `/states/${goa.id}`, { is_active: true }), 404, 'State not found');
    /* Its name and code are free again. */
    await addState('Goa', 'GA');
  });

  it('a state is not deleted under a district that is being added', async () => {
    for (let i = 0; i < 5; i++) {
      const state = await addState(`State ${'ABCDE'[i]}`, `S${i}`);
      const [deleted, added] = await Promise.all([
        del(admin, `/states/${state.id}`),
        post(admin, '/districts', { name: 'New Place', state_id: state.id }),
      ]);
      expect([deleted.status, added.status]).toEqual(deleted.status === 200 ? [200, 400] : [409, 201]);
    }
  });

  it('is recorded with the panel user, without names', async () => {
    const { id } = await addState('Goa', 'GA');
    await patch(admin, `/states/${id}`, { name: 'Goa State', is_active: false });
    await del(admin, `/states/${id}`);
    expect(await audits('edp.state.%')).toEqual(
      [
        { action: 'edp.state.create', details: null },
        { action: 'edp.state.update', details: { fields: ['name', 'is_active'] } },
        { action: 'edp.state.delete', details: null },
      ].map((e) => ({ ...e, resource: 'state', resource_id: id, actor_kind: 'PANEL', actor_id: admin.id })),
    );
  });
});

/* ----------------------------------------------------------------------------------------------------------- districts */

describe('districts', () => {
  it('lists every district by name, also the inactive ones', async () => {
    const all = await rowsOf('/districts');
    expect(all).toHaveLength(36);
    expect(all[0]).toEqual({
      id: await districtId('AHL'),
      name: 'Ahilyanagar',
      code: 'AHL',
      state_id: maharashtra,
      state: 'Maharashtra',
      talukas: 0,
      is_active: true,
      in_use: false,
    });
    expect(all.map((d) => d.name)).toEqual([...all.map((d) => d.name)].sort((a, b) => a.localeCompare(b, 'en')));
    await patch(admin, `/districts/${all[0]!.id}`, { is_active: false });
    expect((await rowsOf('/districts'))[0]).toMatchObject({ code: 'AHL', is_active: false });
  });

  it('filters by status and state when asked', async () => {
    const goa = await addState('Goa', 'GA');
    const north = await addDistrict('North Goa', { state_id: goa.id });
    await patch(admin, `/districts/${north.id}`, { is_active: false });
    const names = async (query: Record<string, string>) => (await rowsOf('/districts', query)).map((d) => d.name);
    expect(await names({ status: 'inactive' })).toEqual(['North Goa']);
    expect(await names({ status: 'ACTIVE' })).toHaveLength(36);
    expect(await names({ state_id: goa.id })).toEqual(['North Goa']);
    expect(await names({ state_id: goa.id, status: 'active' })).toEqual([]);
    expect(await names({ status: '', state_id: '' })).toHaveLength(37);
    expect(issues(await get(admin, '/districts', { status: 'off', state_id: 'x' }))).toEqual({
      'query.status': 'Choose Active or Inactive',
      'query.state_id': 'State is not valid',
    });
    refused(await get(admin, '/districts', { state_id: NOBODY }), 400, 'The selected state does not exist');
  });

  it('counts its talukas and says whether anything holds it: the same as its deletion', async () => {
    const id = await emptyDistrict();
    const row = async () => (await rowsOf('/districts')).find((d) => d.id === id)!;
    const held = async (message: string) => {
      expect((await row()).in_use).toBe(true);
      refused(await del(admin, `/districts/${id}`), 409, message);
    };
    expect(await row()).toMatchObject({ talukas: 0, in_use: false });

    const a = await addTaluka(id, 'One');
    await held(
      'This district cannot be deleted while 1 taluka references it. Deactivate it instead, or move or delete the talukas first.',
    );
    const b = await addTaluka(id, 'Two', { is_active: false });
    await held(
      'This district cannot be deleted while 2 talukas reference it. Deactivate it instead, or move or delete the talukas first.',
    );
    expect(await row()).toMatchObject({ talukas: 2 });

    const centre = await makeCentreIn(id);
    await held(
      'This district cannot be deleted while 2 talukas and 1 center reference it. Deactivate it instead, or remove those records first.',
    );
    for (const t of [a, b]) await del(admin, `/talukas/${t.id}`);
    expect(await row()).toMatchObject({ talukas: 0, in_use: true });
    await held(
      'This district cannot be deleted while 1 center references it. Deactivate it instead, or remove those records first.',
    );

    const elsewhere = await makeCentre();
    const batch = (await one<{ id: string }>(
      `INSERT INTO batches (name, district_id, centre_id, size) VALUES ('B', $1, $2, 1) RETURNING id`,
      [id, elsewhere],
    ))!.id;
    /* A draft holds it as much as a submitted form. */
    const forms = [
      await makeApplication('MAIN_DONE', { centre: elsewhere, values: { district_id: id } }),
      await makeApplication('SUBMITTED', { centre: elsewhere, values: { district_id: id } }),
    ];
    await held(
      "This district cannot be deleted while 1 center, 2 students' forms and 1 batch reference it. Deactivate it instead.",
    );
    await remove('centres', 'id', centre);
    await remove('applications', 'id', forms[0]!.applicationId);
    await held("This district cannot be deleted while 1 student's form and 1 batch reference it. Deactivate it instead.");
    await remove('applications', 'id', forms[1]!.applicationId);
    await held('This district cannot be deleted while 1 batch references it. Deactivate it instead.');
    expect(await stored('districts', id)).toEqual({ is_active: true, deleted: false });
    await remove('batches', 'id', batch);

    expect(await row()).toMatchObject({ talukas: 0, in_use: false });
    const res = await del(admin, `/districts/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'District deleted', data: null });
    expect(await stored('districts', id)).toEqual({ is_active: false, deleted: true });
    refused(await del(admin, `/districts/${id}`), 404, 'District not found');
    expect(await row()).toBeUndefined();
  });

  it('adds a district; a code left out is made from the name, the state left out is Maharashtra', async () => {
    const res = await post(admin, '/districts', { name: ' Dharashir ' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('District added');
    expect(res.body.data).toEqual({
      id: expect.any(String),
      name: 'Dharashir',
      code: 'DHARAS',
      state_id: maharashtra,
      state: 'Maharashtra',
      talukas: 0,
      is_active: true,
      in_use: false,
    });
    expect((await addDistrict('Dharashit')).code).toBe('DHARAS2');
    expect((await addDistrict('Dharashil', { code: '' })).code).toBe('DHARAS3');
    expect((await addDistrict('सातारा दोन', { code: ' sat-2 ' })).code).toBe('SAT-2');
    expect((await addDistrict('ठिकाण')).code).toBe('DIST');
    expect((await addDistrict('X 1', { is_active: false })).code).toBe('DIST2');
    expect((await addDistrict('Müñchen')).code).toBe('MUNCHE');
    /* A deleted one's code is free. */
    await del(admin, `/districts/${res.body.data.id}`);
    expect((await addDistrict('Dharashik')).code).toBe('DHARAS');
    /* Two at the same time get two codes. */
    const both = await Promise.all(['Kokan East', 'Kokan West'].map((name) => post(admin, '/districts', { name })));
    expect(both.map((r) => r.body.data.code).sort()).toEqual(['KOKANE', 'KOKANW']);
    const same = await Promise.all(['Vidarbha North', 'Vidarbha South'].map((name) => post(admin, '/districts', { name })));
    expect(same.map((r) => r.body.data.code).sort()).toEqual(['VIDARB', 'VIDARB2']);
  });

  it('without Maharashtra the state left out is the one with the most districts; without a state there is none to choose', async () => {
    const goa = await addState('Goa', 'GA');
    const gujarat = await addState('Gujarat', 'GJ');
    await addDistrict('Surat', { state_id: gujarat.id });
    /* Maharashtra, also when another one has more. */
    await pool.query(`UPDATE districts SET state_id = $1 WHERE code NOT IN ('NAS', 'PUN')`, [gujarat.id]);
    expect(await addDistrict('Kokan')).toMatchObject({ state_id: maharashtra });
    await patch(admin, `/states/${maharashtra}`, { is_active: false });
    expect(await addDistrict('Kutch')).toMatchObject({ state_id: gujarat.id, state: 'Gujarat' });
    for (const s of [goa, gujarat]) await patch(admin, `/states/${s.id}`, { is_active: false });
    expect(issues(await post(admin, '/districts', { name: 'Nowhere' }))).toEqual({ 'body.state_id': 'Choose a state' });
  });

  it('says what is wrong, and refuses a name or code that is taken in the state', async () => {
    for (const [name, message] of badNames)
      expect(issues(await post(admin, '/districts', { name }))).toEqual({ 'body.name': message });
    for (const [code, message] of [
      ['P', 'Must be at least 2 characters'],
      ['x'.repeat(21), 'Must be at most 20 characters'],
      ['1A', 'Use A–Z, 0–9 and hyphen, starting with a letter'],
      ['A_B', 'Use A–Z, 0–9 and hyphen, starting with a letter'],
    ])
      expect(issues(await post(admin, '/districts', { name: 'Place', code }))).toEqual({ 'body.code': message });
    expect(issues(await post(admin, '/districts', { name: 'Place', state_id: 'MH', is_active: 1, talukas: 2 }))).toEqual({
      'body.state_id': 'State is not valid',
      'body.is_active': 'is_active must be true or false',
      'body.talukas': 'Unknown field',
    });
    refused(
      await post(admin, '/districts', { name: 'PUNE' }),
      409,
      'A district with this name already exists in the selected state',
    );
    refused(
      await post(admin, '/districts', { name: 'Place', code: 'pun' }),
      409,
      'A district with this code already exists in the selected state',
    );
    const results = await Promise.all([1, 2].map(() => post(admin, '/districts', { name: 'Same' })));
    oneOf(201, results, 409, 'A district with this name already exists in the selected state');
    /* In another state both are free. */
    const goa = await addState('Goa', 'GA');
    expect(await addDistrict('Pune', { code: 'PUN', state_id: goa.id })).toMatchObject({ state: 'Goa', code: 'PUN' });

    const unknown = await post(admin, '/districts', { name: 'Place', state_id: NOBODY });
    refused(unknown, 400, 'The selected state does not exist');
    expect(unknown.body.error.details).toEqual([{ field: 'stateId', message: 'Unknown state' }]);
    await patch(admin, `/states/${goa.id}`, { is_active: false });
    const inactive = await post(admin, '/districts', { name: 'Place', state_id: goa.id });
    refused(inactive, 400, 'The selected state is inactive');
    expect(inactive.body.error.details).toEqual([{ field: 'stateId', message: 'Choose an active state' }]);
  });

  it('renames a district, switches it and moves it to another state', async () => {
    const pune = await districtId('PUN');
    const path = `/districts/${pune}`;
    const before = (await rowsOf('/districts')).find((d) => d.id === pune)!;
    const res = await patch(admin, path, { name: 'Pune City', code: 'pun-c', is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('District saved');
    expect(res.body.data).toEqual({ ...before, name: 'Pune City', code: 'PUN-C', is_active: false });
    /* A blank code is not sent. */
    expect((await patch(admin, path, { code: '', is_active: true })).body.data).toMatchObject({ code: 'PUN-C', is_active: true });
    expect(issues(await patch(admin, path, { code: '' }))).toEqual({ body: 'Nothing to change' });
    expect(issues(await patch(admin, path, {}))).toEqual({ body: 'Nothing to change' });
    expect(issues(await patch(admin, path, { name: 'x', state: 'Goa' }))).toEqual({
      'body.name': 'Must be at least 2 characters',
      'body.state': 'Unknown field',
    });
    refused(await patch(admin, path, { name: 'nashik' }), 409, 'A district with this name already exists in the selected state');
    refused(await patch(admin, path, { code: 'NAS' }), 409, 'A district with this code already exists in the selected state');
    refused(await patch(admin, `/districts/${NOBODY}`, { name: 'Pune' }), 404, 'District not found');

    const goa = await addState('Goa', 'GA');
    const other = await addDistrict('Pune City', { state_id: goa.id });
    refused(
      await patch(admin, path, { state_id: goa.id }),
      409,
      'A district with this name already exists in the selected state',
    );
    await patch(admin, `/districts/${other.id}`, { name: 'North Goa', code: 'NG' });
    expect((await patch(admin, path, { state_id: goa.id })).body.data).toMatchObject({ state_id: goa.id, state: 'Goa' });
    refused(await patch(admin, path, { state_id: NOBODY }), 400, 'The selected state does not exist');
    await patch(admin, `/states/${maharashtra}`, { is_active: false });
    refused(await patch(admin, path, { state_id: maharashtra }), 400, 'The selected state is inactive');
    /* The state it is in may have been switched off since. */
    expect(
      (await patch(admin, `/districts/${await districtId()}`, { state_id: maharashtra, name: 'Nasik' })).body.data,
    ).toMatchObject({
      name: 'Nasik',
      state_id: maharashtra,
    });
  });

  it('is recorded with the panel user, without names', async () => {
    const { id } = await addDistrict('Dharashir');
    await patch(admin, `/districts/${id}`, { name: 'Dharashit', code: 'DD' });
    await del(admin, `/districts/${id}`);
    expect(await audits('edp.district.%')).toEqual(
      [
        { action: 'edp.district.create', details: { state_id: maharashtra } },
        { action: 'edp.district.update', details: { fields: ['name', 'code'] } },
        { action: 'edp.district.delete', details: null },
      ].map((e) => ({ ...e, resource: 'district', resource_id: id, actor_kind: 'PANEL', actor_id: admin.id })),
    );
  });
});

/* ------------------------------------------------------------------------------------------------------------- talukas */

describe('talukas', () => {
  let pune: string;
  let nashik: string;
  beforeEach(async () => {
    pune = await districtId('PUN');
    nashik = await districtId('NAS');
  });

  it('lists the talukas by district and name; search, filters and pages', async () => {
    const haveli = await addTaluka(pune, 'Haveli', { code: 'HVL' });
    const baramati = await addTaluka(pune, 'baramati', { is_active: false });
    const sinnar = await addTaluka(nashik, 'Sinnar');
    const res = await get(admin, '/talukas');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 3, totalPages: 1 });
    expect(res.body.data).toEqual([
      { id: sinnar.id, name: 'Sinnar', code: null, district_id: nashik, district: 'Nashik', is_active: true, in_use: false },
      { id: baramati.id, name: 'baramati', code: null, district_id: pune, district: 'Pune', is_active: false, in_use: false },
      { id: haveli.id, name: 'Haveli', code: 'HVL', district_id: pune, district: 'Pune', is_active: true, in_use: false },
    ]);
    const names = async (query: Record<string, string | number>) => (await rowsOf('/talukas', query)).map((t) => t.name);
    expect(await names({ district_id: pune })).toEqual(['baramati', 'Haveli']);
    expect(await names({ status: 'active' })).toEqual(['Sinnar', 'Haveli']);
    expect(await names({ status: 'INACTIVE', district_id: nashik })).toEqual([]);
    expect(await names({ search: 'HVL' })).toEqual(['Haveli']);
    expect(await names({ search: 'inn' })).toEqual(['Sinnar']);
    expect(await names({ search: 'pune' })).toEqual(['baramati', 'Haveli']);
    expect(await names({ search: '_' })).toEqual([]);
    expect(await names({ limit: 2, page: 2 })).toEqual(['Haveli']);
    expect((await get(admin, '/talukas', { limit: 2, page: 5 })).body).toMatchObject({
      data: [],
      meta: { page: 5, limit: 2, total: 3, totalPages: 2 },
    });
    expect(issues(await get(admin, '/talukas', { status: 'x', district_id: 'x', limit: 101 }))).toMatchObject({
      'query.status': 'Choose Active or Inactive',
      'query.district_id': 'District is not valid',
      'query.limit': expect.any(String),
    });
    const unknown = await get(admin, '/talukas', { district_id: NOBODY });
    refused(unknown, 400, 'The selected district does not exist');
    expect(unknown.body.error.details).toEqual([{ field: 'district_id', message: 'Unknown district' }]);
  });

  it('adds a taluka', async () => {
    const res = await post(admin, '/talukas', { district_id: pune, name: ' Haveli ', code: 'hvl' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Taluka added');
    expect(res.body.data).toEqual({
      id: expect.any(String),
      name: 'Haveli',
      code: 'HVL',
      district_id: pune,
      district: 'Pune',
      is_active: true,
      in_use: false,
    });
    expect(await addTaluka(pune, 'मुळशी', { code: ' ', is_active: false })).toMatchObject({ code: null, is_active: false });
    expect(await addTaluka(pune, 'Maval', { code: null })).toMatchObject({ code: null });
    expect((await rowsOf('/districts')).find((d) => d.id === pune)).toMatchObject({ talukas: 3, in_use: true });
  });

  it('says what is wrong, and refuses a name or code that is taken in the district', async () => {
    for (const [name, message] of badNames)
      expect(issues(await post(admin, '/talukas', { district_id: pune, name }))).toEqual({ 'body.name': message });
    expect(issues(await post(admin, '/talukas', { name: 'Haveli' }))).toEqual({ 'body.district_id': 'District is required' });
    expect(
      issues(await post(admin, '/talukas', { district_id: 'x', name: 'Haveli', code: '1', is_active: 0, state: 1 })),
    ).toEqual({
      'body.district_id': 'District is not valid',
      'body.code': 'Must be at least 2 characters',
      'body.is_active': 'is_active must be true or false',
      'body.state': 'Unknown field',
    });
    await addTaluka(pune, 'Haveli', { code: 'HVL' });
    refused(
      await post(admin, '/talukas', { district_id: pune, name: 'HAVELI' }),
      409,
      'A taluka with this name already exists in the selected district',
    );
    refused(
      await post(admin, '/talukas', { district_id: pune, name: 'Maval', code: 'HVL' }),
      409,
      'A taluka with this code already exists in the selected district',
    );
    const results = await Promise.all([1, 2].map(() => post(admin, '/talukas', { district_id: pune, name: 'Same' })));
    oneOf(201, results, 409, 'A taluka with this name already exists in the selected district');
    /* In another district both are free, and any number may have no code. */
    await addTaluka(nashik, 'Haveli', { code: 'HVL' });

    const unknown = await post(admin, '/talukas', { district_id: NOBODY, name: 'Nowhere' });
    refused(unknown, 400, 'The selected district does not exist');
    expect(unknown.body.error.details).toEqual([{ field: 'district_id', message: 'Unknown district' }]);
    await patch(admin, `/districts/${nashik}`, { is_active: false });
    const inactive = await post(admin, '/talukas', { district_id: nashik, name: 'Yeola' });
    refused(inactive, 400, 'The selected district is inactive');
    expect(inactive.body.error.details).toEqual([{ field: 'district_id', message: 'Choose an active district' }]);
  });

  it('renames a taluka, switches it and moves it to another district', async () => {
    const taluka = await addTaluka(pune, 'Haveli', { code: 'HVL' });
    const path = `/talukas/${taluka.id}`;
    const res = await patch(admin, path, { name: 'Haveli City', code: null, is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Taluka saved');
    expect(res.body.data).toEqual({ ...taluka, name: 'Haveli City', code: null, is_active: false });
    expect((await patch(admin, path, { code: 'hc' })).body.data.code).toBe('HC');
    expect((await patch(admin, path, { code: '' })).body.data.code).toBe(null);
    expect((await patch(admin, path, { district_id: nashik })).body.data).toMatchObject({
      district_id: nashik,
      district: 'Nashik',
    });
    expect(issues(await patch(admin, path, {}))).toEqual({ body: 'Nothing to change' });
    expect(issues(await patch(admin, path, { name: '?', district: 'Pune' }))).toEqual({
      'body.name': 'Must be at least 2 characters',
      'body.district': 'Unknown field',
    });
    const other = await addTaluka(pune, 'Haveli City', { code: 'X1' });
    await addTaluka(pune, 'Maval', { code: 'MVL' });
    refused(
      await patch(admin, path, { district_id: pune }),
      409,
      'A taluka with this name already exists in the selected district',
    );
    refused(
      await patch(admin, `/talukas/${other.id}`, { code: 'mvl' }),
      409,
      'A taluka with this code already exists in the selected district',
    );
    refused(await patch(admin, path, { district_id: NOBODY }), 400, 'The selected district does not exist');
    refused(await patch(admin, `/talukas/${NOBODY}`, { name: 'Haveli' }), 404, 'Taluka not found');
    /* The district it is in may have been switched off since; a new one must be active. */
    await patch(admin, `/districts/${nashik}`, { is_active: false });
    expect((await patch(admin, path, { district_id: nashik, name: 'Haveli Again' })).status).toBe(200);
    refused(await patch(admin, `/talukas/${other.id}`, { district_id: nashik }), 400, 'The selected district is inactive');
  });

  it('is neither deleted nor moved while a center uses it', async () => {
    const taluka = await addTaluka(pune, 'Haveli');
    const path = `/talukas/${taluka.id}`;
    const first = await makeCentreIn(pune, taluka.id);
    expect((await rowsOf('/talukas'))[0]).toMatchObject({ in_use: true });
    refused(
      await del(admin, path),
      409,
      'This taluka cannot be deleted while 1 center references it. Deactivate it instead, or remove those records first.',
    );
    const second = await makeCentreIn(pune, taluka.id);
    refused(
      await del(admin, path),
      409,
      'This taluka cannot be deleted while 2 centers reference it. Deactivate it instead, or remove those records first.',
    );
    refused(
      await patch(admin, path, { district_id: nashik }),
      409,
      'This taluka cannot move to another district while 2 centers reference it. Re-point those records first.',
    );
    /* Everything else of it changes. */
    expect((await patch(admin, path, { name: 'Haveli City', is_active: false, district_id: pune })).status).toBe(200);
    for (const id of [first, second]) await remove('centres', 'id', id);
    expect((await rowsOf('/talukas'))[0]).toMatchObject({ in_use: false });
    const res = await del(admin, path);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Taluka deleted', data: null });
    expect(await stored('talukas', taluka.id)).toEqual({ is_active: false, deleted: true });
    refused(await del(admin, path), 404, 'Taluka not found');
    await addTaluka(pune, 'Haveli City');
  });

  it('is not left in a district that is being deleted', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await emptyDistrict(`Place ${'ABCDE'[i]}`);
      const [deleted, added] = await Promise.all([
        del(admin, `/districts/${id}`),
        post(admin, '/talukas', { district_id: id, name: 'New Taluka' }),
      ]);
      expect([deleted.status, added.status]).toEqual(deleted.status === 200 ? [200, 400] : [409, 201]);
    }
  });

  it('is recorded with the panel user, without names', async () => {
    const { id } = await addTaluka(pune, 'Haveli');
    await patch(admin, `/talukas/${id}`, { code: 'HV' });
    await del(admin, `/talukas/${id}`);
    expect(await audits('edp.taluka.%')).toEqual(
      [
        { action: 'edp.taluka.create', details: { district_id: pune } },
        { action: 'edp.taluka.update', details: { fields: ['code'] } },
        { action: 'edp.taluka.delete', details: null },
      ].map((e) => ({ ...e, resource: 'taluka', resource_id: id, actor_kind: 'PANEL', actor_id: admin.id })),
    );
  });
});

/* ----------------------------------------------------------------------------------------------------- the public lists */

describe('geography, without a token', () => {
  const list = async (path: string) => {
    const res = await request('get', path);
    expect(res.status).toBe(200);
    return res.body.data as { id: string; name: string; code: string | null }[];
  };

  it('lists the active states, the active districts of a state and the active talukas of a district', async () => {
    const goa = await addState('Goa', 'GA');
    await addState('Off', 'OF', { is_active: false });
    const pune = await districtId('PUN');
    const haveli = await addTaluka(pune, 'Haveli', { code: 'HVL' });
    await addTaluka(pune, 'Baramati', { is_active: false });
    const maval = await addTaluka(pune, 'Maval');
    expect(await list('/geography/states')).toEqual([
      { id: goa.id, name: 'Goa', code: 'GA' },
      { id: maharashtra, name: 'Maharashtra', code: 'MH' },
    ]);
    await patch(admin, `/districts/${await districtId('AHL')}`, { is_active: false });
    const districts = await list(`/geography/states/${maharashtra}/districts`);
    expect(districts).toHaveLength(35);
    expect(districts[0]).toEqual({ id: await districtId('AKO'), name: 'Akola', code: 'AKO', stateId: maharashtra });
    expect(districts.map((d) => d.name)).toEqual([...districts.map((d) => d.name)].sort((a, b) => a.localeCompare(b, 'en')));
    expect(await list(`/geography/states/${goa.id}/districts`)).toEqual([]);
    expect(await list(`/geography/districts/${pune}/talukas`)).toEqual([
      { id: haveli.id, name: 'Haveli', code: 'HVL', districtId: pune },
      { id: maval.id, name: 'Maval', code: null, districtId: pune },
    ]);
  });

  it('an inactive parent still lists its own; a deleted one does not exist', async () => {
    await patch(admin, `/states/${maharashtra}`, { is_active: false });
    expect(await list('/geography/states')).toEqual([]);
    expect(await list(`/geography/states/${maharashtra}/districts`)).toHaveLength(36);
    await patch(admin, `/states/${maharashtra}`, { is_active: true });
    const goa = await addState('Goa', 'GA');
    await del(admin, `/states/${goa.id}`);
    refused(await request('get', `/geography/states/${goa.id}/districts`), 404, 'State not found');
    const id = await emptyDistrict();
    await patch(admin, `/districts/${id}`, { is_active: false });
    expect(await list(`/geography/districts/${id}/talukas`)).toEqual([]);
    await del(admin, `/districts/${id}`);
    refused(await request('get', `/geography/districts/${id}/talukas`), 404, 'District not found');
  });
});

it('a district of a batch made in the panel is held', async () => {
  await makeBatch({ centre: await makeCentre(), by: admin });
  refused(
    await del(admin, `/districts/${await districtId()}`),
    409,
    'This district cannot be deleted while 1 center and 1 batch reference it. Deactivate it instead.',
  );
});
