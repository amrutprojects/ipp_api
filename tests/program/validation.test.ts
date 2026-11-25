import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool';
import type { FieldType, Form } from '../../src/program/constants';
import { checkForm, referenceNames, viewFields } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
import {
  RULE_TYPES,
  RULES,
  validationIssue,
  type CustomCheck,
  type FieldValidation,
  type Rule,
} from '../../src/program/validation';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { formValues, makeAccount, makeCentre, makePanelUser, newAadhaar, request, type TestPanelUser } from '../helpers/factory';

let admin: TestPanelUser;
let form: Form;
beforeAll(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  form = { ...(await formValues(await makeCentre())), email: 'asha@example.test', aadhaar_number: newAadhaar() };
});
afterEach(() => vi.useRealTimers());
afterAll(closeDatabase);

const issue = (type: FieldType, validation: Partial<FieldValidation>, value: string, other: Form = {}) =>
  validationIssue({ key: 'x_f', labelEn: 'Field', type, validation: { rules: [], custom: [], ...validation } }, value, {
    x_f: value,
    ...other,
  });
const rule = (type: FieldType, r: Rule, value: string) => issue(type, { rules: [r] }, value);
const js = (source: string, message = 'Not right'): CustomCheck => ({
  kind: 'JS',
  source,
  message_en: message,
  message_mr: null,
});
const regex = (source: string, flags = ''): CustomCheck => ({
  kind: 'REGEX',
  source,
  flags,
  message_en: 'Not right',
  message_mr: null,
});

describe('ready-made rules', () => {
  it.each<[FieldType, Rule, string[], string[], string]>([
    ['TEXT', { type: 'letters' }, ["Asha d'Souza", 'आशा जोशी'], ['A1', 'a_b'], 'Field may contain only letters and spaces'],
    ['TEXT', { type: 'digits' }, ['0123'], ['1.5', '12a'], 'Field may contain only digits'],
    ['TEXT', { type: 'letters_digits' }, ['Flat 12', 'घर १२'], ['a-b'], 'Field may contain only letters, digits and spaces'],
    ['TEXT', { type: 'no_spaces' }, ['ab'], ['a b'], 'Field cannot contain spaces'],
    ['TEXT', { type: 'uppercase' }, ['AB 1'], ['Ab'], 'Field must be in capital letters'],
    ['TEXT', { type: 'pin_code' }, ['422001'], ['022001', '4220011'], 'Field must be exactly 6 digits'],
    ['TEXT', { type: 'pan' }, ['ABCDE1234F', 'abcde1234f'], ['ABCD1234F'], 'Field must be a valid PAN, e.g. ABCDE1234F'],
    ['TEXT', { type: 'ifsc' }, ['SBIN0001234'], ['SBIN1001234'], 'Field must be a valid IFSC code, e.g. SBIN0001234'],
    ['TEXT', { type: 'min_length', value: 3 }, ['abc', 'आशा'], ['ab'], 'Field must be at least 3 characters'],
    ['TEXTAREA', { type: 'max_length', value: 3 }, ['abc'], ['abcd'], 'Field must be at most 3 characters'],
    ['NUMBER', { type: 'whole_number' }, ['12', '-3'], ['1.5'], 'Field must be a whole number'],
    ['NUMBER', { type: 'min_digits', value: 10 }, ['9876543210'], ['987654321'], 'Field must have at least 10 digits'],
    ['NUMBER', { type: 'max_digits', value: 3 }, ['-123', '12.3'], ['1234', '12.34'], 'Field must have at most 3 digits'],
    ['NUMBER', { type: 'min_value', value: 10 }, ['10', '10.5'], ['9.9', '-11'], 'Field must be at least 10'],
    ['NUMBER', { type: 'max_value', value: -1 }, ['-1', '-2'], ['0'], 'Field must be at most -1'],
    ['YEAR', { type: 'min_value', value: 2015 }, ['2015'], ['2014'], 'Field must be at least 2015'],
    ['DATE', { type: 'min_date', value: '2024-06-01' }, ['2024-06-01'], ['2024-05-31'], 'Field must be on or after 01/06/2024'],
    ['DATE', { type: 'max_date', value: '2024-06-01' }, ['2024-06-01'], ['2024-06-02'], 'Field must be on or before 01/06/2024'],
    ['TIME', { type: 'min_time', value: '09:30' }, ['09:30'], ['09:29'], 'Field must be 09:30 or later'],
    ['TIME', { type: 'max_time', value: '18:00' }, ['18:00'], ['18:01'], 'Field must be 18:00 or earlier'],
    ['CHECKBOXES', { type: 'min_choices', value: 2 }, ['["a","b"]'], ['["a"]'], 'Field: choose at least 2'],
    ['CHECKBOXES', { type: 'max_choices', value: 1 }, ['["a"]'], ['["a","b"]'], 'Field: choose at most 1'],
  ])('%s %o', async (type, r, right, wrong, message) => {
    for (const v of right) expect(await rule(type, r, v), v).toBe(null);
    for (const v of wrong) expect(await rule(type, r, v), v).toBe(message);
  });

  it('compares dates, months, years and ages with today in India', async () => {
    vi.useFakeTimers({ now: new Date('2025-12-31T20:00:00Z'), toFake: ['Date'] });
    expect(await rule('DATE', { type: 'not_future' }, '2026-01-01')).toBe(null);
    expect(await rule('DATE', { type: 'not_future' }, '2026-01-02')).toBe('Field cannot be in the future');
    expect(await rule('MONTH', { type: 'not_past' }, '2025-12')).toBe('Field cannot be in the past');
    expect(await rule('MONTH', { type: 'not_past' }, '2026-01')).toBe(null);
    expect(await rule('YEAR', { type: 'not_future' }, '2027')).toBe('Field cannot be in the future');
    expect(await rule('DATE', { type: 'min_age', value: 18 }, '2008-01-01')).toBe(null);
    expect(await rule('DATE', { type: 'min_age', value: 18 }, '2008-01-02')).toBe('Field: age must be at least 18 years');
    expect(await rule('DATE', { type: 'max_age', value: 35 }, '1989-12-31')).toBe('Field: age must be at most 35 years');
  });

  it('are checked in one order, only those that fit the type', async () => {
    const rules: Rule[] = [{ type: 'max_length', value: 2 }, { type: 'letters' }, { type: 'whole_number' }];
    expect(await issue('TEXT', { rules }, '123')).toBe('Field may contain only letters and spaces');
    expect(await issue('TEXT', { rules }, 'abc')).toBe('Field must be at most 2 characters');
    expect(Object.keys(RULES)).toEqual([...RULE_TYPES]);
  });
});

describe('own checks', () => {
  it('match the whole answer by a regular expression', async () => {
    const custom = [regex('[A-Z]{2}[0-9]{4}')];
    expect(await issue('TEXT', { custom }, 'MH1234')).toBe(null);
    expect(await issue('TEXT', { custom }, 'xMH1234')).toBe('Not right');
    expect(await issue('TEXT', { custom: [regex('mh|ka', 'i')] }, 'MH')).toBe(null);
    expect(await issue('TEXT', { custom: [regex('mh|ka', 'i')] }, 'mhx')).toBe('Not right');
    expect(await issue('TEXT', { custom: [regex('[\\p{L}\\p{M} ]+', 'u')] }, 'आशा जोशी')).toBe(null);
  });

  it('run a JavaScript function on the answer and the form', async () => {
    const source = `function (value, form) {
      // the answer must start with the district's letter
      if (!value.startsWith('MH')) return 'Must start with MH';
      return form.gender === 'Female';
    }`;
    expect(await issue('TEXT', { custom: [js(source)] }, 'MH1', { gender: 'Female' })).toBe(null);
    expect(await issue('TEXT', { custom: [js(source)] }, 'KA1', { gender: 'Female' })).toBe('Must start with MH');
    expect(await issue('TEXT', { custom: [js(source, 'Only for women')] }, 'MH1', { gender: 'Male' })).toBe('Only for women');
    expect(await issue('TEXT', { custom: [js('(value) => value.length === 3')] }, 'abc')).toBe(null);
    expect(await issue('CHECKBOXES', { custom: [js('v => JSON.parse(v).includes("a")')] }, '["b"]')).toBe('Not right');
  });

  it('never see the Aadhaar number, the server, files or the network', async () => {
    expect(
      await issue('TEXT', { custom: [js('(v, f) => f.aadhaar_number === undefined')] }, 'x', { aadhaar_number: '123' }),
    ).toBe(null);
    const names = [
      'process',
      'require',
      'fetch',
      'XMLHttpRequest',
      'setTimeout',
      'module',
      'Buffer',
      'globalThis.process',
      'WebAssembly',
    ];
    const source = `() => [${names.map((n) => `typeof ${n}`).join(',')}].every((t) => t === 'undefined')`;
    expect(await issue('TEXT', { custom: [js(source)] }, 'x')).toBe(null);
    /* Nothing of one run is left for the next. */
    await issue('TEXT', { custom: [js('() => { globalThis.left = 1; Object.prototype.left = 1; return true; }')] }, 'x');
    expect(await issue('TEXT', { custom: [js('() => typeof left === "undefined"')] }, 'x')).toBe(null);
    expect(({} as { left?: number }).left).toBeUndefined();
  });

  it('are stopped when they take too long, use too much, or fail; the answer is then not accepted', async () => {
    const stuck = 'Field could not be checked. Please contact the programme office.';
    for (const source of [
      '() => { while (true); }',
      '() => { const a = []; while (true) a.push("x".repeat(1000)); }',
      '() => (function f() { return f(); })()',
      '() => { throw new Error("no"); }',
      '(v) => v.nothing.here',
    ]) {
      const started = Date.now();
      expect(await issue('TEXT', { custom: [js(source)] }, 'x'), source).toBe(stuck);
      expect(Date.now() - started, source).toBeLessThan(1000);
    }
    const started = Date.now();
    expect(await issue('TEXT', { custom: [regex('(a+)+')] }, `${'a'.repeat(200)}!`)).toBe(stuck);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('own fields in the form', () => {
  const add = (key: string, type: FieldType, label: string, o: { required?: boolean; validation?: FieldValidation } = {}) =>
    pool.query(
      `INSERT INTO program_fields (key, step, type, label_en, required, is_custom, validation) VALUES ($1, 1, $2, $3, $4, true, $5)`,
      [key, type, label, o.required ?? false, o.validation ? JSON.stringify(o.validation) : null],
    );
  const problems = async (over: Form, stored?: Form) => {
    const { errors } = await checkForm(await loadProgram(), { ...form, ...over }, { stored });
    return Object.fromEntries(errors.map((e) => [e.field!.replace('body.', ''), e.message]));
  };
  beforeAll(async () => {
    await add('x_email', 'EMAIL', 'Work email');
    await add('x_mobile', 'MOBILE', 'Parent mobile');
    await add('x_url', 'URL', 'Profile');
    await add('x_time', 'TIME', 'Call time');
    await add('x_month', 'MONTH', 'Passing month');
    await add('x_year', 'YEAR', 'Passing year');
    await add('x_radio', 'RADIO', 'Shift');
    await add('x_boxes', 'CHECKBOXES', 'Languages', { validation: { rules: [{ type: 'min_choices', value: 2 }], custom: [] } });
    await add('x_yn', 'YES_NO', 'Own laptop');
    await add('x_ok', 'CONSENT', 'I agree', { required: true });
    await add('x_num', 'NUMBER', 'Experience', { validation: { rules: [{ type: 'max_value', value: 40 }], custom: [] } });
    for (const [kind, name] of [
      ['FIELD:x_radio', 'Morning'],
      ['FIELD:x_radio', 'Evening'],
      ['FIELD:x_boxes', 'Marathi'],
      ['FIELD:x_boxes', 'Hindi'],
      ['FIELD:x_boxes', 'English'],
    ])
      await pool.query(`INSERT INTO program_options (kind, code, name_en, display_order) VALUES ($1, $2, $2, 10)`, [kind, name]);
  });

  it('accepts right answers of every type', async () => {
    expect(
      await problems({
        x_email: 'a@b.in',
        x_mobile: '+91 98765 43210',
        x_url: 'https://example.test/me',
        x_time: '09:30',
        x_month: '2024-06',
        x_year: '2024',
        x_radio: 'Morning',
        x_boxes: '["Marathi","English"]',
        x_yn: 'No',
        x_ok: 'Yes',
        x_num: '2.5',
      }),
    ).toEqual({});
  });

  it('refuses wrong ones with the message of their type', async () => {
    expect(
      await problems({
        x_email: 'a@b',
        x_mobile: '123',
        x_url: 'example.test',
        x_time: '24:00',
        x_month: '2024-13',
        x_year: '24',
        x_radio: 'Night',
        x_boxes: '["Marathi","Klingon"]',
        x_yn: 'Maybe',
        x_ok: 'No',
        x_num: '41',
      }),
    ).toEqual({
      x_email: 'Work email must be a valid email address',
      x_mobile: 'Parent mobile must be a 10-digit Indian number starting 6–9',
      x_url: 'Profile must be a web address starting with http:// or https://',
      x_time: 'Call time must be a time in HH:MM format',
      x_month: 'Passing month must be a month in YYYY-MM format',
      x_year: 'Passing year must be a year, e.g. 2026',
      x_radio: 'Select a valid Shift',
      x_boxes: 'Select valid choices for Languages',
      x_yn: 'Own laptop: select Yes or No',
      x_ok: 'I agree must be ticked',
      x_num: 'Experience must be at most 40',
    });
    for (const bad of ['Marathi', '["Marathi","Marathi"]', '[1]', '{"a":1}', '["Marathi"'])
      expect((await problems({ x_ok: 'Yes', x_boxes: bad })).x_boxes, bad).toBe('Select valid choices for Languages');
    expect((await problems({ x_ok: 'Yes', x_boxes: '["Hindi"]' })).x_boxes).toBe('Languages: choose at least 2');
    expect(await problems({ x_ok: 'Yes', x_boxes: '[]' })).toEqual({});
  });

  it('keeps stored answers that are no longer offered or allowed (the Auditor edits)', async () => {
    const stored = { ...form, x_ok: 'Yes', x_boxes: '["Marathi","Hindi"]', x_num: '50' };
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'FIELD:x_boxes' AND code = 'Hindi'`);
    expect(await problems({ x_ok: 'Yes', x_boxes: '["Marathi","Hindi"]', x_num: '50' }, stored)).toEqual({});
    expect(await problems({ x_ok: 'Yes', x_boxes: '["Hindi","English"]' }, stored)).toEqual({});
    expect((await problems({ x_ok: 'Yes', x_boxes: '["Marathi","Hindi"]' })).x_boxes).toBe('Select valid choices for Languages');
    await pool.query(`UPDATE program_options SET is_active = true WHERE kind = 'FIELD:x_boxes'`);
  });

  it('shows several choices by their current names', async () => {
    await pool.query(`UPDATE program_options SET name_en = 'Marathi (मराठी)' WHERE kind = 'FIELD:x_boxes' AND code = 'Marathi'`);
    const program = await loadProgram();
    const held = { ...form, x_boxes: '["Marathi","English"]', x_yn: 'Yes' };
    const view = viewFields(program, held, await referenceNames(program, held), null);
    expect(view.find((f) => f.key === 'x_boxes')).toMatchObject({
      value: '["Marathi","English"]',
      text: 'Marathi (मराठी), English',
    });
    expect(view.find((f) => f.key === 'x_yn')!.text).toBe('Yes');
  });

  it('sends the checks to the student, but never a function', async () => {
    await add('x_secret', 'TEXT', 'Code', {
      validation: {
        rules: [{ type: 'min_length', value: 2 }],
        custom: [js('() => "hidden source"', 'Wrong code'), regex('[A-Z]+')],
      },
    });
    const { body } = await request('get', '/options');
    const field = body.data.fields.find((f: { key: string }) => f.key === 'x_secret');
    expect(field.validation).toEqual({
      rules: [{ type: 'min_length', value: 2 }],
      custom: [
        { kind: 'JS', message_en: 'Wrong code', message_mr: null },
        { kind: 'REGEX', source: '[A-Z]+', flags: '', message_en: 'Not right', message_mr: null },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('hidden source');
    expect(body.data.lists['FIELD:x_boxes'].map((o: { value: string }) => o.value).sort()).toEqual([
      'English',
      'Hindi',
      'Marathi',
    ]);
    /* A student's step is checked by it. */
    const student = await makeAccount();
    const res = await request('put', '/application/steps/1', student.token).send({
      complete: true,
      data: { x_secret: 'AB', x_ok: 'Yes' },
    });
    expect(res.body.error.details).toContainEqual({ field: 'body.x_secret', message: 'hidden source' });
  });
});

describe('Masters → Form fields', () => {
  const create = (body: Record<string, unknown>) =>
    request('post', '/manage/fields', admin.token).send({ step: 2, label_en: 'Own field', type: 'TEXT', ...body });
  const details = (res: { body: { error?: { details?: { field: string; message: string }[] } } }) =>
    Object.fromEntries((res.body.error?.details ?? []).map((d) => [d.field.replace('body.validation.', ''), d.message]));

  it('stores the checks with the field, changes and clears them', async () => {
    const validation = {
      rules: [{ type: 'letters' }, { type: 'min_length', value: 3 }],
      custom: [
        { kind: 'REGEX', source: 'A.*', flags: 'iu', message_en: 'Starts with A', message_mr: 'A ने सुरू' },
        { kind: 'JS', source: 'function (value) { return true; }', message_en: 'No' },
      ],
    };
    const made = await create({ validation });
    expect(made.status).toBe(201);
    expect(made.body.data.validation).toEqual({
      rules: validation.rules,
      custom: [validation.custom[0], { ...validation.custom[1], message_mr: null }],
    });
    const { id } = made.body.data;
    const patch = (body: Record<string, unknown>) => request('patch', `/manage/fields/${id}`, admin.token).send(body);
    /* Other changes leave them; a new type keeps the rules that fit. */
    expect((await patch({ label_en: 'Own field 2' })).body.data.validation.rules).toHaveLength(2);
    expect((await patch({ type: 'NUMBER' })).body.data.validation).toMatchObject({
      rules: [],
      custom: [{ kind: 'REGEX' }, { kind: 'JS' }],
    });
    expect((await patch({ validation: { rules: [{ type: 'max_value', value: 5 }] } })).body.data.validation).toEqual({
      rules: [{ type: 'max_value', value: 5 }],
      custom: [],
    });
    /* A limit that the new type cannot have goes. */
    expect((await patch({ type: 'YEAR' })).body.data.validation).toBe(null);
    expect((await patch({ validation: null })).body.data.validation).toBe(null);
    expect((await create({ label_en: 'Empty', validation: { rules: [], custom: [] } })).body.data.validation).toBe(null);
  });

  it('refuses checks that do not fit or cannot be run', async () => {
    const rules = (type: string, ...r: unknown[]) => create({ type, validation: { rules: r } });
    expect(details(await rules('TEXT', { type: 'whole_number' }))).toEqual({
      'rules.0.type': 'This check does not fit the type of the field',
    });
    expect(
      details(await rules('TEXT', { type: 'letters', value: 1 }, { type: 'min_length' }, { type: 'max_length', value: 251 })),
    ).toEqual({
      'rules.0.value': 'This check has no limit',
      'rules.1.value': 'Enter a number',
      'rules.2.value': 'Enter a number from 1 to 250',
    });
    expect(details(await rules('TEXT', { type: 'min_length', value: 2.5 }))).toEqual({ 'rules.0.value': 'Enter a whole number' });
    expect(details(await rules('NUMBER', { type: 'max_value', value: 1 }, { type: 'min_value', value: 2 }))).toEqual({
      'rules.0.value': 'The maximum is smaller than the minimum',
    });
    expect(details(await rules('DATE', { type: 'min_date', value: '2024-02-30' }, { type: 'max_date', value: 5 }))).toEqual({
      'rules.0.value': 'Choose a date',
      'rules.1.value': 'Choose a date',
    });
    expect(details(await rules('TIME', { type: 'min_time', value: '25:00' }))).toEqual({ 'rules.0.value': 'Choose a time' });
    expect(details(await rules('TEXT', { type: 'letters' }, { type: 'letters' }))).toEqual({
      rules: 'Each check may be chosen only once',
    });
    expect(details(await rules('TEXT', { type: 'nope' }))).toEqual({ 'rules.0.type': 'Unknown check' });

    const custom = (...c: unknown[]) => create({ validation: { custom: c } });
    const bad = details(
      await custom(
        { kind: 'REGEX', source: '[a-z', message_en: 'x' },
        { kind: 'REGEX', source: '(a+)+', message_en: 'x' },
        { kind: 'JS', source: 'function (value) { return', message_en: 'x' },
        { kind: 'JS', source: '42', message_en: 'x' },
      ),
    );
    expect(bad['custom.0.source']).toMatch(/^This expression cannot be used: /);
    expect(bad['custom.1.source']).toBe('This expression cannot be used: it takes too long');
    expect(bad['custom.2.source']).toMatch(/^This function cannot be used: /);
    expect(bad['custom.3.source']).toBe('This function cannot be used: it is not a function: write function (value, form) { … }');
    expect(details(await custom({ kind: 'REGEX', source: ' ', message_en: '', flags: 'gg' }))).toEqual({
      'custom.0.source': 'Write the check',
      'custom.0.message_en': 'Error message is required',
      'custom.0.flags': 'Only the flags i, m, s and u can be used, each once',
    });
    expect(details(await custom(...Array(6).fill({ kind: 'REGEX', source: 'a', message_en: 'x' })))).toEqual({
      custom: 'At most 5 custom checks',
    });
  });

  it('for any field, by an ADMIN', async () => {
    const landmark = (await pool.query<{ id: string }>(`SELECT id FROM program_fields WHERE key = 'landmark'`)).rows[0]!.id;
    const validation = { rules: [{ type: 'letters' }] };
    const res = await request('patch', `/manage/fields/${landmark}`, admin.token).send({ validation });
    expect([res.status, res.body.data.validation]).toEqual([200, { ...validation, custom: [] }]);
    const viewer = await makePanelUser('VIEWER');
    expect((await request('patch', `/manage/fields/${landmark}`, viewer.token).send({ validation })).status).toBe(403);
    expect((await request('post', '/manage/fields/test-validation', viewer.token).send({})).status).toBe(403);
  });

  it('tries checks on a value before they are saved', async () => {
    const attempt = (value: string, over: Record<string, unknown> = {}) =>
      request('post', '/manage/fields/test-validation', admin.token).send({
        label_en: 'Code',
        type: 'TEXT',
        validation: {
          rules: [{ type: 'min_length', value: 2 }],
          custom: [{ kind: 'JS', source: "(value) => value[0] === 'A' || 'Starts with A'", message_en: 'No' }],
        },
        value,
        ...over,
      });
    expect((await attempt('AB')).body.data).toEqual({ valid: true, messages: [] });
    expect((await attempt('A')).body.data).toEqual({ valid: false, messages: ['Code must be at least 2 characters'] });
    expect((await attempt('BB')).body.data).toEqual({ valid: false, messages: ['Starts with A'] });
    expect((await attempt('x', { type: 'NUMBER', validation: null })).body.data).toEqual({
      valid: false,
      messages: ['Code must be a number'],
    });
    const wrong = await attempt('AB', { validation: { rules: [{ type: 'min_length' }] } });
    expect(wrong.status).toBe(422);
    expect(details(wrong)).toEqual({ 'rules.0.value': 'Enter a number' });
    expect((await attempt(' ')).status).toBe(422);
  });

  it('gives the new types their choices, and says which of them are used', async () => {
    expect(details(await create({ type: 'RADIO' }))).toEqual({ 'body.options': 'Add at least one choice' });
    expect(details(await create({ type: 'EMAIL', options: [{ name_en: 'a' }] }))).toEqual({
      'body.options': 'A field of this type has no choices',
    });
    const made = await create({ label_en: 'Skills', type: 'CHECKBOXES', options: [{ name_en: 'Excel' }, { name_en: 'Tally' }] });
    expect(made.status).toBe(201);
    const { id, key, options_kind: kind } = made.body.data as { id: string; key: string; options_kind: string };
    expect(kind).toBe(`FIELD:${key}`);
    const student = await makeAccount();
    await pool.query(`INSERT INTO applications (account_id, data) VALUES ($1, $2)`, [
      student.id,
      JSON.stringify({ [key]: '["Tally"]' }),
    ]);
    const list = await request('get', `/manage/masters/${encodeURIComponent(kind)}?limit=100`, admin.token);
    expect(list.body.data.map((o: { name_en: string; in_use: boolean }) => [o.name_en, o.in_use])).toEqual([
      ['Excel', false],
      ['Tally', true],
    ]);
    /* Between the types with choices they stay. */
    expect((await request('patch', `/manage/fields/${id}`, admin.token).send({ type: 'RADIO' })).status).toBe(200);
    expect((await request('get', '/options')).body.data.lists[kind]).toHaveLength(2);
  });

  it('knows the types there are', async () => {
    await expect(pool.query(`UPDATE program_fields SET type = 'FILE' WHERE key = 'gender'`)).rejects.toThrow(
      /ck_program_fields_type/,
    );
  });
});
