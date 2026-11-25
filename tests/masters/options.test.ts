import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { checkForm } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { formValues, makeApplication, makeCentre, makePanelUser, optionId, type TestPanelUser } from '../helpers/factory';
import { audits, del, get, issues, NOBODY, oneOf, patch, post, refused, stored } from './helpers';

interface Choice {
  id: string;
  value: string;
  code: string;
  name_en: string;
  name_mr: string | null;
  order: number;
  is_active: boolean;
  is_system: boolean;
  in_use: boolean;
}

let admin: TestPanelUser;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
});
afterAll(closeDatabase);

const FIXED = 'This list is fixed: its entries can be renamed and switched on or off, not added or deleted.';
const list = (kind: string) => `/masters/${encodeURIComponent(kind)}`;
const choices = async (kind: string, query: Record<string, string | number> = {}) =>
  (await get(admin, list(kind), { limit: 100, ...query })).body.data as Choice[];
const choice = async (kind: string, code: string) => (await choices(kind)).find((c) => c.code === code)!;
const add = async (kind: string, body: object) => {
  const res = await post(admin, list(kind), body);
  expect(res.status).toBe(201);
  return res.body.data as Choice;
};

describe('GET /manage/masters', () => {
  it('lists the lists of the form, in order, with how many entries each has', async () => {
    const res = await get(admin, '/masters');
    expect(res.status).toBe(200);
    const kinds = res.body.data as { kind: string; name: string }[];
    expect(kinds.map((k) => [k.kind, k.name])).toEqual([
      ['CASTE', 'Caste'],
      ['EDUCATION', 'Education Qualification'],
      ['REGION', 'Course District'],
      ['RELIGION', 'Religion'],
      ['GENDER', 'Gender'],
      ['MARITAL_STATUS', 'Marital Status'],
      ['EDUCATIONAL_STATUS', 'Educational Status'],
      ['GRADING_TYPE', 'Grading Type'],
      ['CGPA_SCALE', 'CGPA Scale'],
      ['QUALIFICATION_CLASS', 'Class / Division'],
      ['TECHNOLOGY', 'Technology'],
    ]);
    expect(kinds.find((k) => k.kind === 'GENDER')).toEqual({
      kind: 'GENDER',
      name: 'Gender',
      count: 3,
      active: 3,
      can_add: true,
      can_delete: true,
      stored_as: 'code',
    });
    expect(kinds.filter((k) => 'stored_as' in k && k.stored_as === 'master').map((k) => k.kind)).toEqual([
      'CASTE',
      'EDUCATION',
      'REGION',
    ]);
    expect(kinds.find((k) => k.kind === 'GRADING_TYPE')).toMatchObject({ can_add: false, can_delete: false, count: 2 });
  });

  it('counts the switched-off ones apart, leaves the deleted ones out, and follows the name of the field', async () => {
    const male = await choice('GENDER', 'Male');
    const female = await choice('GENDER', 'Female');
    await patch(admin, `${list('GENDER')}/${male.id}`, { is_active: false });
    await del(admin, `${list('GENDER')}/${female.id}`);
    const field = ((await get(admin, '/fields')).body.data as { id: string; key: string }[]).find((f) => f.key === 'gender')!;
    await patch(admin, `/fields/${field.id}`, { label_en: 'Sex' });
    const kinds = (await get(admin, '/masters')).body.data as { kind: string }[];
    expect(kinds.find((k) => k.kind === 'GENDER')).toMatchObject({ name: 'Sex', count: 2, active: 1 });
  });
});

describe('GET /manage/masters/:kind', () => {
  it('lists the choices in order', async () => {
    const res = await get(admin, list('GENDER'));
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 3, totalPages: 1 });
    expect(res.body.data).toEqual([
      expect.objectContaining({ code: 'Male' }),
      {
        id: expect.any(String),
        value: 'Female',
        code: 'Female',
        name_en: 'Female',
        name_mr: 'स्त्री',
        order: 20,
        is_active: true,
        is_system: false,
        in_use: false,
      },
      expect.objectContaining({ code: 'Transgender' }),
    ]);
    expect((await choices('GRADING_TYPE')).every((c) => c.is_system)).toBe(true);
    /* A form stores the id of a caste, education or region, and the code of anything else. */
    for (const c of await choices('CASTE')) expect(c.value).toBe(c.id);
    for (const c of await choices('TECHNOLOGY')) expect(c.value).toBe(c.code);
  });

  it('searches names and codes literally, filters by status, sorts and pages', async () => {
    const codes = async (query: Record<string, string | number>) => (await choices('GENDER', query)).map((c) => c.code);
    expect(await codes({ search: ' FEM ' })).toEqual(['Female']);
    expect(await codes({ search: 'स्त्री' })).toEqual(['Female']);
    expect(await codes({ search: '%' })).toEqual([]);
    expect((await choices('CASTE', { search: 'sar02' })).map((c) => c.name_en)).toEqual(['Maratha-Kunbi']);
    await patch(admin, `${list('GENDER')}/${(await choice('GENDER', 'Male')).id}`, { is_active: false });
    expect(await codes({ status: 'INACTIVE' })).toEqual(['Male']);
    expect(await codes({ status: 'ACTIVE' })).toEqual(['Female', 'Transgender']);
    expect(await codes({ status: '', search: '' })).toEqual(['Male', 'Female', 'Transgender']);
    expect(await codes({ sortBy: 'name' })).toEqual(['Female', 'Male', 'Transgender']);
    expect(await codes({ sortBy: 'name', sortOrder: 'desc' })).toEqual(['Transgender', 'Male', 'Female']);
    expect(await codes({ limit: 2, page: 2 })).toEqual(['Transgender']);
    /* A page after the last one says so, with the right total: the panel then goes to the last page. */
    const beyond = await get(admin, list('GENDER'), { limit: 2, page: 9 });
    expect(beyond.body).toMatchObject({ data: [], meta: { page: 9, limit: 2, total: 3, totalPages: 2 } });
    /* Equal orders: by English name. */
    for (const c of await choices('GENDER')) await patch(admin, `${list('GENDER')}/${c.id}`, { order: 1 });
    expect(await codes({})).toEqual(['Female', 'Male', 'Transgender']);
  });

  it('refuses lists that do not exist and queries it does not know', async () => {
    for (const kind of ['COLOURS', 'FIELD:x_none']) refused(await get(admin, list(kind)), 404, 'List not found');
    for (const kind of ['gender', 'FIELD:gender', 'FIELD:', 'A__B'])
      expect(issues(await get(admin, list(kind)))).toEqual({ 'params.kind': 'Unknown list' });
    for (const res of [
      await post(admin, list('COLOURS'), { name_en: 'Red' }),
      await patch(admin, `${list('COLOURS')}/${NOBODY}`, { name_en: 'Red' }),
      await del(admin, `${list('COLOURS')}/${NOBODY}`),
    ])
      refused(res, 404, 'List not found');
    expect(issues(await get(admin, list('GENDER'), { status: 'OFF' }))).toEqual({ 'query.status': 'Choose Active or Inactive' });
    const wrong: Record<string, string | number>[] = [
      { limit: 101 },
      { limit: 0 },
      { page: 0 },
      { sortBy: 'code' },
      { search: 'x'.repeat(101) },
      { search: 'a\u0000b' },
    ];
    for (const query of wrong) expect(Object.keys(issues(await get(admin, list('GENDER'), query)))).toHaveLength(1);
    expect((await get(admin, list('GENDER'), { limit: 100 })).body.meta.limit).toBe(100);
  });
});

describe('POST /manage/masters/:kind', () => {
  it('adds a choice at the end, or where asked', async () => {
    const res = await post(admin, list('GENDER'), { name_en: '  Non   binary ', name_mr: 'नॉन बायनरी' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, status: 201, message: 'Added' });
    expect(res.body.data).toEqual({
      id: expect.any(String),
      value: 'Non binary',
      code: 'Non binary',
      name_en: 'Non binary',
      name_mr: 'नॉन बायनरी',
      order: 40,
      is_active: true,
      is_system: false,
      in_use: false,
    });
    expect((await loadProgram()).options('GENDER').map((o) => o.code)).toEqual(['Male', 'Female', 'Transgender', 'Non binary']);
    expect(await add('GENDER', { name_en: 'First', name_mr: ' ', order: 5, is_active: false })).toMatchObject({
      name_mr: null,
      order: 5,
      is_active: false,
    });
    expect((await choices('GENDER'))[0]!.name_en).toBe('First');
    /* At the end there is always room. */
    await add('GENDER', { name_en: 'Last', order: 9999 });
    expect((await add('GENDER', { name_en: 'After the last' })).order).toBe(9999);
    /* Composed, so the same Marathi or accented text is always the same. */
    expect((await add('GENDER', { name_en: 'Résumé' })).name_en).toBe('Résumé');
  });

  it('says what is wrong, field by field', async () => {
    const bad = async (body: object, kind = 'GENDER') => issues(await post(admin, list(kind), body));
    expect(await bad({})).toEqual({ 'body.name_en': 'Name is required' });
    expect(await bad({ name_en: '   ' })).toEqual({ 'body.name_en': 'Name is required' });
    expect(await bad({ name_en: 5 })).toEqual({ 'body.name_en': 'Name must be text' });
    expect(await bad({ name_en: 'x'.repeat(151), name_mr: 'x'.repeat(151), order: 10_000 })).toEqual({
      'body.name_en': 'Name must be at most 150 characters',
      'body.name_mr': 'Marathi name must be at most 150 characters',
      'body.order': 'Order must be at most 9999',
    });
    expect(await bad({ name_en: 'a\u0000b' })).toEqual({ 'body.name_en': 'Name contains characters that cannot be saved' });
    for (const [order, message] of [
      ['5', 'Order must be a number'],
      [1.5, 'Order must be a whole number'],
      [-1, 'Order must be 0 or more'],
    ])
      expect(await bad({ name_en: 'X', order })).toEqual({ 'body.order': message });
    expect(await bad({ name_en: 'X', is_active: 'yes' })).toEqual({ 'body.is_active': 'is_active must be true or false' });
    expect(await bad({ name_en: 'X', code: 'Y' })).toEqual({ 'body.code': 'Unknown field' });
    for (const name_en of ['ten', '0', '101', '7.5', '07'])
      expect(await bad({ name_en }, 'CGPA_SCALE')).toEqual({ 'body.name_en': 'Enter the scale as a whole number from 1 to 100' });
    expect((await choices('GENDER')).length).toBe(3);
  });

  it('refuses a name that is in the list, and additions to a fixed list', async () => {
    refused(await post(admin, list('GENDER'), { name_en: 'fEMALE ' }), 409, '"fEMALE" is already in this list.');
    refused(await post(admin, list('CGPA_SCALE'), { name_en: '10' }), 409, '"10" is already in this list.');
    refused(await post(admin, list('GRADING_TYPE'), { name_en: 'Grade points' }), 409, FIXED);
    /* The same name in another list is another choice. */
    await add('MARITAL_STATUS', { name_en: 'Female' });
  });

  it('a choice keeps its code; a code that is taken gets a number', async () => {
    const first = await add('GENDER', { name_en: 'Other' });
    await patch(admin, `${list('GENDER')}/${first.id}`, { name_en: 'Anything else' });
    expect((await add('GENDER', { name_en: 'Other' })).value).toBe('Other (2)');
    /* The code of a deleted choice is free again: the same name stands for the same value. */
    await del(admin, `${list('GENDER')}/${first.id}`);
    await patch(admin, `${list('GENDER')}/${(await choice('GENDER', 'Other (2)')).id}`, { name_en: 'Third' });
    expect((await add('GENDER', { name_en: 'Other' })).value).toBe('Other');

    /* The longest names: the code is cut, and stays unique. */
    const long = 'n'.repeat(149);
    const a = await add('QUALIFICATION_CLASS', { name_en: `${long}a` });
    const b = await add('QUALIFICATION_CLASS', { name_en: `${long}b` });
    expect([a.code, b.code]).toEqual(['n'.repeat(120), `${'n'.repeat(116)} (2)`]);
    expect(a.name_en).toHaveLength(150);

    /* A scale's code is its number; renamed, the number stays. */
    const scale = await add('CGPA_SCALE', { name_en: '7' });
    expect(scale.value).toBe('7');
    expect((await patch(admin, `${list('CGPA_SCALE')}/${scale.id}`, { name_en: 'Seven' })).body.data).toMatchObject({
      value: '7',
      name_en: 'Seven',
    });
    refused(await post(admin, list('CGPA_SCALE'), { name_en: '7' }), 409, '"7" is already in this list.');
  });

  it('a technology gets the next T number, and a deleted one is never given again', async () => {
    const added = await add('TECHNOLOGY', { name_en: 'Drone Technology' });
    expect(added).toMatchObject({ value: 'T13', code: 'T13', order: 130 });
    await del(admin, `${list('TECHNOLOGY')}/${added.id}`);
    expect((await add('TECHNOLOGY', { name_en: 'Drone Technology' })).code).toBe('T14');
    await pool.query(`UPDATE program_options SET code = 'T99' WHERE kind = 'TECHNOLOGY' AND code = 'T14'`);
    expect((await add('TECHNOLOGY', { name_en: 'Robotics' })).code).toBe('T100');
  });

  it('of two of the same name at the same time one is added; two technologies get two codes', async () => {
    const two = (kind: string, a: object, b: object) => Promise.all([post(admin, list(kind), a), post(admin, list(kind), b)]);
    oneOf(
      201,
      await two('GENDER', { name_en: 'Same' }, { name_en: 'same' }),
      409,
      expect.stringMatching(/^"same" is already in this list\.$/i) as string,
    );
    oneOf(201, await two('CASTE', { name_en: 'Same' }, { name_en: 'Same' }), 409, '"Same" is already in this list.');
    const both = await two('TECHNOLOGY', { name_en: 'Robotics' }, { name_en: 'Drones' });
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(both.map((r) => r.body.data.code).sort()).toEqual(['T13', 'T14']);
    expect(both.map((r) => r.body.data.order).sort()).toEqual([130, 140]);
  });
});

describe('castes, educations and regions: a form stores the id', () => {
  it('a new one gets a code of its own; deleted and added again, it is the same row', async () => {
    const caste = await add('CASTE', { name_en: 'Test Caste', name_mr: 'चाचणी जात' });
    expect(caste).toMatchObject({ code: 'IPP_C1', value: caste.id, order: 40 });
    expect((await add('EDUCATION', { name_en: 'Ph.D.' })).code).toBe('IPP_E1');
    expect((await add('REGION', { name_en: 'Goa' })).code).toBe('IPP_R1');
    await del(admin, `${list('CASTE')}/${caste.id}`);
    expect((await add('CASTE', { name_en: 'Another', name_mr: 'दुसरी' })).code).toBe('IPP_C2');
    /* Found by its Marathi name, which is a caste's own; it takes the new English one and goes to the end. */
    const again = await add('CASTE', { name_en: 'Renamed Caste', name_mr: 'चाचणी जात', is_active: false });
    expect(again).toEqual({ ...caste, name_en: 'Renamed Caste', order: 50, is_active: false });
    expect(await stored('program_options', caste.id)).toEqual({ is_active: false, deleted: false });

    const bca = await choice('EDUCATION', 'BCA');
    await del(admin, `${list('EDUCATION')}/${bca.id}`);
    expect((await choices('EDUCATION')).map((c) => c.id)).not.toContain(bca.id);
    expect(await add('EDUCATION', { name_en: 'bca' })).toMatchObject({
      id: bca.id,
      value: bca.id,
      name_en: 'bca',
      is_active: true,
    });
  });

  it('given only in English, a caste is found by its English name and keeps its Marathi one', async () => {
    const caste = await choice('CASTE', 'SAR02');
    await del(admin, `${list('CASTE')}/${caste.id}`);
    expect(await add('CASTE', { name_en: 'maratha-kunbi' })).toMatchObject({ value: caste.id, name_mr: 'मराठा-कुणबी' });
    /* Another Marathi name is another caste. */
    await del(admin, `${list('CASTE')}/${caste.id}`);
    expect((await add('CASTE', { name_en: 'Maratha-Kunbi', name_mr: 'दुसरी जात' })).value).not.toBe(caste.value);
  });

  it('a caste already in the list under another English name is not added twice', async () => {
    refused(
      await post(admin, list('CASTE'), { name_en: 'Somebody', name_mr: 'मराठा' }),
      409,
      '"मराठा" is already in this list as "Maratha".',
    );
    refused(await post(admin, list('CASTE'), { name_en: 'maratha', name_mr: 'काही' }), 409, '"maratha" is already in this list.');
    /* A renamed region is another one: the name it had may be added. */
    const pune = await choice('REGION', 'PUN');
    await patch(admin, `${list('REGION')}/${pune.id}`, { name_en: 'Pune City' });
    expect((await add('REGION', { name_en: 'Pune' })).value).not.toBe(pune.value);
  });
});

describe('PATCH /manage/masters/:kind/:id', () => {
  it('renames, orders and switches a choice; what a form stores stays', async () => {
    const female = await choice('GENDER', 'Female');
    const path = `${list('GENDER')}/${female.id}`;
    const renamed = await patch(admin, path, { name_en: ' Woman ', name_mr: '', order: 5 });
    expect(renamed.status).toBe(200);
    expect(renamed.body.message).toBe('Saved');
    expect(renamed.body.data).toEqual({ ...female, name_en: 'Woman', name_mr: null, order: 5 });
    expect((await patch(admin, path, { name_mr: 'महिला' })).body.data.name_mr).toBe('महिला');
    expect((await patch(admin, path, { name_mr: null })).body.data.name_mr).toBe(null);
    /* Nothing else changes with the switch. */
    expect((await patch(admin, path, { is_active: false })).body.data).toEqual({
      ...female,
      name_en: 'Woman',
      name_mr: null,
      order: 5,
      is_active: false,
    });
    /* The name it has, in other letters. */
    expect((await patch(admin, path, { name_en: 'WOMAN' })).status).toBe(200);
    const program = await loadProgram();
    expect(program.options('GENDER').map((o) => o.code)).toEqual(['Male', 'Transgender']);
    expect(program.optionName('GENDER', 'Female')).toBe('WOMAN');
    /* A fixed list's entries too. */
    const percentage = await choice('GRADING_TYPE', 'PERCENTAGE');
    expect((await patch(admin, `${list('GRADING_TYPE')}/${percentage.id}`, { name_en: 'Percent' })).body.data).toMatchObject({
      code: 'PERCENTAGE',
      name_en: 'Percent',
      is_system: true,
    });
  });

  it('refuses a name that is taken, an empty change and what cannot be changed', async () => {
    const path = `${list('GENDER')}/${await optionId('GENDER', 'Male')}`;
    refused(await patch(admin, path, { name_en: 'FEMALE' }), 409, '"FEMALE" is already in this list.');
    expect(issues(await patch(admin, path, {}))).toEqual({ body: 'Nothing to change' });
    expect(issues(await patch(admin, path, { name_en: '' }))).toEqual({ 'body.name_en': 'Name is required' });
    expect(issues(await patch(admin, path, { order: 1, code: 'M', is_system: true }))).toEqual({
      'body.code': 'Unknown field',
      'body.is_system': 'Unknown field',
    });
    /* A choice of another list, or a deleted one. */
    refused(
      await patch(admin, `${list('GENDER')}/${await optionId('CASTE', 'SAR01')}`, { order: 1 }),
      404,
      'Entry not found in this list',
    );
    await del(admin, path);
    refused(await patch(admin, path, { order: 1 }), 404, 'Entry not found in this list');
    /* The name of a deleted one is free. */
    const other = `${list('GENDER')}/${await optionId('GENDER', 'Transgender')}`;
    expect((await patch(admin, other, { name_en: 'Male' })).body.data).toMatchObject({ value: 'Transgender', name_en: 'Male' });
  });

  it('of two renames to the same name at the same time one is done', async () => {
    const path = async (code: string) => `${list('GENDER')}/${await optionId('GENDER', code)}`;
    const [a, b] = [await path('Male'), await path('Female')];
    const results = await Promise.all([patch(admin, a, { name_en: 'Same' }), patch(admin, b, { name_en: 'Same' })]);
    oneOf(200, results, 409, '"Same" is already in this list.');
  });
});

describe('DELETE /manage/masters/:kind/:id', () => {
  it('deletes a choice: not offered any more, its name still shown', async () => {
    const id = await optionId('GENDER', 'Transgender');
    const done = await del(admin, `${list('GENDER')}/${id}`);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ success: true, status: 200, message: 'Deleted', data: null });
    expect(await stored('program_options', id)).toEqual({ is_active: false, deleted: true });
    refused(await del(admin, `${list('GENDER')}/${id}`), 404, 'Entry not found in this list');
    const program = await loadProgram();
    expect(program.options('GENDER').map((o) => o.code)).toEqual(['Male', 'Female']);
    expect(program.optionName('GENDER', 'Transgender')).toBe('Transgender');
  });

  it('keeps the entries of a fixed list', async () => {
    const id = await optionId('GRADING_TYPE', 'CGPA');
    refused(await del(admin, `${list('GRADING_TYPE')}/${id}`), 409, FIXED);
    expect(await stored('program_options', id)).toEqual({ is_active: true, deleted: false });
  });
});

describe('a choice and the forms', () => {
  it('in_use: a form that is not deleted holds it, also a draft', async () => {
    const centre = await makeCentre();
    const { applicationId } = await makeApplication('MAIN_DONE', { centre, values: { gender: 'Female', technology: 'T03' } });
    const used = async (kind: string) => (await choices(kind)).filter((c) => c.in_use).map((c) => c.code);
    expect(await used('GENDER')).toEqual(['Female']);
    expect(await used('TECHNOLOGY')).toEqual(['T03']);
    expect(await used('CASTE')).toEqual(['SAR01']);
    expect(await used('EDUCATION')).toEqual(['BCA']);
    expect(await used('REGION')).toEqual(['NAS']);
    expect(await used('RELIGION')).toEqual(['हिंदू']);
    expect(await used('CGPA_SCALE')).toEqual([]);
    /* The same in the answer to a change. */
    const female = await choice('GENDER', 'Female');
    expect((await patch(admin, `${list('GENDER')}/${female.id}`, { order: 21 })).body.data.in_use).toBe(true);
    /* It does not keep it from being deleted. */
    expect((await del(admin, `${list('GENDER')}/${female.id}`)).status).toBe(200);
    expect((await audits('edp.master.delete'))[0]!.details).toEqual({ kind: 'GENDER', in_use: true });
    await pool.query('UPDATE applications SET deleted_at = now() WHERE id = $1', [applicationId]);
    expect(await used('TECHNOLOGY')).toEqual([]);
    expect(await used('CASTE')).toEqual([]);
  });

  it('is found with the same number of queries for one choice and for a page of them', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      const queries = async (limit: number) => {
        spy.mockClear();
        await get(admin, list('REGION'), { limit });
        return spy.mock.calls.length;
      };
      expect(await queries(36)).toBe(await queries(1));
    } finally {
      spy.mockRestore();
    }
  });

  it('only active choices are accepted; one that is switched off or deleted is not', async () => {
    const centre = await makeCentre();
    const values = await formValues(centre);
    const errors = async () =>
      (await checkForm(await loadProgram(), values, { step: 1 })).errors.filter(
        (e) => e.field !== 'body.aadhaar_number' && e.field !== 'body.email',
      );
    expect(await errors()).toEqual([]);
    await patch(admin, `${list('GENDER')}/${await optionId('GENDER', 'Female')}`, { is_active: false });
    await del(admin, `${list('CASTE')}/${await optionId('CASTE', 'SAR01')}`);
    expect(await errors()).toEqual([
      { field: 'body.caste_id', message: 'Caste not found or inactive' },
      { field: 'body.gender', message: 'Select a valid Gender' },
    ]);
    /* Added again, the caste is the one the form holds. */
    await add('CASTE', { name_en: 'Maratha', name_mr: 'मराठा' });
    expect(await errors()).toEqual([{ field: 'body.gender', message: 'Select a valid Gender' }]);
  });
});

describe('the audit log', () => {
  it('records every change with the panel user, without names or values', async () => {
    const { id } = await add('RELIGION', { name_en: 'Secret Name', name_mr: 'गुपित' });
    await patch(admin, `${list('RELIGION')}/${id}`, { name_en: 'Other Name', order: 3 });
    await del(admin, `${list('RELIGION')}/${id}`);
    const log = await audits('edp.master.%');
    expect(log).toEqual(
      [
        { action: 'edp.master.create', details: { kind: 'RELIGION' } },
        { action: 'edp.master.update', details: { kind: 'RELIGION', fields: ['name_en', 'order'] } },
        { action: 'edp.master.delete', details: { kind: 'RELIGION', in_use: false } },
      ].map((e) => ({ ...e, resource: 'program_options', resource_id: id, actor_kind: 'PANEL', actor_id: admin.id })),
    );
    /* A refused change leaves no record, and nothing else behind. */
    await post(admin, list('RELIGION'), { name_en: 'Hindu' });
    expect(await audits('edp.master.%')).toHaveLength(3);
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM program_options WHERE kind = 'RELIGION' AND deleted_at IS NULL`))!.n,
    ).toBe(1);
  });
});
