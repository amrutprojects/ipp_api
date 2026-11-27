import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { checkForm } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { districtId, formValues, makeApplication, makeBatch, makePanelUser, type TestPanelUser } from '../helpers/factory';
import { audits, del, get, issues, NOBODY, oneOf, patch, post, refused, stored } from './helpers';

interface Centre {
  id: string;
  name: string;
  code: string;
  districtId: string;
  talukaId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

let admin: TestPanelUser;
let state: string;
let pune: string;
let nashik: string;
let haveli: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  state = (await one<{ id: string }>(`SELECT id FROM states WHERE code = 'MH'`))!.id;
  pune = await districtId('PUN');
  nashik = await districtId('NAS');
  haveli = (await post(admin, '/talukas', { district_id: pune, name: 'Haveli', code: 'HVL' })).body.data.id as string;
});
afterAll(closeDatabase);

let n = 0;
const add = async (over: object = {}) => {
  const res = await post(admin, '/centres', { name: `Center ${++n}`, code: `C-${n}`, districtId: pune, ...over });
  expect(res.status).toBe(201);
  return res.body.data as Centre;
};
const list = async (query: Record<string, string | number> = {}) => (await get(admin, '/centres', query)).body.data as Centre[];
const read = async (id: string) => (await get(admin, `/centres/${id}`)).body.data as Centre;

/* What the Center form sends. */
const full = () => ({
  stateId: state,
  districtId: pune,
  talukaId: haveli,
  name: '21st Century & Co',
  code: 'pun-01',
  address: '12 Test Road\nHaveli',
  pinCode: '411001',
  contactPerson: "Asha D'Test",
  contactNumber: '020 - 2612 3456'.replace(/ - /, '-'),
  email: 'Center@Example.TEST',
  isActive: true,
});
const answer = {
  name: '21st Century & Co',
  code: 'PUN-01',
  stateName: 'Maharashtra',
  stateCode: 'MH',
  stateIsActive: true,
  districtName: 'Pune',
  districtCode: 'PUN',
  districtIsActive: true,
  talukaName: 'Haveli',
  talukaCode: 'HVL',
  talukaIsActive: true,
  address: '12 Test Road\nHaveli',
  pinCode: '411001',
  contactPerson: "Asha D'Test",
  contactNumber: '020-26123456',
  email: 'center@example.test',
  technologies: [],
  isActive: true,
};

describe('POST /manage/centres', () => {
  it('adds a center with everything, and with only what is required', async () => {
    const res = await post(admin, '/centres', full());
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Center created successfully');
    expect(res.body.data).toEqual({
      ...answer,
      id: expect.any(String),
      stateId: state,
      districtId: pune,
      talukaId: haveli,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    expect(await read(res.body.data.id)).toEqual(res.body.data);
    expect(await add({ name: 'Small  Center', isActive: false, address: ' ', email: null })).toMatchObject({
      name: 'Small Center',
      stateId: state,
      talukaId: null,
      talukaName: null,
      talukaCode: null,
      talukaIsActive: null,
      address: null,
      pinCode: null,
      contactPerson: null,
      contactNumber: null,
      email: null,
      isActive: false,
    });
    /* A mobile number, typed with spaces. */
    expect(await add({ contactNumber: '98765 43210' })).toMatchObject({ contactNumber: '9876543210' });
  });

  it('says what is wrong, field by field', async () => {
    const bad = async (over: object) => issues(await post(admin, '/centres', { ...full(), ...over }));
    expect(issues(await post(admin, '/centres', {}))).toEqual({
      'body.districtId': 'District is required',
      'body.name': 'Name is required',
      'body.code': 'Code is required',
    });
    for (const [name, message] of [
      ['x', 'Must be at least 2 characters'],
      ['x'.repeat(151), 'Must be at most 150 characters'],
      ['Center @ home', 'Use letters, digits, spaces and . , ( ) - / & only'],
    ])
      expect(await bad({ name })).toEqual({ 'body.name': message });
    for (const [code, message] of [
      ['P', 'Must be at least 2 characters'],
      ['P'.repeat(21), 'Must be at most 20 characters'],
      ['1PUN', 'Use A–Z, 0–9 and hyphen, starting with a letter'],
    ])
      expect(await bad({ code })).toEqual({ 'body.code': message });
    expect(await bad({ address: 'x'.repeat(301), contactPerson: 'x'.repeat(121) })).toEqual({
      'body.address': 'Must be at most 300 characters',
      'body.contactPerson': 'Must be at most 120 characters',
    });
    expect(await bad({ contactPerson: 'Asha 2' })).toEqual({
      'body.contactPerson': "Contact person may contain only letters, spaces and . ' -",
    });
    expect(await bad({ address: 'a\u0000b' })).toEqual({ 'body.address': 'Contains characters that cannot be saved' });
    for (const pinCode of ['41100', '4110011', 'abcdef', '011001'])
      expect(await bad({ pinCode })).toEqual({ 'body.pinCode': 'Enter a 6-digit PIN code' });
    for (const contactNumber of ['12345', '5876543210', '020-123'])
      expect(await bad({ contactNumber })).toEqual({
        'body.contactNumber': 'Enter a 10-digit mobile number or a landline with STD code',
      });
    for (const email of ['x', `${'x'.repeat(250)}@example.test`])
      expect(await bad({ email })).toEqual({ 'body.email': 'Enter a valid email address' });
    expect(await bad({ districtId: 'x', talukaId: 'y', stateId: 'z', isActive: 'yes' })).toEqual({
      'body.districtId': 'District is not valid',
      'body.talukaId': 'Taluka is not valid',
      'body.stateId': 'State is not valid',
      'body.isActive': 'isActive must be true or false',
    });
    expect(await bad({ technologyCodes: ['T01'] })).toEqual({ 'body.technologyCodes': 'Unknown field' });
    expect(await list()).toEqual([]);
  });

  it('refuses a name that is taken in the district, and a code that is taken anywhere', async () => {
    await add({ name: 'Nashik Road', code: 'NR-1' });
    refused(
      await post(admin, '/centres', { name: 'NASHIK ROAD', code: 'NR-2', districtId: pune }),
      409,
      'A center with this name already exists in the selected district',
    );
    refused(
      await post(admin, '/centres', { name: 'Other', code: 'nr-1', districtId: nashik }),
      409,
      'A center with this code already exists',
    );
    /* Sent twice: the name is said first. */
    refused(
      await post(admin, '/centres', { name: 'Nashik Road', code: 'NR-1', districtId: pune }),
      409,
      'A center with this name already exists in the selected district',
    );
    await add({ name: 'Nashik Road', code: 'NR-2', districtId: nashik });
    const names = await Promise.all(
      ['S-1', 'S-2'].map((code) => post(admin, '/centres', { name: 'Same', code, districtId: pune })),
    );
    oneOf(201, names, 409, 'A center with this name already exists in the selected district');
    const codes = await Promise.all(
      ['One', 'Two'].map((name) => post(admin, '/centres', { name, code: 'SAME', districtId: pune })),
    );
    oneOf(201, codes, 409, 'A center with this code already exists');
  });

  it('is placed in an active district of the state, and an active taluka of the district', async () => {
    const refusal = async (over: object, message: string, detail: { field: string; message: string }) => {
      const res = await post(admin, '/centres', { ...full(), ...over });
      refused(res, 400, message);
      expect(res.body.error.details).toEqual([detail]);
    };
    const goa = (await post(admin, '/states', { name: 'Goa', code: 'GA' })).body.data.id as string;
    await refusal({ stateId: goa }, 'The selected district does not belong to the selected state', {
      field: 'districtId',
      message: 'Choose a district of the selected state',
    });
    await refusal({ districtId: nashik }, 'The selected taluka does not belong to the selected district', {
      field: 'talukaId',
      message: 'Choose a taluka of the selected district',
    });
    await refusal({ districtId: NOBODY }, 'The selected district does not exist', {
      field: 'districtId',
      message: 'Unknown district',
    });
    await refusal({ talukaId: NOBODY }, 'The selected taluka does not exist', { field: 'talukaId', message: 'Unknown taluka' });
    await patch(admin, `/talukas/${haveli}`, { is_active: false });
    await refusal({}, 'The selected taluka is inactive', { field: 'talukaId', message: 'Choose an active taluka' });
    await patch(admin, `/districts/${pune}`, { is_active: false });
    await refusal({}, 'The selected district is inactive', { field: 'districtId', message: 'Choose an active district' });
    expect(await list()).toEqual([]);
  });
});

describe('GET /manage/centres', () => {
  it('lists the centers A to Z; search, filters, sorting and pages', async () => {
    const b = await add({ name: 'beta', code: 'ZZ', talukaId: haveli });
    const a = await add({ name: 'Alpha', code: 'MM', districtId: nashik });
    const c = await add({ name: 'Gamma', code: 'AA', isActive: false });
    const res = await get(admin, '/centres');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Centers retrieved successfully');
    expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 3, totalPages: 1 });
    expect(res.body.data.map((x: Centre) => x.id)).toEqual([a.id, b.id, c.id]);
    /* The rows are the whole center. */
    expect(res.body.data[1]).toEqual(await read(b.id));
    expect(res.body.data[1]).toMatchObject({ talukaId: haveli, talukaName: 'Haveli', districtId: pune, districtName: 'Pune' });
    const names = async (query: Record<string, string | number>) => (await list(query)).map((x) => x.name);
    expect(await names({ isActive: 'true' })).toEqual(['Alpha', 'beta']);
    expect(await names({ isActive: 'false' })).toEqual(['Gamma']);
    expect(await names({ districtId: pune })).toEqual(['beta', 'Gamma']);
    expect(await names({ stateId: state, districtId: nashik })).toEqual(['Alpha']);
    expect(await names({ search: 'nashik' })).toEqual(['Alpha']);
    expect(await names({ search: 'zz' })).toEqual(['beta']);
    expect(await names({ search: 'GAM' })).toEqual(['Gamma']);
    expect(await names({ search: '%' })).toEqual([]);
    expect(await names({ isActive: '', search: '', districtId: '' })).toEqual(['Alpha', 'beta', 'Gamma']);
    expect(await names({ sortBy: 'code' })).toEqual(['Gamma', 'Alpha', 'beta']);
    expect(await names({ sortBy: 'name', sortOrder: 'DESC' })).toEqual(['Gamma', 'beta', 'Alpha']);
    expect((await names({ sortBy: 'districtName' }))[0]).toBe('Alpha');
    expect(await names({ sortBy: 'createdAt' })).toEqual(['beta', 'Alpha', 'Gamma']);
    await patch(admin, `/centres/${b.id}/status`, { isActive: true });
    expect((await names({ sortBy: 'updatedAt', sortOrder: 'desc' }))[0]).toBe('beta');
    expect(await names({ limit: 2, page: 2 })).toEqual(['Gamma']);
    /* As Create batch asks. */
    expect(await names({ page: 1, limit: 100, isActive: 'true', sortBy: 'name', sortOrder: 'ASC' })).toEqual(['Alpha', 'beta']);
    expect((await get(admin, '/centres', { limit: 2, page: 7 })).body).toMatchObject({
      data: [],
      meta: { page: 7, limit: 2, total: 3, totalPages: 2 },
    });
    expect(
      Object.keys(issues(await get(admin, '/centres', { isActive: 'yes', sortBy: 'email', districtId: 'x', limit: 101 }))).sort(),
    ).toEqual(['query.districtId', 'query.isActive', 'query.limit', 'query.sortBy']);
    const unknown = await get(admin, '/centres', { districtId: NOBODY });
    refused(unknown, 400, 'The selected district does not exist');
    expect(unknown.body.error.details).toEqual([{ field: 'districtId', message: 'Unknown district' }]);
    refused(await get(admin, '/centres', { stateId: NOBODY }), 400, 'The selected state does not exist');
  });

  it('shows a parent that was switched off', async () => {
    const { id } = await add({ talukaId: haveli });
    await patch(admin, `/talukas/${haveli}`, { is_active: false });
    await patch(admin, `/districts/${pune}`, { is_active: false });
    await patch(admin, `/states/${state}`, { is_active: false });
    expect(await read(id)).toMatchObject({
      talukaName: 'Haveli',
      talukaIsActive: false,
      districtName: 'Pune',
      districtIsActive: false,
      stateIsActive: false,
    });
  });
});

describe('PATCH /manage/centres/:id', () => {
  /* What the Center form sends on Edit: everything, blank ones as null. */
  const form = (c: Centre, over: object = {}) => ({
    stateId: state,
    districtId: c.districtId,
    talukaId: c.talukaId,
    name: c.name,
    code: c.code,
    address: null,
    pinCode: null,
    contactPerson: null,
    contactNumber: null,
    email: null,
    ...over,
  });

  it('changes what is sent, clears what is null, and leaves the rest', async () => {
    const created = (await post(admin, '/centres', full())).body.data as Centre;
    const path = `/centres/${created.id}`;
    const res = await patch(admin, path, { name: 'New Name', code: 'new-1' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Center updated successfully');
    expect(res.body.data).toEqual({ ...created, name: 'New Name', code: 'NEW-1', updatedAt: expect.any(String) });
    expect(res.body.data.updatedAt > created.updatedAt).toBe(true);
    expect((await patch(admin, path, { address: '', email: null })).body.data).toMatchObject({
      address: null,
      email: null,
      pinCode: '411001',
    });
    /* As the form sends it, unchanged but for the cleared values. */
    expect((await patch(admin, path, form(res.body.data as Centre))).body.data).toMatchObject({
      name: 'New Name',
      talukaId: haveli,
      pinCode: null,
      contactPerson: null,
      contactNumber: null,
    });
    expect(await read(created.id)).toMatchObject({ name: 'New Name', isActive: true });
  });

  it('refuses an empty change, the status, wrong values and what is taken or does not exist', async () => {
    const a = await add({ name: 'First', code: 'F-1' });
    await add({ name: 'Second', code: 'S-1' });
    const path = `/centres/${a.id}`;
    expect(issues(await patch(admin, path, {}))).toEqual({ body: 'Provide at least one field to update' });
    expect(issues(await patch(admin, path, { isActive: false, name: 'x' }))).toEqual({
      'body.isActive': 'Unknown field',
      'body.name': 'Must be at least 2 characters',
    });
    expect(issues(await patch(admin, path, { districtId: null, code: '' }))).toEqual({
      'body.districtId': 'District must be text',
      'body.code': 'Must be at least 2 characters',
    });
    refused(await patch(admin, path, { name: 'SECOND' }), 409, 'A center with this name already exists in the selected district');
    refused(await patch(admin, path, { code: 's-1' }), 409, 'A center with this code already exists');
    /* Its own name and code, in other letters. */
    expect((await patch(admin, path, { name: 'FIRST', code: 'f-1' })).status).toBe(200);
    refused(await patch(admin, `/centres/${NOBODY}`, { name: 'Third' }), 404, 'Center not found');
  });

  it('moves to another district with a taluka of it, or none', async () => {
    const centre = await add({ talukaId: haveli });
    const path = `/centres/${centre.id}`;
    const sinnar = (await post(admin, '/talukas', { district_id: nashik, name: 'Sinnar' })).body.data.id as string;
    const needed = await patch(admin, path, { districtId: nashik });
    refused(needed, 400, 'Choose a taluka of the new district, or none, when moving the center');
    expect(needed.body.error.details).toEqual([
      { field: 'talukaId', message: 'Choose a taluka of the selected district, or none' },
    ]);
    refused(
      await patch(admin, path, { districtId: nashik, talukaId: haveli }),
      400,
      'The selected taluka does not belong to the selected district',
    );
    refused(await patch(admin, path, { talukaId: sinnar }), 400, 'The selected taluka does not belong to the selected district');
    expect((await patch(admin, path, { districtId: nashik, talukaId: sinnar })).body.data).toMatchObject({
      districtId: nashik,
      districtName: 'Nashik',
      talukaId: sinnar,
    });
    expect((await patch(admin, path, { districtId: pune, talukaId: null })).body.data).toMatchObject({
      districtId: pune,
      talukaId: null,
    });
    /* Without a taluka there is none to choose. */
    expect((await patch(admin, path, { districtId: nashik })).body.data.districtId).toBe(nashik);
    const goa = (await post(admin, '/states', { name: 'Goa', code: 'GA' })).body.data.id as string;
    refused(await patch(admin, path, { stateId: goa }), 400, 'The selected district does not belong to the selected state');
    refused(
      await patch(admin, path, { stateId: goa, districtId: pune }),
      400,
      'The selected district does not belong to the selected state',
    );
    refused(await patch(admin, path, { districtId: NOBODY }), 400, 'The selected district does not exist');
    /* The name must be free where it goes. */
    await add({ name: centre.name, code: 'ELSE' });
    refused(
      await patch(admin, path, { districtId: pune }),
      409,
      'A center with this name already exists in the selected district',
    );
  });

  it('a district and taluka that stay are not checked again: they may have been switched off since', async () => {
    const centre = await add({ talukaId: haveli });
    await patch(admin, `/talukas/${haveli}`, { is_active: false });
    await patch(admin, `/districts/${pune}`, { is_active: false });
    const res = await patch(admin, `/centres/${centre.id}`, form(centre, { name: 'Renamed', districtId: pune.toUpperCase() }));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', districtId: pune, talukaId: haveli });
    const other = await add({ districtId: nashik });
    refused(await patch(admin, `/centres/${other.id}`, { districtId: pune }), 400, 'The selected district is inactive');
  });
});

describe('PATCH /manage/centres/:id/status', () => {
  it('activates and deactivates; only an active center is accepted from a student', async () => {
    const { id } = await add();
    await makeApplication('SUBMITTED', { centre: id });
    const values = await formValues(id);
    const errors = async () => (await checkForm(await loadProgram(), values, { step: 2 })).errors;
    expect(await errors()).toEqual([]);
    const off = await patch(admin, `/centres/${id}/status`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.message).toBe('Center set to Inactive');
    expect(off.body.data).toEqual({ ...(await read(id)), isActive: false });
    expect(await errors()).toEqual([{ field: 'body.centre_id', message: 'Center Name not found or inactive' }]);
    const on = await patch(admin, `/centres/${id}/status`, { isActive: true });
    expect(on.body).toMatchObject({ message: 'Center set to Active', data: { id, isActive: true } });
    expect(issues(await patch(admin, `/centres/${id}/status`, {}))).toEqual({ 'body.isActive': 'isActive is required' });
    expect(issues(await patch(admin, `/centres/${id}/status`, { isActive: 'no', name: 'X' }))).toEqual({
      'body.isActive': 'isActive must be true or false',
      'body.name': 'Unknown field',
    });
  });
});

describe('DELETE /manage/centres/:id', () => {
  it('deletes a center nothing uses', async () => {
    const { id, name } = await add({ code: 'ONCE' });
    const res = await del(admin, `/centres/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Center deleted', data: null });
    expect(await stored('centres', id)).toEqual({ is_active: false, deleted: true });
    expect(await list()).toEqual([]);
    for (const gone of [
      await get(admin, `/centres/${id}`),
      await del(admin, `/centres/${id}`),
      await patch(admin, `/centres/${id}`, { name: 'Back' }),
      await patch(admin, `/centres/${id}/status`, { isActive: true }),
    ])
      refused(gone, 404, 'Center not found');
    /* Its name and code are free again. */
    await add({ name, code: 'ONCE' });
  });

  it('keeps a center that students’ forms or batches use, drafts too', async () => {
    const { id } = await add();
    const held = (message: string) => async () => refused(await del(admin, `/centres/${id}`), 409, message);
    const draft = await makeApplication('MAIN_DONE', { centre: id });
    await held("This center cannot be deleted while 1 student's form references it. Set it to Inactive instead.")();
    const batch = await makeBatch({ centre: id, by: admin, district: 'PUN' });
    await held("This center cannot be deleted while 1 student's form and 1 batch reference it. Set it to Inactive instead.")();
    const sent = await makeApplication('SUBMITTED', { centre: id });
    await pool.query('UPDATE applications SET deleted_at = now() WHERE id = $1', [draft.applicationId]);
    await pool.query('UPDATE batches SET deleted_at = now() WHERE id = $1', [batch]);
    await held("This center cannot be deleted while 1 student's form references it. Set it to Inactive instead.")();
    expect(await stored('centres', id)).toEqual({ is_active: true, deleted: false });
    await pool.query('UPDATE applications SET deleted_at = now() WHERE id = $1', [sent.applicationId]);
    expect((await del(admin, `/centres/${id}`)).status).toBe(200);
  });

  it('a taluka is not deleted under a center that is being added', async () => {
    for (let i = 0; i < 5; i++) {
      const taluka = (await post(admin, '/talukas', { district_id: pune, name: `T ${'ABCDE'[i]}` })).body.data.id as string;
      const [deleted, added] = await Promise.all([
        del(admin, `/talukas/${taluka}`),
        post(admin, '/centres', { name: `Race ${i}`, code: `R-${i}`, districtId: pune, talukaId: taluka }),
      ]);
      expect([deleted.status, added.status]).toEqual(deleted.status === 200 ? [200, 400] : [409, 201]);
    }
  });
});

it('every change is recorded with the panel user, without names, addresses or numbers', async () => {
  const { id } = (await post(admin, '/centres', full())).body.data as Centre;
  await patch(admin, `/centres/${id}`, { name: 'Other', contactNumber: null, districtId: nashik, talukaId: null });
  await patch(admin, `/centres/${id}/status`, { isActive: false });
  await del(admin, `/centres/${id}`);
  expect(await audits('cms.centre.%')).toEqual(
    [
      { action: 'cms.centre.create', details: { district_id: pune, taluka_id: haveli } },
      { action: 'cms.centre.update', details: { fields: expect.any(Array), moved: true } },
      { action: 'cms.centre.status', details: { is_active: false } },
      { action: 'cms.centre.delete', details: null },
    ].map((e) => ({ ...e, resource: 'centre', resource_id: id, actor_kind: 'PANEL', actor_id: admin.id })),
  );
  const { fields } = (await audits('cms.centre.update'))[0]!.details as { fields: string[] };
  expect(fields.sort()).toEqual(['contactNumber', 'districtId', 'name', 'talukaId']);
});
