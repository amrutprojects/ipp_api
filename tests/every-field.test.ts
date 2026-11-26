import { beforeEach, describe, expect, it } from 'vitest';
import { one, pool, rows } from '../src/db/pool';
import { aadhaarBlindIndex, decryptAadhaar } from '../src/lib/aadhaar';
import { FIELDS } from '../src/db/seeds/data';
import { makeApplication, makeCentre, makePanelUser, newAadhaar, optionId, request, type TestPanelUser } from './helpers/factory';
import { resetDatabase } from './helpers/db';
import {
  application,
  details,
  fields as wrongFields,
  isStored,
  fileRows,
  ready,
  setUp,
  step,
  steps,
  submit,
  uploadAll,
  verifiedToken,
} from './student/helpers';

/*
 * No field of the form is fixed: each can be switched off, made optional, moved, given another type and checks, and a student
 * still gets from the sign-up to a batch.
 */
setUp();

let admin: TestPanelUser;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
});

const KEYS = [...FIELDS[1], ...FIELDS[2]].map((f) => f.key);
const panel = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) => {
  const r = request(method, `/manage${path}`, admin.token);
  return body ? r.send(body) : r;
};
const idOf = async (key: string) => (await one<{ id: string }>(`SELECT id FROM program_fields WHERE key = $1`, [key]))!.id;
const change = async (key: string, body: object) => panel('patch', `/fields/${await idOf(key)}`, body);
const set = async (key: string, body: object) => {
  const res = await change(key, body);
  expect([key, res.status, res.body.message]).toEqual([key, 200, 'Field saved']);
  return res.body.data as { types: string[]; by_type: boolean; options_kind: string | null; type: string };
};
const off = (...keys: string[]) => Promise.all(keys.map((k) => set(k, { is_active: false })));
const rowOf = async (email: string) =>
  (await one<{
    id: string;
    account_id: string;
    data: Record<string, string>;
    aadhaar_enc: Buffer | null;
    aadhaar_index: string | null;
    aadhaar_last4: string | null;
    registration_code: string;
  }>(`SELECT p.* FROM applications p JOIN student_accounts a ON a.id = p.account_id WHERE a.email = $1`, [email]))!;

/* A submitted form is verified, approved and put into a batch of one. */
async function toBatch(accountId: string, centre: string) {
  for (const f of await rows<{ document_code: string }>(
    `SELECT f.document_code FROM application_files f JOIN applications p ON p.id = f.application_id WHERE p.account_id = $1`,
    [accountId],
  ))
    expect((await panel('post', `/applicants/${accountId}/documents/${f.document_code}/verify`, { verified: true })).status).toBe(
      200,
    );
  expect((await panel('post', `/applicants/${accountId}/approve`, { reason: 'Every document checked' })).status).toBe(200);
  expect((await panel('put', '/settings/batch', { size: 1 })).status).toBe(200);
  /* A batch names its technology (required since the technology master). */
  const technology = await optionId('TECHNOLOGY', 'T01');
  const res = await panel('post', '/batches', { name: `Batch ${accountId.slice(0, 8)}`, centre_id: centre, ids: [accountId], technology });
  expect([res.status, res.body.message]).toEqual([201, expect.any(String)]);
  return res.body.data as { district: { name: string }; members: { name: string }[] };
}

describe('a field that is switched off', () => {
  it.each(KEYS)('%s: the student gets from the sign-up to a batch', async (key) => {
    await off(key);
    const s = await ready();
    const res = await submit(s.token);
    expect([res.status, res.body.message]).toEqual([201, 'Your form has been submitted successfully']);
    const p = await rowOf(s.email);
    expect(p.data).not.toHaveProperty(key);

    const own = (await application(s.token)).body.data;
    expect(own.status).toBe('SUBMITTED');
    expect(own.view_fields.map((f: { key: string }) => f.key)).not.toContain(key);
    const seen = await panel('get', `/applicants/${p.account_id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.view_fields.map((f: { key: string }) => f.key)).not.toContain(key);
    expect((await panel('get', '/applicants')).body.data).toHaveLength(1);

    const batch = await toBatch(p.account_id, await makeCentre({ district: 'PUN' }));
    expect(batch.members).toHaveLength(1);
    /* Without a district of the student's, the center's. */
    expect(batch.district.name).toBe(key === 'district_id' ? 'Pune' : 'Nashik');
  });

  it('all of them: nothing but the documents is asked', async () => {
    await off(...KEYS);
    expect((await request('get', '/options')).body.data.fields).toEqual([]);
    const email = 'nothing@example.test';
    const token = await verifiedToken(email);
    expect((await step(token, 1, {})).status).toBe(200);
    expect((await step(token, 2, {})).status).toBe(200);
    expect((await uploadAll(token)).status).toBe(200);
    expect((await submit(token)).status).toBe(201);
    const p = await rowOf(email);
    expect(p.data).toEqual({});
    const files = await fileRows(p.id);
    /* Named after the account. */
    expect(files[0]!.storage_key).toMatch(/KAVYA.*JADHAV/i);
    expect(files.every((f) => isStored(f.storage_key))).toBe(true);
    expect((await toBatch(p.account_id, await makeCentre())).district.name).toBe('Nashik');
  });

  it('can be switched on again, and is asked again', async () => {
    await off('caste_id', 'aadhaar_number');
    await set('caste_id', { is_active: true });
    await set('aadhaar_number', { is_active: true });
    const token = await verifiedToken();
    const { basic } = await steps({ caste_id: '' });
    const res = await step(token, 1, { ...basic, aadhaar_number: '' });
    expect(wrongFields(res).sort()).toEqual(['body.aadhaar_number', 'body.caste_id']);
  });
});

describe('an optional field', () => {
  it('may be left blank, whichever it is', async () => {
    await Promise.all(KEYS.map((k) => set(k, { required: false })));
    const email = 'blank@example.test';
    const token = await verifiedToken(email);
    expect((await step(token, 1, {})).status).toBe(200);
    expect((await step(token, 2, {})).status).toBe(200);
    await uploadAll(token);
    expect((await submit(token)).status).toBe(201);
    /* The name, mobile number and e-mail the student saw filled in: the account's. */
    expect((await rowOf(email)).data).toMatchObject({
      first_name: 'Kavya',
      last_name: 'Jadhav',
      mobile_number: '9765412345',
      email,
      father_name: '',
      caste_id: '',
    });
  });

  it('is still checked when it is filled in', async () => {
    await set('father_name', { required: false });
    await set('aadhaar_number', { required: false });
    const token = await verifiedToken();
    const { basic } = await steps({ father_name: 'R4mesh' });
    const res = await step(token, 1, { ...basic, aadhaar_number: '234567890123' });
    expect(details(res)).toEqual([
      { field: 'body.father_name', message: 'Father Name may contain only letters and spaces' },
      { field: 'body.aadhaar_number', message: 'Aadhaar Number must be 12 digits with a valid checksum' },
    ]);
  });
});

describe('the Aadhaar number', () => {
  const none = { aadhaar_enc: null, aadhaar_index: null, aadhaar_last4: null };

  it('optional: any number of forms without one, and still only one form of each number', async () => {
    await set('aadhaar_number', { required: false });
    for (const email of ['one@example.test', 'two@example.test']) {
      const token = await verifiedToken(email);
      const { basic, main } = await steps();
      expect((await step(token, 1, { ...basic, aadhaar_number: '' })).status).toBe(200);
      expect((await step(token, 2, main)).status).toBe(200);
      await uploadAll(token);
      expect((await submit(token)).status).toBe(201);
      expect(await rowOf(email)).toMatchObject(none);
      const own = (await application(token)).body.data;
      expect(own.registration.aadhaar_masked).toBeNull();
    }
    const first = await ready();
    expect((await submit(first.token)).status).toBe(201);
    const p = await rowOf(first.email);
    expect(p.aadhaar_index).toBe(aadhaarBlindIndex(first.basic.aadhaar_number!));
    const token = await verifiedToken();
    const { basic } = await steps();
    const again = await step(token, 1, { ...basic, aadhaar_number: first.basic.aadhaar_number! });
    expect(details(again)).toEqual([
      { field: 'body.aadhaar_number', message: 'A registration with this Aadhaar number already exists' },
    ]);
  });

  it('typed before it was switched off: not kept with the submitted form', async () => {
    const s = await ready();
    expect((await rowOf(s.email)).aadhaar_enc).not.toBeNull();
    await off('aadhaar_number');
    expect((await submit(s.token)).status).toBe(201);
    expect(await rowOf(s.email)).toMatchObject(none);
  });

  it('can be added by the Auditor to a form without one', async () => {
    await off('aadhaar_number');
    const s = await ready();
    await submit(s.token);
    await set('aadhaar_number', { is_active: true });
    const { account_id } = await rowOf(s.email);
    expect((await panel('get', `/applicants/${account_id}`)).body.data.aadhaar_masked).toBeNull();
    const aadhaar = newAadhaar();
    const res = await panel('put', `/applicants/${account_id}/form`, { data: { aadhaar_number: aadhaar } });
    expect(res.status).toBe(200);
    expect(res.body.data.aadhaar_masked).toMatch(new RegExp(`${aadhaar.slice(-4)}$`));
    const p = await rowOf(s.email);
    expect([p.aadhaar_index, p.aadhaar_last4, decryptAadhaar(p.aadhaar_enc!)]).toEqual([
      aadhaarBlindIndex(aadhaar),
      aadhaar.slice(-4),
      aadhaar,
    ]);
  });

  it('is all there or not at all', async () => {
    const { applicationId } = await makeApplication('SUBMITTED', { centre: await makeCentre() });
    await expect(pool.query(`UPDATE applications SET aadhaar_index = NULL WHERE id = $1`, [applicationId])).rejects.toThrow(
      /ck_applications_submitted/,
    );
  });
});

it('the account keeps its name and mobile number when the Auditor clears them on the form', async () => {
  for (const key of ['first_name', 'last_name', 'mobile_number']) await set(key, { required: false });
  const s = await makeApplication('SUBMITTED', {
    centre: await makeCentre(),
    account: { first_name: 'Kavita', last_name: 'Jadhav' },
  });
  const res = await panel('put', `/applicants/${s.student.id}/form`, {
    data: { first_name: '', last_name: 'Patil', mobile_number: '' },
  });
  expect(res.status).toBe(200);
  expect(res.body.data.form).toMatchObject({ first_name: '', last_name: 'Patil', mobile_number: '' });
  expect(res.body.data.account).toMatchObject({ name: 'Kavita Patil', mobile_number: s.student.mobile });
});

describe('a field in the other step', () => {
  it('is asked, checked and saved there', async () => {
    for (const key of ['email', 'first_name', 'aadhaar_number', 'district_id']) await set(key, { step: 2, order: 1 });
    await set('education_id', { step: 1 });
    const email = 'moved@example.test';
    const token = await verifiedToken(email);
    const { basic, main } = await steps();
    const { first_name, aadhaar_number, district_id, ...one } = basic;
    const { education_id, ...two } = main;
    expect(wrongFields(await step(token, 1, one))).toEqual(['body.education_id']);
    expect((await step(token, 1, { ...one, education_id: education_id! })).status).toBe(200);
    expect(wrongFields(await step(token, 2, two)).sort()).toEqual(['body.aadhaar_number', 'body.district_id', 'body.first_name']);
    expect((await step(token, 2, { ...two, first_name, aadhaar_number, district_id })).status).toBe(200);
    await uploadAll(token);
    expect((await submit(token)).status).toBe(201);
    const p = await rowOf(email);
    expect(p.data).toMatchObject({ email, first_name, district_id, education_id });
    expect(p.aadhaar_index).toBe(aadhaarBlindIndex(aadhaar_number!));
  });
});

describe('the type of a field of the program', () => {
  it('can be any, where nothing depends on it; its own format then gives way', async () => {
    const all = await set('qualification_board', { order: 81 });
    expect(all).toMatchObject({ type: 'TEXT', by_type: false, options_kind: null });
    expect(all.types).toContain('CHECKBOXES');
    const noChoices = await change('qualification_board', { type: 'DROPDOWN' });
    expect(details(noChoices)).toEqual([{ field: 'body.options', message: 'Add at least one choice' }]);

    const made = await set('qualification_board', {
      type: 'DROPDOWN',
      options: [{ name_en: 'Government College', name_mr: 'शासकीय महाविद्यालय' }, { name_en: 'Other' }],
    });
    expect(made).toMatchObject({ type: 'DROPDOWN', by_type: true, options_kind: 'FIELD:qualification_board' });
    const list = `/masters/${encodeURIComponent('FIELD:qualification_board')}`;
    expect((await panel('get', list)).body.data.map((o: { name_en: string }) => o.name_en)).toEqual([
      'Government College',
      'Other',
    ]);
    expect((await panel('post', list, { name_en: 'Private College' })).status).toBe(201);
    const o = (await request('get', '/options')).body.data;
    expect(o.fields.find((f: { key: string }) => f.key === 'qualification_board')).toMatchObject({
      type: 'DROPDOWN',
      by_type: true,
      options_kind: 'FIELD:qualification_board',
    });
    expect(o.lists['FIELD:qualification_board']).toHaveLength(3);

    const token = await verifiedToken();
    const { basic, main } = await steps({ qualification_board: 'Test College' });
    await step(token, 1, basic);
    expect(details(await step(token, 2, main))).toEqual([
      { field: 'body.qualification_board', message: 'Select a valid College Name' },
    ]);
    expect((await step(token, 2, { ...main, qualification_board: 'Other' })).status).toBe(200);
    await uploadAll(token);
    expect((await submit(token)).status).toBe(201);

    /* As it came: its own format again; the list is gone, its choices are kept. */
    expect(await set('qualification_board', { type: 'TEXT' })).toMatchObject({ by_type: false, options_kind: null });
    expect((await panel('get', list)).status).toBe(404);
    expect(await set('qualification_board', { type: 'RADIO' })).toMatchObject({ options_kind: 'FIELD:qualification_board' });
    expect((await panel('get', list)).body.data).toHaveLength(3);
  });

  it('a score that is no number is not compared with the grading', async () => {
    await set('score', { type: 'TEXT' });
    const token = await verifiedToken();
    const { basic, main } = await steps({ score: '999' });
    await step(token, 1, basic);
    expect((await step(token, 2, main)).status).toBe(200);
  });

  it('a taluka with choices is shown by their names', async () => {
    await set('taluka', { type: 'DROPDOWN', options: [{ name_en: 'Niphad' }] });
    const kind = 'FIELD:taluka';
    await pool.query(`UPDATE program_options SET name_en = 'Niphad (Nashik)' WHERE kind = $1`, [kind]);
    const s = await makeApplication('SUBMITTED', { centre: await makeCentre(), values: { taluka: 'Niphad' } });
    const seen = (await panel('get', `/applicants/${s.student.id}`)).body.data;
    expect(seen.display.taluka).toBe('Niphad (Nashik)');
    expect(seen.view_fields.find((f: { key: string }) => f.key === 'taluka').text).toBe('Niphad (Nashik)');
  });

  it.each(['gender', 'district_id', 'centre_id', 'technology', 'caste_id', 'grading_type'])(
    '%s: one choice of its list, as a dropdown or radio buttons',
    async (key) => {
      const radio = await set(key, { type: 'RADIO' });
      expect(radio.types).toEqual(['DROPDOWN', 'RADIO']);
      expect(radio.by_type).toBe(false);
      expect(details(await change(key, { type: 'TEXT' }))).toEqual([
        { field: 'body.type', message: 'This field cannot have this type' },
      ]);
      const s = await ready();
      expect((await submit(s.token)).status).toBe(201);
      const token = await verifiedToken();
      const { basic, main } = await steps({ [key]: 'nothing of the list' });
      const first = await step(token, 1, basic);
      const wrong = first.status === 200 ? await step(token, 2, main) : first;
      expect(wrongFields(wrong)).toEqual([`body.${key}`]);
    },
  );

  it.each(['first_name', 'last_name', 'email', 'mobile_number', 'aadhaar_number', 'disability_status'])(
    '%s: stays, as its answers are used elsewhere',
    async (key) => {
      const { types, type } = await set(key, { order: 7 });
      expect(types).toEqual([type]);
      expect(details(await change(key, { type: 'TEXTAREA' }))).toEqual([
        { field: 'body.type', message: 'This field cannot have this type' },
      ]);
    },
  );

  it('choices are its own list or none', async () => {
    expect(details(await change('gender', { options: [{ name_en: 'A' }] }))).toEqual([
      { field: 'body.options', message: 'The choices of this field are a list of their own: change them there.' },
    ]);
    for (const key of ['landmark', 'district_id'])
      expect(details(await change(key, { options: [{ name_en: 'A' }] }))).toEqual([
        { field: 'body.options', message: 'A field of this type has no choices' },
      ]);
    expect((await panel('get', `/masters/${encodeURIComponent('FIELD:gender')}`)).status).toBe(404);
  });
});

describe('the checks of a field of the program', () => {
  it('are all it is checked by beyond its type', async () => {
    await set('date_of_birth', { validation: { rules: [{ type: 'min_age', value: 18 }] } });
    await set('landmark', {
      required: true,
      validation: {
        rules: [{ type: 'min_length', value: 5 }],
        custom: [{ kind: 'REGEX', source: 'Near .*', message_en: 'Start with Near' }],
      },
    });
    await set('gender', {
      validation: { rules: [], custom: [{ kind: 'JS', source: "(v) => v !== 'Male' || 'Not this batch'", message_en: 'No' }] },
    });
    await set('aadhaar_number', {
      validation: { rules: [], custom: [{ kind: 'REGEX', source: '7[0-9]{11}', message_en: 'Starts with 7' }] },
    });
    const token = await verifiedToken();
    const { basic } = await steps({ date_of_birth: `${new Date().getFullYear() - 16}-01-01`, landmark: 'Park', gender: 'Male' });
    /* With spaces, as the page sends it: the check gets its digits. */
    const spaced = basic.aadhaar_number!.replace(/(\d{4})(?=\d)/g, '$1 ');
    expect(details(await step(token, 1, { ...basic, aadhaar_number: spaced }))).toEqual([
      { field: 'body.date_of_birth', message: 'Date of Birth: age must be at least 18 years' },
      { field: 'body.landmark', message: 'Landmark must be at least 5 characters' },
      { field: 'body.gender', message: 'Not this batch' },
    ]);
    const fixed = { ...basic, date_of_birth: '2003-04-15', landmark: 'At the park', gender: 'Female' };
    expect(details(await step(token, 1, { ...fixed, date_of_birth: '2003-02-31' })).map((d) => d.message)).toEqual([
      'Date of Birth must be a real date in YYYY-MM-DD format',
      'Start with Near',
    ]);
    expect((await step(token, 1, { ...fixed, landmark: 'Near the park' })).status).toBe(200);
  });

  it('do not refuse a stored value that stays when the Auditor corrects another', async () => {
    const s = await makeApplication('SUBMITTED', { centre: await makeCentre(), values: { landmark: 'Park' } });
    await set('landmark', { validation: { rules: [{ type: 'min_length', value: 10 }] } });
    const edit = (data: object) => panel('put', `/applicants/${s.student.id}/form`, { data });
    expect((await edit({ pin_code: '411001' })).status).toBe(200);
    expect(details(await edit({ landmark: 'Mill' }))).toEqual([
      { field: 'body.landmark', message: 'Landmark must be at least 10 characters' },
    ]);
  });

  it('must fit its type, and go with another one when they still fit', async () => {
    const wrong = await change('landmark', { validation: { rules: [{ type: 'min_age', value: 3 }] } });
    expect(details(wrong)).toEqual([
      { field: 'body.validation.rules.0.type', message: 'This check does not fit the type of the field' },
    ]);
    await set('landmark', { validation: { rules: [{ type: 'digits' }, { type: 'max_length', value: 20 }] } });
    await set('landmark', { type: 'TEXTAREA' });
    const { validation } = (await one<{ validation: object }>(`SELECT validation FROM program_fields WHERE key = 'landmark'`))!;
    expect(validation).toEqual({ rules: [{ type: 'max_length', value: 20 }], custom: [] });
    await set('landmark', { validation: null });
  });
});

it('no field is core: not in the database, nor in what the API answers', async () => {
  expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM program_fields WHERE is_core`))!.n).toBe(0);
  const all = (await panel('get', '/fields')).body.data as object[];
  expect(all).toHaveLength(36);
  for (const f of all) expect(f).not.toHaveProperty('core');
});
