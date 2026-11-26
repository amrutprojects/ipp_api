import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { FIELD_TYPES } from '../../src/program/constants';
import { checkForm } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { formValues, makeApplication, makeCentre, makePanelUser, type TestPanelUser } from '../helpers/factory';
import { audits, del, get, issues, NOBODY, patch, post, refused, stored } from './helpers';

interface Field {
  id: string;
  key: string;
  step: number;
  label_en: string;
  label_mr: string | null;
  required: boolean;
  is_active: boolean;
  order: number;
  custom: boolean;
  by_type: boolean;
  type: string;
  types: string[];
  options_kind: string | null;
  help_en: string | null;
  help_mr: string | null;
  validation: object | null;
}

let admin: TestPanelUser;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
});
afterAll(closeDatabase);

const list = async () => (await get(admin, '/fields')).body.data as Field[];
const field = async (key: string) => (await list()).find((f) => f.key === key)!;
const change = async (key: string, body: object) => patch(admin, `/fields/${(await field(key)).id}`, body);
const add = async (body: object) => {
  const res = await post(admin, '/fields', { step: 1, type: 'TEXT', ...body });
  expect(res.status).toBe(201);
  return res.body.data as Field;
};
/* What step 1 or 2 says about these values (the e-mail and the Aadhaar number are not among the sample's). */
const errors = async (step: 1 | 2, over: Record<string, string> = {}) => {
  const centre = (await one<{ id: string }>('SELECT id FROM centres LIMIT 1'))?.id ?? (await makeCentre());
  const { errors: found } = await checkForm(await loadProgram(), await formValues(centre, over), { step });
  return found.filter((e) => e.field !== 'body.email' && e.field !== 'body.aadhaar_number');
};

describe('GET /manage/fields', () => {
  it('lists the fields by step and order', async () => {
    const all = await list();
    expect(all.filter((f) => f.step === 1).map((f) => f.key)).toEqual([
      'first_name',
      'last_name',
      'father_name',
      'mother_name',
      'email',
      'date_of_birth',
      'current_address',
      'permanent_address',
      'landmark',
      'pin_code',
      'district_id',
      'taluka',
      'aadhaar_number',
      'mobile_number',
      'religion',
      'caste_id',
      'gender',
      'marital_status',
      'alternate_mobile_number',
      'alternate_email',
      'disability_status',
      'disability_type',
      'disability_certificate_number',
    ]);
    expect(all.filter((f) => f.step === 2).map((f) => f.key)).toEqual([
      'region_id',
      'centre_id',
      'technology',
      'education_id',
      'educational_status',
      'qualification_name',
      'qualification_stream',
      'qualification_board',
      'qualification_completed_on',
      'grading_type',
      'cgpa_scale',
      'score',
      'qualification_class',
    ]);
    expect(await field('qualification_board')).toEqual({
      id: expect.any(String),
      key: 'qualification_board',
      step: 2,
      label_en: 'College Name',
      label_mr: 'महाविद्यालयाचे नाव',
      required: true,
      is_active: true,
      order: 80,
      custom: false,
      by_type: false,
      type: 'TEXT',
      types: [...FIELD_TYPES],
      options_kind: null,
      help_en: null,
      help_mr: null,
      /* The checks it starts with, to change in the master like any other. */
      validation: { rules: [{ type: 'max_length', value: 200 }], custom: [] },
      created_at: expect.any(String),
      updated_at: expect.any(String),
      deleted_at: null,
    });
    const kinds = Object.fromEntries(all.map((f) => [f.key, f.options_kind]));
    expect(kinds).toMatchObject({
      technology: 'TECHNOLOGY',
      caste_id: 'CASTE',
      educational_status: 'EDUCATIONAL_STATUS',
      district_id: null,
      centre_id: null,
      disability_status: null,
    });
  });
});

describe('POST /manage/fields', () => {
  it('adds an own field at the end of its step, with a key made from the label', async () => {
    const res = await post(admin, '/fields', {
      step: 1,
      label_en: '  Why this   program? ',
      label_mr: 'का?',
      type: 'TEXTAREA',
      required: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Field added');
    expect(res.body.data).toEqual({
      id: expect.any(String),
      key: 'x_why_this_program',
      step: 1,
      label_en: 'Why this program?',
      label_mr: 'का?',
      required: true,
      is_active: true,
      order: 240,
      custom: true,
      by_type: true,
      type: 'TEXTAREA',
      types: [...FIELD_TYPES],
      options_kind: null,
      help_en: null,
      help_mr: null,
      validation: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      deleted_at: null,
    });
    expect(
      await add({ step: 2, label_en: 'अनुभव', type: 'NUMBER', help_en: 'In years', help_mr: ' ', order: 5, is_active: false }),
    ).toMatchObject({
      key: 'x_field',
      required: false,
      is_active: false,
      order: 5,
      help_en: 'In years',
      help_mr: null,
    });
    /* The slug keeps 36 characters, without a line at its end. */
    expect((await add({ label_en: `${'a'.repeat(35)} bcd` })).key).toBe(`x_${'a'.repeat(35)}`);
    expect((await add({ label_en: 'Résumé (PDF)' })).key).toBe('x_re_sume_pdf');
  });

  it('never gives a key twice, also a deleted one, also to two at the same time', async () => {
    const first = await add({ label_en: 'Blood Group' });
    expect((await add({ label_en: 'Blood group!' })).key).toBe('x_blood_group_2');
    await del(admin, `/fields/${first.id}`);
    expect((await add({ label_en: 'Blood Group' })).key).toBe('x_blood_group_3');
    const many = [1, 2, 3, 4, 5, 6];
    const results = await Promise.all(many.map(() => post(admin, '/fields', { step: 1, label_en: 'Same', type: 'TEXT' })));
    expect(results.map((r) => r.status)).toEqual(many.map(() => 201));
    expect(results.map((r) => r.body.data.key).sort()).toEqual(many.map((i) => (i === 1 ? 'x_same' : `x_same_${i}`)));
    expect(new Set(results.map((r) => r.body.data.order)).size).toBe(many.length);
  });

  it('a dropdown has choices, which are a list of their own', async () => {
    const blood = await add({
      label_en: 'Blood Group',
      type: 'DROPDOWN',
      options: [{ name_en: ' A+ ' }, { name_en: 'B+', name_mr: 'बी पॉझिटिव्ह' }],
    });
    expect(blood).toMatchObject({ key: 'x_blood_group', options_kind: 'FIELD:x_blood_group' });
    const path = `/masters/${encodeURIComponent('FIELD:x_blood_group')}`;
    const choices = async () => (await get(admin, path)).body.data as { id: string; value: string; order: number }[];
    expect(await choices()).toEqual([
      expect.objectContaining({
        value: 'A+',
        code: 'A+',
        name_en: 'A+',
        name_mr: null,
        order: 10,
        is_system: false,
        in_use: false,
      }),
      expect.objectContaining({ value: 'B+', name_mr: 'बी पॉझिटिव्ह', order: 20 }),
    ]);
    const added = await post(admin, path, { name_en: 'O+' });
    expect(added.status).toBe(201);
    expect((await patch(admin, `${path}/${added.body.data.id}`, { name_en: 'O positive' })).body.data).toMatchObject({
      value: 'O+',
      name_en: 'O positive',
    });
    refused(await post(admin, path, { name_en: 'a+' }), 409, '"a+" is already in this list.');
    /* A form holds it. */
    await makeApplication('MAIN_DONE', { centre: await makeCentre(), values: { x_blood_group: 'B+' } });
    expect((await choices()).map((c) => 'in_use' in c && c.in_use)).toEqual([false, true, false]);
    expect(await errors(1, { x_blood_group: 'AB' })).toEqual([
      { field: 'body.x_blood_group', message: 'Select a valid Blood Group' },
    ]);
    expect(await errors(1, { x_blood_group: 'O+' })).toEqual([]);
    /* It is not one of the program's lists. */
    expect(((await get(admin, '/masters')).body.data as unknown[]).length).toBe(11);
  });

  it('says what is wrong, field by field', async () => {
    const bad = async (body: object) => issues(await post(admin, '/fields', { step: 1, label_en: 'X', type: 'TEXT', ...body }));
    expect(issues(await post(admin, '/fields', {}))).toEqual({
      'body.label_en': 'Label is required',
      'body.step': 'Choose step 1 or 2',
      'body.type': 'Choose a type',
    });
    expect(await bad({ label_en: ' ', step: 3, type: 'FILE' })).toEqual({
      'body.label_en': 'Label is required',
      'body.step': 'Choose step 1 or 2',
      'body.type': 'Choose a type',
    });
    expect(
      await bad({ label_en: 'x'.repeat(151), label_mr: 'x'.repeat(151), help_en: 'x'.repeat(301), help_mr: 'x'.repeat(301) }),
    ).toEqual({
      'body.label_en': 'Label must be at most 150 characters',
      'body.label_mr': 'Marathi label must be at most 150 characters',
      'body.help_en': 'Help text must be at most 300 characters',
      'body.help_mr': 'Marathi help text must be at most 300 characters',
    });
    expect(await bad({ required: 1, is_active: null, order: 1.2 })).toEqual({
      'body.required': 'required must be true or false',
      'body.is_active': 'is_active must be true or false',
      'body.order': 'Order must be a whole number',
    });
    expect(await bad({ key: 'x_mine' })).toEqual({ 'body.key': 'Unknown field' });
    expect(await bad({ type: 'DROPDOWN' })).toEqual({ 'body.options': 'Add at least one choice' });
    expect(await bad({ type: 'DROPDOWN', options: [] })).toEqual({ 'body.options': 'Add at least one choice' });
    expect(await bad({ options: [{ name_en: 'A' }] })).toEqual({ 'body.options': 'A field of this type has no choices' });
    expect(await bad({ type: 'DROPDOWN', options: 'A' })).toEqual({ 'body.options': 'Choices must be a list' });
    expect(await bad({ type: 'DROPDOWN', options: [{ name_en: 'A' }, { name_en: ' a ' }] })).toEqual({
      'body.options': 'Each choice may be listed only once',
    });
    expect(await bad({ type: 'DROPDOWN', options: Array.from({ length: 201 }, (_x, i) => ({ name_en: `${i}` })) })).toEqual({
      'body.options': 'At most 200 choices',
    });
    expect(
      await bad({ type: 'DROPDOWN', options: [{ name_en: 'x'.repeat(151) }, { name_en: '' }, { name_en: 'A', code: 'B' }] }),
    ).toEqual({
      'body.options.0.name_en': 'Name must be at most 150 characters',
      'body.options.1.name_en': 'Name is required',
      'body.options.2.code': 'Unknown field',
    });
    expect(await list()).toHaveLength(36);
  });
});

describe('PATCH /manage/fields/:id', () => {
  it('renames a field, gives it help, makes it optional and switches it off; the form and its messages follow', async () => {
    const before = await field('gender');
    const renamed = await change('gender', { label_en: ' Sex ', label_mr: 'लिंग (नवे)', help_en: 'As on the Aadhaar', order: 175 });
    expect(renamed.status).toBe(200);
    expect(renamed.body.message).toBe('Field saved');
    expect(renamed.body.data).toEqual({
      ...before,
      updated_at: expect.any(String),
      label_en: 'Sex',
      label_mr: 'लिंग (नवे)',
      help_en: 'As on the Aadhaar',
      order: 175,
    });
    expect(await errors(1, { gender: '' })).toEqual([{ field: 'body.gender', message: 'Sex is required' }]);
    expect((await change('gender', { label_mr: '', help_en: null })).body.data).toMatchObject({ label_mr: null, help_en: null });

    /* Optional: blank is accepted, a value is still checked. */
    expect((await change('gender', { required: false })).body.data.required).toBe(false);
    expect(await errors(1, { gender: '' })).toEqual([]);
    expect(await errors(1, { gender: 'X' })).toEqual([{ field: 'body.gender', message: 'Select a valid Sex' }]);
    /* Off: neither asked nor checked. */
    expect((await change('gender', { is_active: false, required: true })).body.data).toMatchObject({
      is_active: false,
      required: true,
    });
    expect((await loadProgram()).activeFields().map((f) => f.key)).not.toContain('gender');
    expect(await errors(1, { gender: 'X' })).toEqual([]);
    expect((await change('gender', { is_active: true })).body.data.is_active).toBe(true);
  });

  it('every field of the program is switched off and on, made optional and moved', async () => {
    for (const f of await list()) {
      const other = f.step === 1 ? 2 : 1;
      expect((await change(f.key, { is_active: false, required: !f.required, step: other })).body.data).toEqual({
        ...f,
        updated_at: expect.any(String),
        is_active: false,
        required: !f.required,
        step: other,
      });
    }
    expect((await loadProgram()).activeFields()).toEqual([]);
    expect((await change('first_name', { is_active: true })).body.data.is_active).toBe(true);
  });

  it('of a field of the program everything changes but its key', async () => {
    const father = await field('father_name');
    const changes = {
      label_en: 'Guardian',
      label_mr: 'पालक',
      help_en: 'Any one',
      help_mr: 'आधारप्रमाणे',
      order: 35,
      required: false,
      step: 2,
      type: 'TEXTAREA',
      validation: { rules: [{ type: 'min_length', value: 3 }], custom: [] },
    };
    expect((await change('father_name', changes)).body.data).toEqual({
      ...father,
      ...changes,
      by_type: true,
      updated_at: expect.any(String),
    });
    /* What is sent may repeat what is there. */
    expect((await change('father_name', changes)).status).toBe(200);
  });

  it('of an own field everything changes but its key', async () => {
    const joined = await add({ step: 2, label_en: 'Joining Date', type: 'DATE' });
    expect(
      (await change(joined.key, { step: 1, type: 'TEXT', label_en: 'Joined On', required: true, is_active: false })).body.data,
    ).toMatchObject({
      key: 'x_joining_date',
      step: 1,
      type: 'TEXT',
      label_en: 'Joined On',
      required: true,
      is_active: false,
    });
    /* It becomes a dropdown only with choices. */
    expect(issues(await change(joined.key, { type: 'DROPDOWN' }))).toEqual({ 'body.options': 'Add at least one choice' });
    expect((await field(joined.key)).type).toBe('TEXT');
    expect(issues(await change(joined.key, { options: [{ name_en: 'Now' }] }))).toEqual({
      'body.options': 'A field of this type has no choices',
    });
    expect((await change(joined.key, { type: 'DROPDOWN', options: [{ name_en: 'Now' }] })).body.data.options_kind).toBe(
      'FIELD:x_joining_date',
    );
    /* More choices: only the ones the list does not have yet. */
    expect((await change(joined.key, { options: [{ name_en: 'NOW' }, { name_en: 'Later' }] })).status).toBe(200);
    const path = `/masters/${encodeURIComponent('FIELD:x_joining_date')}`;
    const names = async () => ((await get(admin, path)).body.data as { name_en: string }[]).map((c) => c.name_en);
    expect(await names()).toEqual(['Now', 'Later']);
    expect(issues(await change(joined.key, { type: 'DATE', options: [{ name_en: 'Then' }] }))).toEqual({
      'body.options': 'A field of this type has no choices',
    });
    /* Another type: its choices are kept, and its list is there again with the dropdown. */
    expect((await change(joined.key, { type: 'TEXT' })).body.data.options_kind).toBe(null);
    refused(await get(admin, path), 404, 'List not found');
    expect((await change(joined.key, { type: 'DROPDOWN' })).status).toBe(200);
    expect(await names()).toEqual(['Now', 'Later']);
    /* A dropdown whose last choice was deleted can still be switched off. */
    await pool.query(`UPDATE program_options SET deleted_at = now(), is_active = false WHERE kind = 'FIELD:x_joining_date'`);
    expect((await change(joined.key, { is_active: false })).status).toBe(200);
  });

  it('refuses an empty change, wrong values and what does not exist', async () => {
    expect(issues(await change('gender', {}))).toEqual({ body: 'Nothing to change' });
    expect(issues(await change('gender', { label_en: ' ', order: 10_000 }))).toEqual({
      'body.label_en': 'Label is required',
      'body.order': 'Order must be at most 9999',
    });
    expect(issues(await change('gender', { key: 'sex', order: 1 }))).toEqual({ 'body.key': 'Unknown field' });
    refused(await patch(admin, `/fields/${NOBODY}`, { order: 1 }), 404, 'Field not found');
  });
});

describe('DELETE /manage/fields/:id', () => {
  it('deletes an own field; the answers stay stored and its key is not given again', async () => {
    const why = await add({ label_en: 'Why', type: 'TEXT', required: true });
    const { applicationId } = await makeApplication('MAIN_DONE', { centre: await makeCentre(), values: { x_why: 'To learn' } });
    const res = await del(admin, `/fields/${why.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Field deleted', data: null });
    expect(await stored('program_fields', why.id)).toEqual({ is_active: false, deleted: true });
    expect(await field('x_why')).toBeUndefined();
    expect(await errors(1)).toEqual([]);
    expect((await one<{ v: string }>(`SELECT data ->> 'x_why' AS v FROM applications WHERE id = $1`, [applicationId]))!.v).toBe(
      'To learn',
    );
    refused(await del(admin, `/fields/${why.id}`), 404, 'Field not found');
    refused(await patch(admin, `/fields/${why.id}`, { order: 1 }), 404, 'Field not found');
    expect((await add({ label_en: 'Why' })).key).toBe('x_why_2');
  });

  it('the list of a deleted dropdown is gone', async () => {
    const blood = await add({ label_en: 'Blood', type: 'DROPDOWN', options: [{ name_en: 'A+' }] });
    await del(admin, `/fields/${blood.id}`);
    refused(await get(admin, `/masters/${encodeURIComponent('FIELD:x_blood')}`), 404, 'List not found');
  });

  it('deletes a field of the program too, and brings it back switched off; its answers stay', async () => {
    const centre = await makeCentre();
    const { applicationId } = await makeApplication('SUBMITTED', { centre, values: { landmark: 'Near the park' } });
    const landmark = await field('landmark');
    const res = await del(admin, `/fields/${landmark.id}`);
    expect({ status: res.status, message: res.body.message }).toEqual({ status: 200, message: 'Field deleted' });
    expect(await field('landmark')).toBeUndefined();
    expect(await list()).toHaveLength(35);
    /* Not asked, not checked; the answer given stays stored and shown, as of a switched-off field. */
    expect((await loadProgram()).activeFields().map((f) => f.key)).not.toContain('landmark');
    expect(await errors(1, { landmark: 'x'.repeat(999) })).toEqual([]);
    expect((await one<{ v: string }>(`SELECT data ->> 'landmark' AS v FROM applications WHERE id = $1`, [applicationId]))!.v).toBe(
      'Near the park',
    );
    const deleted = (await get(admin, '/fields/deleted')).body.data as Field[];
    expect(deleted.map((f) => f.key)).toEqual(['landmark']);
    expect(deleted[0]).toMatchObject({ is_active: false, deleted_at: expect.any(String) });
    refused(await patch(admin, `/fields/${landmark.id}`, { is_active: true }), 404, 'Field not found');

    const back = await post(admin, `/fields/${landmark.id}/restore`, {});
    expect(back.status).toBe(200);
    expect(back.body.message).toBe('Field restored');
    expect(back.body.data).toMatchObject({ key: 'landmark', is_active: false, deleted_at: null });
    expect((await get(admin, '/fields/deleted')).body.data).toEqual([]);
    expect((await change('landmark', { is_active: true })).body.data.is_active).toBe(true);
    expect(await errors(1, { landmark: 'x'.repeat(151) })).toEqual([
      { field: 'body.landmark', message: 'Landmark must be at most 150 characters' },
    ]);
    refused(await post(admin, `/fields/${landmark.id}/restore`, {}), 404, 'Field not found');
  });
});

it('every change is recorded with the panel user, without labels', async () => {
  const own = await add({ label_en: 'Blood', type: 'DROPDOWN', options: [{ name_en: 'A+' }, { name_en: 'B+' }] });
  await change(own.key, { label_en: 'Blood Group', help_en: 'Ask at home' });
  await del(admin, `/fields/${own.id}`);
  expect(await audits('edp.field.%')).toEqual(
    [
      { action: 'edp.field.create', details: { key: 'x_blood', type: 'DROPDOWN', choices: 2 } },
      { action: 'edp.field.update', details: { key: 'x_blood', fields: ['label_en', 'help_en'] } },
      { action: 'edp.field.delete', details: { key: 'x_blood' } },
    ].map((e) => ({ ...e, resource: 'program_fields', resource_id: own.id, actor_kind: 'PANEL', actor_id: admin.id })),
  );
});
