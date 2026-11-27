import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool';
import { ageOn, today } from '../../src/lib/dates';
import type { Form } from '../../src/program/constants';
import { checkForm, fieldText, referenceNames, viewFields } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
import { DEFAULT_CHECKS } from '../../src/program/rules';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { districtId, formValues, makeCentre, newAadhaar, optionId } from '../helpers/factory';

let form: Form;
beforeAll(async () => {
  await resetDatabase();
  form = { ...(await formValues(await makeCentre())), email: 'asha@example.test', aadhaar_number: newAadhaar() };
});
afterEach(() => vi.useRealTimers());
afterAll(closeDatabase);

/* The messages for a changed form, by field. */
async function problems(over: Form = {}, opts: Parameters<typeof checkForm>[2] = {}): Promise<Record<string, string>> {
  const { errors } = await checkForm(await loadProgram(), { ...form, ...over }, opts);
  return Object.fromEntries(errors.map((e) => [e.field!.replace('body.', ''), e.message]));
}
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);
/* A field's checks as Masters → Form fields saves them; null = none. Put back afterwards with `startingChecks`. */
const checks = (key: string, v: object | null) =>
  sql(`UPDATE program_fields SET validation = $2::jsonb WHERE key = $1`, [key, v && JSON.stringify(v)]);
const startingChecks = (key: string) => checks(key, DEFAULT_CHECKS[key] ?? null);

describe('checkForm', () => {
  it('accepts a complete form, and one step of it', async () => {
    expect(await problems()).toEqual({});
    expect(await problems({ technology: '' }, { step: 1 })).toEqual({});
    expect(await problems({ first_name: '' }, { step: 2 })).toEqual({});
  });

  it('asks for every required field by its current label', async () => {
    await sql(`UPDATE program_fields SET label_en = 'Given Name' WHERE key = 'first_name'`);
    const p = await problems({ first_name: '  ', gender: '', landmark: '' });
    expect(p).toEqual({ first_name: 'Given Name is required', gender: 'Gender is required' });
    await sql(`UPDATE program_fields SET label_en = 'First Name' WHERE key = 'first_name'`);
  });

  it('checks the fields of the program by the checks they start with, named by the current label', async () => {
    expect(
      await problems({ first_name: 'A1', pin_code: '012345', mobile_number: '12', aadhaar_number: '123456789012', score: 'x' }),
    ).toEqual({
      first_name: 'First Name may contain only letters and spaces',
      pin_code: 'PIN Code must be exactly 6 digits',
      mobile_number: 'Mobile Number must be a 10-digit Indian number starting 6–9',
      aadhaar_number: 'Aadhaar Number must be 12 digits with a valid checksum',
      score: 'Score must be a number',
    });
    expect(await problems({ score: '72.555' })).toEqual({ score: 'Score must have at most 2 decimal places' });
    await sql(`UPDATE program_fields SET label_en = 'E-mail ID' WHERE key = 'email'`);
    await sql(`UPDATE program_fields SET label_en = 'Birth Date' WHERE key = 'date_of_birth'`);
    expect(await problems({ email: 'not-an-address', date_of_birth: '2999-01-01' })).toEqual({
      email: 'E-mail ID must be a valid email address',
      date_of_birth: 'Birth Date cannot be in the future',
    });
    await sql(`UPDATE program_fields SET label_en = 'Email' WHERE key = 'email'`);
    await sql(`UPDATE program_fields SET label_en = 'Date of Birth' WHERE key = 'date_of_birth'`);
  });

  it('checks the date of birth by its checks only: 14 to 100 to start with, whatever is set up after', async () => {
    const born = (age: number, days = 0) => {
      const [y, m, d] = today().split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y - age, m - 1, d + days)).toISOString().slice(0, 10);
    };
    const ages = (rules: object[]) => checks('date_of_birth', rules.length ? { rules, custom: [] } : null);
    try {
      expect(await problems({ date_of_birth: born(13) })).toEqual({ date_of_birth: 'Date of Birth: age must be at least 14 years' });
      expect(await problems({ date_of_birth: born(101) })).toEqual({ date_of_birth: 'Date of Birth: age must be at most 100 years' });

      await ages([{ type: 'min_age', value: 18 }, { type: 'max_age', value: 35 }]);
      for (const age of [10, 17]) {
        expect(await problems({ date_of_birth: born(age) })).toEqual({ date_of_birth: 'Date of Birth: age must be at least 18 years' });
      }
      expect(await problems({ date_of_birth: born(36) })).toEqual({ date_of_birth: 'Date of Birth: age must be at most 35 years' });
      expect(await problems({ date_of_birth: born(18) })).toEqual({});
      expect(await problems({ date_of_birth: born(36, 1) })).toEqual({});

      /* Only an oldest age: any younger one is accepted. */
      await ages([{ type: 'max_age', value: 35 }]);
      expect(await problems({ date_of_birth: born(10) })).toEqual({});
      expect(await problems({ date_of_birth: born(36) })).toEqual({ date_of_birth: 'Date of Birth: age must be at most 35 years' });
      /* No checks at all: any real day, also one in the future; still a real day. */
      await ages([]);
      expect(await problems({ date_of_birth: '2999-01-01' })).toEqual({});
      expect(await problems({ date_of_birth: '2001-02-30' })).toEqual({
        date_of_birth: 'Date of Birth must be a real date in YYYY-MM-DD format',
      });
    } finally {
      await startingChecks('date_of_birth');
    }
  });

  it('checks nothing of a field beyond its type once its checks are taken away', async () => {
    const keys = ['first_name', 'pin_code', 'mobile_number', 'aadhaar_number', 'alternate_mobile_number', 'score'];
    for (const key of keys) await checks(key, null);
    try {
      expect(
        await problems({
          first_name: 'A1',
          pin_code: '0',
          mobile_number: '12',
          aadhaar_number: '1234',
          alternate_mobile_number: '12',
          score: '250.125',
        }),
      ).toEqual({});
      /* Its type still: a number is a number. */
      expect(await problems({ score: 'x' })).toEqual({ score: 'Score must be a number' });
    } finally {
      for (const key of keys) await startingChecks(key);
    }
  });

  it('a check across fields is one of the checks too: "different from" names the other field by its label', async () => {
    /* The WhatsApp number may be the mobile number (migration 0011): it starts without that check… */
    expect(await problems({ alternate_mobile_number: '+91 ' + form.mobile_number })).toEqual({});
    /* …which an ADMIN can still give it, or any field. */
    await checks('alternate_mobile_number', { rules: [{ type: 'different_from', value: 'mobile_number' }], custom: [] });
    try {
      expect(await problems({ alternate_mobile_number: '+91 ' + form.mobile_number })).toEqual({
        alternate_mobile_number: 'Alternate Mobile Number must be different from Mobile Number',
      });
      await checks('alternate_mobile_number', { rules: [{ type: 'different_from', value: 'first_name' }], custom: [] });
      expect(await problems({ alternate_mobile_number: form.mobile_number! })).toEqual({});
      expect(await problems({ alternate_mobile_number: form.first_name! })).toEqual({
        alternate_mobile_number: 'Alternate Mobile Number must be different from First Name',
      });
    } finally {
      await startingChecks('alternate_mobile_number');
    }
    /* The score within its grading: taken away, a percentage over 100 is accepted. */
    await checks('score', { rules: [{ type: 'max_decimals', value: 2 }], custom: [] });
    try {
      expect(await problems({ score: '100.5' })).toEqual({});
    } finally {
      await startingChecks('score');
    }
  });

  it("checks a mobile number's lengths on the number itself, without +91 or spaces", async () => {
    await checks('mobile_number', {
      rules: [{ type: 'indian_mobile' }, { type: 'min_length', value: 10 }, { type: 'max_length', value: 10 }],
      custom: [],
    });
    try {
      expect(await problems({ mobile_number: '+91 98765 01234' })).toEqual({});
      expect(await problems({ mobile_number: '09876501234' })).toEqual({});
      expect(await problems({ mobile_number: '98765' })).toEqual({
        mobile_number: 'Mobile Number must be a 10-digit Indian number starting 6–9',
      });
    } finally {
      await startingChecks('mobile_number');
    }
  });

  it('leaves a switched-off field out, and does not read it in other rules', async () => {
    await sql(`UPDATE program_fields SET is_active = false WHERE key IN ('gender', 'disability_status')`);
    const { values, errors } = await checkForm(await loadProgram(), { ...form, gender: 'nonsense', disability_status: 'Yes' });
    expect(errors).toEqual([]);
    expect(values.gender).toBeUndefined();
    expect(values.disability_type).toBe('');
    await sql(`UPDATE program_fields SET is_active = true WHERE key IN ('gender', 'disability_status')`);
  });

  it('asks for the disability details only of a person with a disability', async () => {
    expect(await problems({ disability_status: 'Yes' })).toEqual({
      disability_type: 'Type of Disability is required',
      disability_certificate_number: 'Disability Certificate Number is required',
    });
    expect(await problems({ disability_status: 'Maybe' })).toEqual({
      disability_status: 'Select a valid Person with Disability',
    });
    const { values } = await checkForm(await loadProgram(), { ...form, disability_status: 'No', disability_type: 'left over' });
    expect(values.disability_type).toBe('');
  });

  it('limits a score by the grading and the CGPA scale', async () => {
    expect(await problems({ score: '100.01' })).toEqual({ score: 'Percentage must be between 0 and 100' });
    expect(await problems({ grading_type: 'CGPA', cgpa_scale: '4', score: '4.01' })).toEqual({
      score: 'CGPA must be between 0 and 4',
    });
    expect(await problems({ grading_type: 'CGPA', cgpa_scale: '10', score: '9.99' })).toEqual({});
    expect(await problems({ grading_type: 'CGPA', cgpa_scale: '', score: '9' })).toEqual({
      cgpa_scale: 'CGPA Scale is required',
    });
    await sql(`UPDATE program_fields SET required = false WHERE key = 'cgpa_scale'`);
    expect(await problems({ grading_type: 'CGPA', cgpa_scale: '', score: '10.5' })).toEqual({
      score: 'CGPA must be between 0 and 10',
    });
    await sql(`UPDATE program_fields SET required = true WHERE key = 'cgpa_scale'`);
  });

  it('accepts only active choices, districts and centers', async () => {
    const closed = await makeCentre({ active: false });
    expect(
      await problems({ gender: 'Other', religion: 'None', caste_id: 'abc', centre_id: closed, district_id: 'nowhere' }),
    ).toMatchObject({
      gender: 'Select a valid Gender',
      religion: 'Select a valid Religion',
      caste_id: 'Caste not found or inactive',
      centre_id: 'Center Name not found or inactive',
      district_id: 'District not found or inactive',
    });
  });

  it('keeps an unchanged stored value that is no longer offered (the Auditor edits)', async () => {
    await sql(`UPDATE program_options SET is_active = false WHERE kind = 'GENDER' AND code = 'Female'`);
    expect(await problems()).toEqual({ gender: 'Select a valid Gender' });
    expect(await problems({}, { stored: form })).toEqual({});
    expect(await problems({ gender: 'Transgender' }, { stored: form })).toEqual({});
    await sql(`UPDATE program_options SET is_active = true WHERE kind = 'GENDER' AND code = 'Female'`);
  });

  it('offers the technologies of the district', async () => {
    const nas = await districtId('NAS');
    await sql(`INSERT INTO district_technologies VALUES ($1, $2)`, [nas, await optionId('TECHNOLOGY', 'T02')]);
    expect(await problems({ technology: 'T01' })).toEqual({ technology: 'Technology is not offered in the selected district' });
    expect(await problems({ technology: 'T02' })).toEqual({});
    expect(await problems({ technology: 'T01', district_id: await districtId('PUN') })).toEqual({});
    /* An unchanged technology stays only while the district does. */
    expect(await problems({}, { stored: form })).toEqual({});
    expect(await problems({ district_id: nas }, { stored: { ...form, district_id: await districtId('PUN') } })).toEqual({
      technology: 'Technology is not offered in the selected district',
    });
    /* None of the chosen ones is active any more: every active one is offered. */
    await sql(`UPDATE program_options SET is_active = false WHERE kind = 'TECHNOLOGY' AND code = 'T02'`);
    expect(await problems({ technology: 'T01' })).toEqual({});
    await sql(`UPDATE program_options SET is_active = true WHERE kind = 'TECHNOLOGY' AND code = 'T02'`);
    await sql(`DELETE FROM district_technologies`);
  });

  it('wants another alternate e-mail; the alternate (WhatsApp) number may be the mobile number', async () => {
    expect(await problems({ alternate_mobile_number: '+91 98765-43210', alternate_email: 'ASHA@example.test' })).toEqual({
      alternate_email: 'Alternate Email must be different from Email',
    });
  });

  it('checks own fields by their type and choices', async () => {
    await sql(`INSERT INTO program_fields (key, step, type, label_en, required, is_custom) VALUES
      ('x_n', 1, 'NUMBER', 'Family size', true, true), ('x_d', 1, 'DATE', 'Joined', false, true), ('x_o', 2, 'DROPDOWN', 'Shift', false, true)`);
    await sql(`INSERT INTO program_options (kind, code, name_en) VALUES ('FIELD:x_o', 'Morning', 'Morning')`);
    expect(await problems({ x_n: 'four', x_d: '2025-02-30', x_o: 'Night' })).toEqual({
      x_n: 'Family size must be a number',
      x_d: 'Joined must be a real date in YYYY-MM-DD format',
      x_o: 'Select a valid Shift',
    });
    expect(await problems({})).toEqual({ x_n: 'Family size is required' });
    expect(await problems({ x_n: '4', x_d: '2025-02-28', x_o: 'Morning' })).toEqual({});
    await sql(`UPDATE program_fields SET is_active = false, deleted_at = now() WHERE is_custom`);
  });

  it('counts days and ages where the program is run', async () => {
    /* 20:00 UTC on 31 December is already 1 January in India. */
    vi.useFakeTimers({ now: new Date('2025-12-31T20:00:00Z'), toFake: ['Date'] });
    expect(today()).toBe('2026-01-01');
    expect(await problems({ qualification_completed_on: '2026-01-01', date_of_birth: '2012-01-01' })).toEqual({});
    expect(await problems({ qualification_completed_on: '2026-01-02', date_of_birth: '2012-01-02' })).toEqual({
      qualification_completed_on: 'Qualification Completed On cannot be in the future',
      date_of_birth: 'Date of Birth: age must be at least 14 years',
    });
    expect(ageOn('2000-02-29', '2025-02-28')).toBe(24);
    expect(ageOn('2000-02-29', '2025-03-01')).toBe(25);
  });
});

describe('how a form is shown', () => {
  it('shows names for choices, also switched-off and deleted ones, and masks the Aadhaar', async () => {
    await sql(
      `UPDATE program_options SET is_active = false, deleted_at = now() WHERE kind = 'MARITAL_STATUS' AND code = 'Unmarried'`,
    );
    const program = await loadProgram();
    const names = await referenceNames(program, form);
    expect(names).toMatchObject({
      caste: 'मराठा',
      religion: 'हिंदू',
      district: 'Nashik',
      course_centre: 'Nashik',
      education: 'BCA',
    });
    const text = Object.fromEntries(viewFields(program, form, names, null).map((f) => [f.key, f.text]));
    expect(text).toMatchObject({
      gender: 'Female',
      marital_status: 'Unmarried',
      technology: 'Data Analytics & Business Intelligence',
    });
    expect(text.aadhaar_number).toMatch(/^XXXX-XXXX-[0-9]{4}$/);
    expect(viewFields(program, form, names, null).find((f) => f.key === 'aadhaar_number')!.value).toBe('');
    expect(fieldText(program, program.field('landmark')!, form, names, null)).toBe('');
  });

  it('shows a switched-off field only while it has a value', async () => {
    await sql(`UPDATE program_fields SET is_active = false WHERE key IN ('landmark', 'pin_code')`);
    const program = await loadProgram();
    const keys = viewFields(program, form, await referenceNames(program, form), null).map((f) => f.key);
    expect(keys).toContain('pin_code');
    expect(keys).not.toContain('landmark');
  });
});
