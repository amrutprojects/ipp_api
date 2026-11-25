import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config';
import { pool, transaction } from '../../src/db/pool';
import {
  batchSettings,
  DEFAULT_SUPPORT_MESSAGE,
  helpSettings,
  saveSetting,
  supportSettings,
  welcomeSettings,
} from '../../src/program/settings';
import { districtId, makeCentre, makePanelUser, optionId, request } from '../helpers/factory';
import { setUp } from './helpers';

setUp();

const options = async () => (await request('get', '/options')).body.data;

const WELCOME = {
  enabled: true,
  title: 'Congratulations! Your account is created',
  message:
    'Your mobile number is verified and your 3 Month Internship Placement Program account is ready. Fill in the form in three steps, upload your documents and submit it — you can see your application any time.',
  button_label: '',
};

describe('GET /options', () => {
  it('is public and lists the form as the masters hold it', async () => {
    const res = await request('get', '/options');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Data retrieved successfully');
    const o = res.body.data;
    expect(o.fields.filter((f: { step: number }) => f.step === 1).map((f: { key: string }) => f.key)).toEqual([
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
    expect(o.fields.filter((f: { step: number }) => f.step === 2).map((f: { key: string }) => f.key)).toEqual([
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
    expect(o.fields[0]).toEqual({
      key: 'first_name',
      step: 1,
      label_en: 'First Name',
      label_mr: 'पहिले नाव',
      required: true,
      type: 'TEXT',
      core: true,
      custom: false,
      order: 10,
      options_kind: null,
      help_en: null,
      help_mr: null,
      validation: null,
    });
    const field = (key: string) => o.fields.find((f: { key: string }) => f.key === key);
    expect(field('educational_status')).toMatchObject({
      type: 'DROPDOWN',
      required: true,
      core: false,
      options_kind: 'EDUCATIONAL_STATUS',
    });
    expect(field('landmark').required).toBe(false);

    expect(Object.keys(o.lists).sort()).toEqual([
      'CASTE',
      'CGPA_SCALE',
      'EDUCATION',
      'EDUCATIONAL_STATUS',
      'GENDER',
      'GRADING_TYPE',
      'MARITAL_STATUS',
      'QUALIFICATION_CLASS',
      'REGION',
      'RELIGION',
      'TECHNOLOGY',
    ]);
    /* A caste, education or region is stored by its id, any other choice by its code. */
    expect(o.lists.CASTE[0]).toEqual({ value: await optionId('CASTE', 'SAR01'), name_en: 'Maratha', name_mr: 'मराठा' });
    expect(o.lists.RELIGION).toEqual([{ value: 'हिंदू', name_en: 'Hindu', name_mr: 'हिंदू' }]);
    expect(o.lists.CGPA_SCALE.map((c: { value: string }) => c.value)).toEqual(['4', '5', '10']);
    expect(o.lists.TECHNOLOGY).toHaveLength(12);

    expect(o.districts).toHaveLength(36);
    expect(o.districts[0]).toEqual({ id: await districtId('AHL'), name: 'Ahilyanagar', code: 'AHL' });
    expect(o.district_technologies).toEqual({});
    expect(o.document_types.map((d: { code: string }) => d.code)).toEqual([
      'PHOTO',
      'SIGNATURE',
      'AADHAAR_CARD',
      'AADHAAR_PHOTO',
      'APPLICANT_VIDEO',
      'PAN_CARD',
      'EDU_CERT',
      'INCOME_EWS',
      'SCHOOL_LEAVING',
      'DOMICILE',
    ]);
    expect(o.document_types[0]).toEqual({
      id: expect.any(String),
      code: 'PHOTO',
      name: 'Photo',
      name_mr: 'छायाचित्र',
      is_mandatory: true,
      kind: 'DOCUMENT',
      formats: ['PDF', 'JPG', 'JPEG', 'PNG'],
      max_mb: 5,
    });
    expect(o.document_types[4]).toMatchObject({ is_mandatory: false, kind: 'VIDEO', formats: ['MP4'], max_mb: 50 });
  });

  it('also names the choices list by list, as the portal’s type of the answer does', async () => {
    const o = await options();
    expect(o.castes.map((c: { id: string }) => c.id)).toEqual(o.lists.CASTE.map((c: { value: string }) => c.value));
    expect(o.castes[0]).toEqual({ id: await optionId('CASTE', 'SAR01'), code: 'SAR01', name: 'मराठा' });
    expect(o.regions).toHaveLength(36);
    expect(o.educations[0]).toMatchObject({ code: 'BA', name: 'B.A.' });
    expect(o.religions).toEqual(['हिंदू']);
    expect(o.genders).toEqual(['Male', 'Female', 'Transgender']);
    expect(o.marital_statuses).toEqual(['Unmarried', 'Married']);
    expect(o.cgpa_scales).toEqual([4, 5, 10]);
    expect(o.qualification_classes).toContain('First Class');
    expect(o.grading_types[0]).toEqual({ code: 'PERCENTAGE', name: 'Percentage', name_mr: 'टक्केवारी' });
    expect(o.educational_statuses[2]).toEqual({ code: 'Completed', name: 'Completed', name_mr: 'पूर्ण' });
    expect(o.tracks).toEqual(o.technologies);
    expect(o.technologies[0]).toEqual({ code: 'T01', name: 'Data Analytics & Business Intelligence' });
  });

  it('leaves out what is switched off', async () => {
    const off = await makeCentre({ active: false, name: 'A closed center' });
    const beta = await makeCentre({ name: 'beta center', code: 'BETA', district: 'PUN' });
    const alpha = await makeCentre({ name: 'Alpha center', code: 'ALPHA' });
    await pool.query(`UPDATE program_options SET is_active = false WHERE kind = 'GENDER' AND code = 'Transgender'`);
    await pool.query(`UPDATE program_fields SET is_active = false WHERE key = 'landmark'`);
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'PAN_CARD'`);
    await pool.query(`UPDATE districts SET is_active = false WHERE code = 'AHL'`);
    await pool.query(
      `INSERT INTO district_technologies SELECT d.id, o.id FROM districts d, program_options o
       WHERE d.code = 'NAS' AND o.kind = 'TECHNOLOGY' AND o.code IN ('T03', 'T01')`,
    );
    try {
      const o = await options();
      expect(o.centres).toEqual([
        { id: alpha, name: 'Alpha center', code: 'ALPHA', district_name: 'Nashik' },
        { id: beta, name: 'beta center', code: 'BETA', district_name: 'Pune' },
      ]);
      expect(o.centres.map((c: { id: string }) => c.id)).not.toContain(off);
      expect(o.lists.GENDER.map((g: { value: string }) => g.value)).toEqual(['Male', 'Female']);
      expect(o.fields.map((f: { key: string }) => f.key)).not.toContain('landmark');
      expect(o.document_types.map((d: { code: string }) => d.code)).not.toContain('PAN_CARD');
      expect(o.districts).toHaveLength(35);
      expect(o.district_technologies).toEqual({ [await districtId('NAS')]: ['T01', 'T03'] });
    } finally {
      await pool.query(`UPDATE program_options SET is_active = true`);
      await pool.query(`UPDATE program_fields SET is_active = true`);
      await pool.query(`UPDATE program_documents SET is_active = true WHERE code = 'PAN_CARD'`);
      await pool.query(`UPDATE districts SET is_active = true`);
      await pool.query(`DELETE FROM district_technologies`);
    }
  });

  it('gives an own dropdown field a list of its own', async () => {
    await pool.query(
      `INSERT INTO program_fields (key, step, type, label_en, is_custom, display_order) VALUES ('x_blood', 1, 'DROPDOWN', 'Blood Group', true, 500)`,
    );
    await pool.query(`INSERT INTO program_options (kind, code, name_en) VALUES ('FIELD:x_blood', 'A+', 'A positive')`);
    try {
      const o = await options();
      expect(o.fields.find((f: { key: string }) => f.key === 'x_blood')).toMatchObject({
        custom: true,
        core: false,
        label_mr: 'Blood Group',
        options_kind: 'FIELD:x_blood',
      });
      expect(o.lists['FIELD:x_blood']).toEqual([{ value: 'A+', name_en: 'A positive', name_mr: null }]);
    } finally {
      await pool.query(
        `DELETE FROM program_fields WHERE key = 'x_blood'; DELETE FROM program_options WHERE kind = 'FIELD:x_blood'`,
      );
    }
  });
});

describe('the settings students see', () => {
  const support = { ...config.support };
  afterEach(async () => {
    Object.assign(config.support, support);
    await pool.query(`DELETE FROM settings`);
  });

  it('are the defaults until the panel saves its own', async () => {
    const o = await options();
    expect(o.support).toEqual({ message: DEFAULT_SUPPORT_MESSAGE, email: null, mobile: null });
    expect(DEFAULT_SUPPORT_MESSAGE).toBe(
      'If you have any query related to your registration, you can contact us on email ID {email} or mobile number {mobile}.',
    );
    expect(o.welcome).toEqual(WELCOME);
    expect(o.help).toEqual({
      enabled: true,
      title: 'Need help?',
      intro: 'For any query about your registration, you can contact the programme office.',
      fields: [],
    });
    Object.assign(config.support, { email: 'help@example.test', mobile: '+91 80000 00000' });
    const configured = await options();
    expect(configured.support).toEqual({
      message: DEFAULT_SUPPORT_MESSAGE,
      email: 'help@example.test',
      mobile: '+91 80000 00000',
    });
    expect(configured.help.fields).toEqual([
      { label: 'Contact Number', value: '+91 80000 00000' },
      { label: 'Email ID', value: 'help@example.test' },
    ]);
  });

  it('are the saved ones, without who saved them', async () => {
    const admin = await makePanelUser('ADMIN', { name: 'Asha Auditor' });
    const saved = {
      support: { message: 'Ask us.', email: 'a@example.test', mobile: null },
      welcome: { enabled: false, title: 'Welcome', message: 'Hello there', button_label: 'Start' },
      help: { enabled: true, title: 'Help', intro: '', fields: [{ label: 'Office', value: '020 1234567' }] },
    };
    await transaction(async (db) => {
      await saveSetting(db, 'support', saved.support, admin.id);
      await saveSetting(db, 'welcome', saved.welcome, admin.id);
      await saveSetting(db, 'help', saved.help, admin.id);
      await saveSetting(db, 'batch', { size: 25 }, admin.id);
      /* Read in the same transaction too. */
      expect((await batchSettings(db)).size).toBe(25);
    });
    const o = await options();
    expect({ support: o.support, welcome: o.welcome, help: o.help }).toEqual(saved);
    const meta = { updated_at: expect.any(Date), updated_by: 'Asha Auditor' };
    expect(await supportSettings()).toEqual({ ...saved.support, ...meta });
    expect(await welcomeSettings()).toEqual({ ...saved.welcome, ...meta });
    expect(await helpSettings()).toEqual({ ...saved.help, ...meta });
    expect(await batchSettings()).toEqual({ size: 25, ...meta });
    /* Saved again: replaced, by whoever saved it last. */
    const other = await makePanelUser('ADMIN', { name: 'Second Auditor' });
    await saveSetting(pool, 'batch', { size: 40 }, other.id);
    expect(await batchSettings()).toEqual({ size: 40, updated_at: expect.any(Date), updated_by: 'Second Auditor' });
  });

  it('never saved: the defaults, and nobody', async () => {
    const nobody = { updated_at: null, updated_by: null };
    expect(await batchSettings()).toEqual({ size: 30, ...nobody });
    expect(await welcomeSettings()).toEqual({ ...WELCOME, ...nobody });
    expect(await supportSettings()).toMatchObject(nobody);
    expect(await helpSettings()).toMatchObject(nobody);
  });

  it('a saved row of another shape is read with care', async () => {
    const put = (key: string, value: unknown) =>
      pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
        key,
        JSON.stringify(value),
      ]);
    for (const size of ['x', 0, 101, 2.5, null]) {
      await put('batch', { size });
      expect((await batchSettings()).size).toBe(30);
    }
    await put('batch', 5);
    expect((await batchSettings()).size).toBe(30);
    await put('welcome', { message: 'Hello' });
    expect(await welcomeSettings()).toMatchObject({ enabled: true, title: WELCOME.title, message: 'Hello', button_label: '' });
    await put('help', {
      enabled: false,
      fields: [
        { label: 'A', value: '1' },
        { label: ' ', value: '2' },
        null,
        { label: 'B' },
        ...'CDEF'.split('').map((l) => ({ label: l, value: l })),
      ],
    });
    expect(await helpSettings()).toMatchObject({
      enabled: false,
      title: 'Need help?',
      intro: '',
      fields: [
        { label: 'A', value: '1' },
        { label: 'C', value: 'C' },
        { label: 'D', value: 'D' },
        { label: 'E', value: 'E' },
      ],
    });
    await put('support', { message: 'Hi', email: 5 });
    expect(await supportSettings()).toMatchObject({ message: 'Hi', email: null, mobile: null });
  });

  it('that cannot be read are the defaults for students, and an error for the panel', async () => {
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) =>
      String(args[0]).includes('FROM settings s ') ? Promise.reject(new Error('down')) : query(...args)) as never);
    const res = await request('get', '/options');
    expect(res.status).toBe(200);
    expect(res.body.data.welcome).toEqual(WELCOME);
    expect(res.body.data.support.message).toBe(DEFAULT_SUPPORT_MESSAGE);
    await expect(batchSettings()).rejects.toThrow('down');
  });
});
