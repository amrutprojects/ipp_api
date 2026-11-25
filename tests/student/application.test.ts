import { afterEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { decryptAadhaar } from '../../src/lib/aadhaar';
import {
  districtId,
  makeAccount,
  makeApplication,
  makeCentre,
  makePanelUser,
  newAadhaar,
  optionId,
  request,
} from '../helpers/factory';
import { application, code, details, fields, login, newEmail, ready, setUp, step, steps, submit, verifiedToken } from './helpers';

setUp();

const row = async (token: string) => {
  const { id } = (await request('get', '/me', token)).body.data;
  return (await one<{
    id: string;
    data: Record<string, string>;
    aadhaar_enc: Buffer | null;
    current_step: number;
    student_active_at: Date;
    basic_completed_at: Date | null;
  }>(`SELECT * FROM applications WHERE account_id = $1`, [id]))!;
};
const ALREADY = 'Your form has already been submitted. A submitted form cannot be changed.';

/* Everything a test may have changed in the masters, back as seeded. */
afterEach(async () => {
  await pool.query(`UPDATE program_options SET is_active = true WHERE deleted_at IS NULL`);
  await pool.query(`DELETE FROM program_fields WHERE is_custom`);
  await pool.query(`DELETE FROM program_options WHERE kind LIKE 'FIELD:%'`);
  await pool.query(`DELETE FROM district_technologies`);
  await pool.query(
    `UPDATE program_fields SET is_active = true, required = key NOT IN ('landmark', 'taluka', 'alternate_mobile_number', 'alternate_email')`,
  );
  await pool.query(`UPDATE program_fields SET label_en = 'Gender' WHERE key = 'gender'`);
  await pool.query(`UPDATE program_fields SET label_en = 'PIN Code' WHERE key = 'pin_code'`);
});

describe('GET /application', () => {
  it('makes the form on first use, with the account’s own details', async () => {
    const s = await makeAccount({ first_name: 'Kavya', last_name: 'Jadhav' });
    expect(await one(`SELECT 1 FROM applications WHERE account_id = $1`, [s.id])).toBeNull();
    const res = await application(s.token);
    expect(res.status).toBe(200);
    const { form, ...rest } = res.body.data;
    expect(rest).toEqual({
      status: 'DRAFT',
      current_step: 1,
      steps: { basic_completed: false, main_completed: false },
      editable: true,
      submitted_at: null,
      draft_files: [],
      submitted_files: [],
      registration: null,
      view_fields: [],
      documents: [],
    });
    /* Every field, as text. */
    expect(Object.keys(form)).toHaveLength(36);
    expect(form).toMatchObject({ first_name: 'Kavya', last_name: 'Jadhav', email: s.email, mobile_number: s.mobile, score: '' });
    expect(Object.values(form).every((v) => typeof v === 'string')).toBe(true);
    /* Only shown: nothing is stored until the student saves. */
    expect((await row(s.token)).data).toEqual({});
  });

  it('two first requests at once make one form', async () => {
    const s = await makeAccount();
    const results = await Promise.all([application(s.token), application(s.token), application(s.token)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await pool.query(`SELECT 1 FROM applications WHERE account_id = $1`, [s.id])).rowCount).toBe(1);
  });

  it.each([
    ['get', '/application'],
    ['put', '/application/steps/1'],
    ['post', '/application/documents'],
    ['delete', '/application/documents/PHOTO'],
    ['get', '/application/documents/PHOTO/file'],
    ['post', '/application/submit'],
  ] as const)('%s %s needs a student session', async (method, path) => {
    const none = await request(method, path);
    expect(none.status).toBe(401);
    expect(none.body.message).toBe('Please log in to continue.');
    expect(code(none)).toBe('UNAUTHORIZED');
    expect((await request(method, path, (await makePanelUser()).token)).status).toBe(401);
  });
});

describe('PUT /application/steps/:step, complete = false (autosave)', () => {
  it('keeps what was typed, merged into what is stored, and the Aadhaar number encrypted', async () => {
    const email = newEmail();
    const token = await verifiedToken(email);
    const aadhaar = newAadhaar();
    const res = await step(
      token,
      1,
      { father_name: 'Suresh Jadhav', aadhaar_number: aadhaar.replace(/(\d{4})(?=\d)/g, '$1 ') },
      false,
    );
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Saved');
    expect(res.body.data.form).toMatchObject({ father_name: 'Suresh Jadhav', aadhaar_number: aadhaar });
    const stored = await row(token);
    expect(stored.data).toEqual({ father_name: 'Suresh Jadhav', email });
    expect(JSON.stringify(stored.data)).not.toContain(aadhaar);
    expect(stored.aadhaar_enc!.toString('latin1')).not.toContain(aadhaar);
    expect(decryptAadhaar(stored.aadhaar_enc!)).toBe(aadhaar);

    await step(token, 1, { mother_name: ' Meena ', date_of_birth: '2030-01-01' }, false);
    /* Step 2 may be typed before step 1 is complete. */
    expect((await step(token, 2, { score: 'abc' }, false)).status).toBe(200);
    const resumed = (await application(token)).body.data;
    expect(resumed.form).toMatchObject({
      father_name: 'Suresh Jadhav',
      mother_name: ' Meena ',
      date_of_birth: '2030-01-01',
      score: 'abc',
      aadhaar_number: aadhaar,
    });
    expect(resumed).toMatchObject({ current_step: 1, steps: { basic_completed: false, main_completed: false } });
  });

  it('ignores keys of another step, unknown and switched-off ones, and never the student’s own e-mail', async () => {
    const email = newEmail();
    const token = await verifiedToken(email);
    await step(token, 1, { gender: 'Female' }, false);
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'gender'`);
    const res = await step(
      token,
      1,
      {
        gender: 'Male',
        x_unknown: '1',
        score: '70',
        status: 'SUBMITTED',
        email: 'other@example.test',
        landmark: 'Near the school',
      },
      false,
    );
    expect(res.status).toBe(200);
    /* The value of a switched-off field stays stored. */
    expect((await row(token)).data).toEqual({ gender: 'Female', landmark: 'Near the school', email });
    expect(res.body.data.form.email).toBe(email);
    await step(token, 2, { email: 'other@example.test', score: '70' }, false);
    expect((await row(token)).data).toMatchObject({ email, score: '70' });
  });

  it('never fails on what is typed: what cannot be saved is left out', async () => {
    const token = await verifiedToken();
    const typed = {
      landmark: 'a\u0000b\u0007c',
      current_address: 'x'.repeat(2500),
      father_name: 'half \ud83d pair 😀',
      taluka: 5,
      mother_name: null,
      ...Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`x_old_${i}`, 'v'])),
    };
    const res = await step(token, 1, typed, false);
    expect(res.status).toBe(200);
    expect((await row(token)).data).toMatchObject({
      landmark: 'abc',
      current_address: 'x'.repeat(2000),
      father_name: 'half  pair 😀',
    });
    expect(res.body.data.form).toMatchObject({ taluka: '', mother_name: '' });
  });

  it('stores the Aadhaar number once it has 12 digits; clearing the field clears it', async () => {
    const token = await verifiedToken();
    const aadhaar = newAadhaar();
    await step(token, 1, { aadhaar_number: aadhaar }, false);
    expect((await step(token, 1, { aadhaar_number: aadhaar.slice(0, 5) }, false)).body.data.form.aadhaar_number).toBe(aadhaar);
    expect((await step(token, 1, { landmark: 'x' }, false)).body.data.form.aadhaar_number).toBe(aadhaar);
    expect((await step(token, 1, { aadhaar_number: ' ' }, false)).body.data.form.aadhaar_number).toBe('');
    expect((await row(token)).aadhaar_enc).toBeNull();
  });

  it('two autosaves at once keep both', async () => {
    const token = await verifiedToken();
    const keys = ['father_name', 'mother_name', 'landmark', 'taluka', 'pin_code', 'current_address'];
    const results = await Promise.all(keys.map((k) => step(token, 1, { [k]: k }, false)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await row(token)).data).toMatchObject(Object.fromEntries(keys.map((k) => [k, k])));
  });

  it('notes the student’s activity', async () => {
    const token = await verifiedToken();
    await application(token);
    await pool.query(`UPDATE applications SET student_active_at = now() - interval '2 days'`);
    await application(token);
    expect(Date.now() - (await row(token)).student_active_at.getTime()).toBeGreaterThan(86_400_000);
    await step(token, 1, { landmark: 'x' }, false);
    expect(Date.now() - (await row(token)).student_active_at.getTime()).toBeLessThan(60_000);
  });

  it('refuses a request that is not a save', async () => {
    const token = await verifiedToken();
    for (const s of [0, 3, 12]) {
      const res = await step(token, s, {}, false);
      expect(res.status).toBe(422);
      expect(fields(res)).toEqual(['params.step']);
    }
    const put = (body: object) => request('put', '/application/steps/1', token).send(body);
    expect(fields(await put({ data: 5 }))).toEqual(['body.data']);
    expect(fields(await put({}))).toEqual(['body.data']);
    expect(fields(await put({ data: {}, complete: 'yes' }))).toEqual(['body.complete']);
    expect(details(await put({ data: {}, status: 'SUBMITTED' }))).toEqual([{ field: 'body.status', message: 'Unknown field' }]);
    /* `complete` may be left out: an autosave. */
    expect((await put({ data: { landmark: 'x' } })).status).toBe(200);
  });
});

describe('PUT /application/steps/:step, complete = true', () => {
  it('checks the step and opens the next one; the student resumes there', async () => {
    const email = newEmail();
    const token = await verifiedToken(email);
    const { basic, main } = await steps();
    const early = await step(token, 2, main);
    expect(early.status).toBe(409);
    expect(early.body.message).toBe('Please complete Step 1 – Basic Details first.');
    expect(code(early)).toBe('CONFLICT');
    /* What was typed is kept all the same. */
    expect((await application(token)).body.data.form.qualification_name).toBe(main.qualification_name);

    const one = await step(token, 1, { ...basic, father_name: '  Suresh Jadhav ', email: 'someone.else@example.test' });
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({
      status: 'DRAFT',
      current_step: 2,
      steps: { basic_completed: true, main_completed: false },
      form: { father_name: 'Suresh Jadhav', email, aadhaar_number: basic.aadhaar_number },
    });
    const two = await step(token, 2, main);
    expect(two.body.data).toMatchObject({ current_step: 3, steps: { basic_completed: true, main_completed: true } });
    const { basic_completed_at: completed } = await row(token);

    /* Step 1 again: it stays open where it was, and keeps when it was first completed. */
    const back = await step(token, 1, { ...basic, landmark: 'Near the bus stand' });
    expect(back.body.data).toMatchObject({ current_step: 3, steps: { basic_completed: true, main_completed: true } });
    expect((await row(token)).basic_completed_at).toEqual(completed);

    const session = (await login(email)).body.data.token as string;
    expect((await application(session)).body.data).toMatchObject({
      current_step: 3,
      form: { landmark: 'Near the bus stand', technology: 'T01' },
    });
  });

  it('a step that is not right stays closed, says why, and keeps what was typed', async () => {
    const token = await verifiedToken();
    const { basic } = await steps();
    const res = await step(token, 1, {
      ...basic,
      date_of_birth: '2030-01-01',
      aadhaar_number: '123412341234',
      pin_code: '41103',
      gender: 'X',
      caste_id: 'not-an-id',
      alternate_mobile_number: '12345',
      alternate_email: 'not-an-email',
      father_name: '',
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('Validation failed');
    expect(details(res)).toEqual([
      { field: 'body.father_name', message: 'Father Name is required' },
      { field: 'body.date_of_birth', message: 'Date of Birth cannot be in the future' },
      { field: 'body.pin_code', message: 'PIN Code must be exactly 6 digits' },
      { field: 'body.aadhaar_number', message: 'Aadhaar Number must be 12 digits with a valid checksum' },
      { field: 'body.caste_id', message: 'Caste not found or inactive' },
      { field: 'body.gender', message: 'Select a valid Gender' },
      { field: 'body.alternate_mobile_number', message: 'Alternate Mobile Number must be a 10-digit Indian number starting 6–9' },
      { field: 'body.alternate_email', message: 'Alternate Email must be a valid email address' },
    ]);
    const after = (await application(token)).body.data;
    expect(after).toMatchObject({ current_step: 1, steps: { basic_completed: false } });
    expect(after.form).toMatchObject({ pin_code: '41103', date_of_birth: '2030-01-01', aadhaar_number: '123412341234' });
  });

  it('a field that is not sent counts as blank', async () => {
    const token = await verifiedToken();
    const { basic } = await steps();
    expect((await step(token, 1, basic)).status).toBe(200);
    const { mother_name: _left, ...rest } = basic;
    expect(details(await step(token, 1, rest))).toEqual([{ field: 'body.mother_name', message: 'Mother Name is required' }]);
  });

  it('the values must be text that can be saved', async () => {
    const token = await verifiedToken();
    const { basic } = await steps();
    expect(
      details(
        await step(token, 1, {
          ...basic,
          landmark: 'a\u0000b',
          taluka: 5,
          current_address: 'x'.repeat(2001),
          religion: '\ud83d',
        }),
      ).sort((a, b) => a.field.localeCompare(b.field)),
    ).toEqual([
      { field: 'body.data.current_address', message: 'Value is too long' },
      { field: 'body.data.landmark', message: 'Value contains characters that cannot be saved' },
      { field: 'body.data.religion', message: 'Value contains characters that cannot be saved' },
      { field: 'body.data.taluka', message: 'Value must be text' },
    ]);
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'v']));
    expect(details(await step(token, 1, many))).toEqual([{ field: 'body.data', message: 'Too many values' }]);
    /* Line breaks and tabs are fine. */
    expect((await step(token, 1, { ...basic, current_address: 'Line 1\r\n\tLine 2' })).status).toBe(200);
  });

  it('refuses the Aadhaar number of a submitted form (two drafts may hold the same)', async () => {
    const centre = await makeCentre();
    const taken = (await makeApplication('SUBMITTED', { centre })).aadhaar;
    const draft = (await makeApplication('BASIC_DONE', { centre })).aadhaar;
    const token = await verifiedToken();
    const { basic } = await steps();
    const res = await step(token, 1, { ...basic, aadhaar_number: taken });
    expect(res.status).toBe(422);
    expect(details(res)).toEqual([
      { field: 'body.aadhaar_number', message: 'A registration with this Aadhaar number already exists' },
    ]);
    expect((await step(token, 1, { ...basic, aadhaar_number: draft })).status).toBe(200);
    /* A deleted form does not hold it. */
    await pool.query(`UPDATE applications SET deleted_at = now() WHERE aadhaar_index IS NOT NULL`);
    expect((await step(token, 1, { ...basic, aadhaar_number: taken })).status).toBe(200);
  });

  it('checks the contacts: the taluka is typed and optional, alternates differ from the first ones', async () => {
    const email = newEmail();
    const token = await verifiedToken(email);
    const { basic } = await steps();
    expect((await step(token, 1, { ...basic, taluka: 'Niphad' })).body.data.form.taluka).toBe('Niphad');
    expect((await step(token, 1, { ...basic, taluka: '' })).body.data.form.taluka).toBe('');
    expect(details(await step(token, 1, { ...basic, taluka: 'N'.repeat(101) }))).toEqual([
      { field: 'body.taluka', message: 'Taluka must be at most 100 characters' },
    ]);
    expect(
      details(
        await step(token, 1, {
          ...basic,
          alternate_mobile_number: `+91 ${basic.mobile_number}`,
          alternate_email: email.toUpperCase(),
        }),
      ),
    ).toEqual([
      { field: 'body.alternate_mobile_number', message: 'Alternate Mobile Number must be different from Mobile Number' },
      { field: 'body.alternate_email', message: 'Alternate Email must be different from Email' },
    ]);
  });

  it('asks for the disability details of a person with a disability only, and drops them otherwise', async () => {
    const token = await verifiedToken();
    const { basic } = await steps();
    expect(fields(await step(token, 1, { ...basic, disability_status: 'Yes' }))).toEqual([
      'body.disability_type',
      'body.disability_certificate_number',
    ]);
    const given = { disability_type: 'Low vision', disability_certificate_number: 'MH12/34-567' };
    expect((await step(token, 1, { ...basic, disability_status: 'Yes', ...given })).status).toBe(200);
    const no = await step(token, 1, { ...basic, disability_status: 'No', ...given });
    expect(no.body.data.form).toMatchObject({ disability_type: '', disability_certificate_number: '' });
    expect(details(await step(token, 1, { ...basic, disability_status: 'Maybe' }))).toEqual([
      { field: 'body.disability_status', message: 'Select a valid Person with Disability' },
    ]);
  });

  it('checks the course: an active center, a technology offered in the district of step 1', async () => {
    const token = await verifiedToken();
    const { basic, main } = await steps();
    await step(token, 1, basic);
    expect(details(await step(token, 2, { ...main, technology: 'T99' }))).toEqual([
      { field: 'body.technology', message: 'Select a valid Technology' },
    ]);
    const closed = await makeCentre({ active: false });
    expect(details(await step(token, 2, { ...main, centre_id: closed, region_id: 'x' }))).toEqual([
      { field: 'body.region_id', message: 'Course District not found or inactive' },
      { field: 'body.centre_id', message: 'Center Name not found or inactive' },
    ]);
    await pool.query(
      `INSERT INTO district_technologies SELECT $1, id FROM program_options WHERE kind = 'TECHNOLOGY' AND code IN ('T03', 'T05')`,
      [await districtId()],
    );
    expect(details(await step(token, 2, main))).toEqual([
      { field: 'body.technology', message: 'Technology is not offered in the selected district' },
    ]);
    expect((await step(token, 2, { ...main, technology: 'T05' })).status).toBe(200);
    /* A district without a selection offers every active technology. */
    await step(token, 1, { ...basic, district_id: await districtId('PUN') });
    expect((await step(token, 2, main)).status).toBe(200);
  });

  it('checks the score by the grading type, and the date', async () => {
    const token = await verifiedToken();
    const { basic, main } = await steps();
    await step(token, 1, basic);
    const issue = async (over: Record<string, string>) => details(await step(token, 2, { ...main, ...over }))[0];
    expect(await issue({ score: '100.5' })).toEqual({ field: 'body.score', message: 'Percentage must be between 0 and 100' });
    expect(await issue({ score: '72.555' })).toEqual({
      field: 'body.score',
      message: 'Enter a number with at most 2 decimal places',
    });
    const cgpa = { grading_type: 'CGPA', cgpa_scale: '4' };
    expect(await issue({ ...cgpa, cgpa_scale: '' })).toEqual({ field: 'body.cgpa_scale', message: 'CGPA Scale is required' });
    expect(await issue({ ...cgpa, score: '4.5' })).toEqual({ field: 'body.score', message: 'CGPA must be between 0 and 4' });
    expect(await issue({ qualification_completed_on: '2999-01-01' })).toEqual({
      field: 'body.qualification_completed_on',
      message: 'Qualification Completed On cannot be in the future',
    });
    const ok = await step(token, 2, { ...main, ...cgpa, cgpa_scale: '10', score: '8.25' });
    expect(ok.body.data.form).toMatchObject({ grading_type: 'CGPA', cgpa_scale: '10', score: '8.25' });
    /* The scale is dropped with the CGPA. */
    expect((await step(token, 2, { ...main, cgpa_scale: '10' })).body.data.form.cgpa_scale).toBe('');
  });

  it('follows the Form fields master: labels, required, switched off, own fields', async () => {
    const token = await verifiedToken();
    const { basic } = await steps();
    await pool.query(`UPDATE program_fields SET label_en = 'Sex' WHERE key = 'gender'`);
    expect(details(await step(token, 1, { ...basic, gender: '' }))).toEqual([
      { field: 'body.gender', message: 'Sex is required' },
    ]);
    await pool.query(`UPDATE program_fields SET required = false WHERE key = 'gender'`);
    expect((await step(token, 1, { ...basic, gender: '' })).status).toBe(200);
    expect(fields(await step(token, 1, { ...basic, gender: 'X' }))).toEqual(['body.gender']);
    expect((await step(token, 1, basic)).status).toBe(200);
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'gender'`);
    expect((await step(token, 1, { ...basic, gender: 'X' })).status).toBe(200);
    expect((await row(token)).data.gender).toBe('Female');

    await pool.query(
      `INSERT INTO program_fields (key, step, type, label_en, required, is_custom, display_order) VALUES
         ('x_blood', 1, 'DROPDOWN', 'Blood Group', true, true, 500), ('x_years', 1, 'NUMBER', 'Years', false, true, 510),
         ('x_since', 1, 'DATE', 'Since', false, true, 520)`,
    );
    await pool.query(`INSERT INTO program_options (kind, code, name_en) VALUES ('FIELD:x_blood', 'A+', 'A positive')`);
    expect(details(await step(token, 1, { ...basic, x_years: 'ten', x_since: '2026-02-30' }))).toEqual([
      { field: 'body.x_blood', message: 'Blood Group is required' },
      { field: 'body.x_years', message: 'Years must be a number' },
      { field: 'body.x_since', message: 'Since must be a real date in YYYY-MM-DD format' },
    ]);
    const ok = await step(token, 1, { ...basic, x_blood: 'A+', x_years: '2.5', x_since: '2026-02-28' });
    expect(ok.body.data.form).toMatchObject({ x_blood: 'A+', x_years: '2.5', x_since: '2026-02-28' });
    /* A deleted own field's value stays with the form. */
    await pool.query(`UPDATE program_fields SET is_active = false, deleted_at = now() WHERE key = 'x_years'`);
    expect((await application(token)).body.data.form.x_years).toBe('2.5');
  });

  it('a choice that is switched off is refused in the draft', async () => {
    const token = await verifiedToken();
    const { basic } = await steps({ caste_id: await optionId('CASTE', 'SAR02') });
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'CASTE' AND code = 'SAR02'`);
    expect(details(await step(token, 1, basic))).toEqual([{ field: 'body.caste_id', message: 'Caste not found or inactive' }]);
  });
});

describe('a submitted form', () => {
  it('refuses every save, whole or in part', async () => {
    const r = await ready();
    expect((await submit(r.token)).status).toBe(201);
    for (const res of [
      await step(r.token, 1, { ...r.basic, father_name: 'Someone Else' }),
      await step(r.token, 1, { father_name: 'Someone Else' }, false),
      await step(r.token, 2, r.main, false),
    ]) {
      expect(res.status).toBe(409);
      expect(code(res)).toBe('ALREADY_SUBMITTED');
      expect(res.body.message).toBe(ALREADY);
    }
    expect((await application(r.token)).body.data.form.father_name).toBe(r.basic.father_name);
  });
});
