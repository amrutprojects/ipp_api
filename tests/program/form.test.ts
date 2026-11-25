import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool';
import { ageOn, today } from '../../src/lib/dates';
import type { Form } from '../../src/program/constants';
import { checkForm, fieldText, referenceNames, viewFields } from '../../src/program/form';
import { loadProgram } from '../../src/program/masters';
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

  it('uses the current label in the messages of the formats', async () => {
    expect(
      await problems({ first_name: 'A1', pin_code: '012345', mobile_number: '12', aadhaar_number: '123456789012', score: 'x' }),
    ).toEqual({
      first_name: "First Name may contain only letters, spaces and . ' -",
      pin_code: 'PIN Code must be exactly 6 digits',
      mobile_number: 'Mobile Number must be a 10-digit Indian number starting 6–9',
      aadhaar_number: 'Aadhaar Number must be 12 digits with a valid checksum',
      score: 'Enter a number with at most 2 decimal places',
    });
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

  it('wants other alternate contacts', async () => {
    expect(await problems({ alternate_mobile_number: '+91 98765-43210', alternate_email: 'ASHA@example.test' })).toEqual({
      alternate_mobile_number: 'Alternate Mobile Number must be different from Mobile Number',
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
      date_of_birth: 'Applicant must be between 14 and 100 years old',
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
