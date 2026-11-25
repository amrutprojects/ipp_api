import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { rows } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { makePanelUser, type TestPanelUser } from '../helpers/factory';
import { audits, detailsOf, fieldsOf, get, put } from './helpers';

let admin: TestPanelUser;
let viewer: TestPanelUser;
const contact = { ...config.support };
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Settings Admin' });
  viewer = await makePanelUser('VIEWER');
  Object.assign(config.support, { email: 'help@example.test', mobile: '9000000001' });
});
afterAll(async () => {
  Object.assign(config.support, contact);
  await closeDatabase();
});

const read = async (key: string) => (await get(`/manage/settings/${key}`, viewer.token)).body.data;
const save = (key: string, body: object) => put(`/manage/settings/${key}`, admin.token, body);

describe('batch size', () => {
  it('is 30 until it is set to another whole number from 1 to 100', async () => {
    expect(await read('batch')).toEqual({ size: 30, updated_at: null, updated_by: null, district_required: true });
    for (const [size, message] of [
      [0, 'Batch size must be at least 1'],
      [101, 'Batch size must be at most 100'],
      [2.5, 'Batch size must be a whole number'],
      ['2', 'Batch size must be a number'],
      [null, 'Batch size must be a number'],
    ] as const)
      expect(detailsOf(await save('batch', { size }))).toEqual([{ field: 'body.size', message }]);
    expect(detailsOf(await save('batch', {}))).toEqual([{ field: 'body.size', message: 'Batch size is required' }]);
    expect(await read('batch')).toEqual({ size: 30, updated_at: null, updated_by: null, district_required: true });

    const res = await save('batch', { size: 2 });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Batch size saved');
    expect(res.body.data).toEqual({
      size: 2,
      updated_at: expect.any(String),
      updated_by: 'Settings Admin',
      district_required: true,
    });
    expect(await read('batch')).toEqual(res.body.data);
    expect((await save('batch', { size: 100 })).body.data.size).toBe(100);
    expect((await save('batch', { size: 1 })).body.data.size).toBe(1);
    expect(await rows(`SELECT key FROM settings`)).toEqual([{ key: 'batch' }]);
    const log = await audits('edp.settings.batch');
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ resource: 'settings', resource_id: 'batch', actor_kind: 'PANEL', actor_id: admin.id });
  });
});

describe('support contact', () => {
  const body = {
    message: 'Write to {email} or call {mobile} for help.',
    email: 'Office@Example.test',
    mobile: '+91 85300 92236',
  };

  it('is the standard line with the configured contacts until it is saved', async () => {
    expect(await read('support')).toEqual({
      message:
        'If you have any query related to your registration, you can contact us on email ID {email} or mobile number {mobile}.',
      email: 'help@example.test',
      mobile: '9000000001',
      updated_at: null,
      updated_by: null,
    });
    const res = await save('support', body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Support contact saved');
    expect(res.body.data).toEqual({
      ...body,
      email: 'office@example.test',
      updated_at: expect.any(String),
      updated_by: 'Settings Admin',
    });
    expect(await read('support')).toEqual(res.body.data);
    /* Without placeholders the contacts may be empty. */
    const plain = await save('support', { message: 'Please visit your nearest center for help.', email: ' ', mobile: null });
    expect(plain.body.data).toMatchObject({ email: null, mobile: null });
    expect((await save('support', { message: 'Please visit your nearest center.' })).body.data).toMatchObject({
      email: null,
      mobile: null,
    });
    const log = await audits('edp.settings.support');
    expect(log).toHaveLength(3);
    expect(JSON.stringify(log)).not.toContain('office@');
  });

  it('needs what its message names', async () => {
    expect(detailsOf(await save('support', { message: body.message, email: '', mobile: '' }))).toEqual([
      { field: 'body.email', message: 'Email is required because the message uses {email}' },
      { field: 'body.mobile', message: 'Mobile is required because the message uses {mobile}' },
    ]);
    expect(detailsOf(await save('support', { message: 'Short', email: 'nope', mobile: 'call us' }))).toEqual([
      { field: 'body.message', message: 'Message must be at least 10 characters' },
      { field: 'body.email', message: 'Enter a valid email address' },
      { field: 'body.mobile', message: 'Enter a valid phone number, e.g. 8530092236 or +91 85300 92236' },
    ]);
    expect(detailsOf(await save('support', {}))).toEqual([{ field: 'body.message', message: 'Message is required' }]);
    expect(detailsOf(await save('support', { ...body, message: 'x'.repeat(501) }))[0]).toEqual({
      field: 'body.message',
      message: 'Message must be at most 500 characters',
    });
    expect(fieldsOf(await save('support', { ...body, message: 'Write to us \u0000 now' }))).toEqual(['body.message']);
    expect(fieldsOf(await save('support', { ...body, phone: '1' }))).toEqual(['body.phone']);
    expect((await read('support')).updated_at).toBe(null);
  });
});

describe('welcome message', () => {
  const body = {
    enabled: true,
    title: 'Congratulations, you are registered!',
    message: 'Your mobile number is verified.\nFill in the form in three steps and upload your documents.',
    button_label: 'Start my form',
  };

  it('is the standard text until it is saved; switched off, the wording is kept', async () => {
    const first = await read('welcome');
    expect(first).toEqual({
      enabled: true,
      title: 'Congratulations! Your account is created',
      message: expect.stringContaining('3 Month Internship Placement Program account is ready'),
      button_label: '',
      updated_at: null,
      updated_by: null,
    });
    const res = await save('welcome', body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Welcome message saved');
    expect(res.body.data).toEqual({ ...body, updated_at: expect.any(String), updated_by: 'Settings Admin' });
    expect(await read('welcome')).toEqual(res.body.data);
    const off = await save('welcome', { ...body, enabled: false, button_label: '' });
    expect(off.body.data).toMatchObject({ enabled: false, title: body.title, button_label: '' });
    expect((await save('welcome', { title: body.title, message: body.message })).body.data).toMatchObject({
      enabled: true,
      button_label: '',
    });
    expect(await audits('edp.settings.welcome')).toHaveLength(3);
  });

  it('checks its texts', async () => {
    expect(detailsOf(await save('welcome', { title: 'Hi', message: 'too short' }))).toEqual([
      { field: 'body.title', message: 'Title must be at least 3 characters' },
      { field: 'body.message', message: 'Message must be at least 10 characters' },
    ]);
    expect(
      detailsOf(
        await save('welcome', {
          enabled: 'yes',
          title: 'x'.repeat(121),
          message: 'x'.repeat(1001),
          button_label: 'x'.repeat(61),
        }),
      ),
    ).toEqual([
      { field: 'body.enabled', message: 'enabled must be true or false' },
      { field: 'body.title', message: 'Title must be at most 120 characters' },
      { field: 'body.message', message: 'Message must be at most 1000 characters' },
      { field: 'body.button_label', message: 'Button label must be at most 60 characters' },
    ]);
  });
});

describe('Help button', () => {
  const fields = [
    { label: 'Contact Number', value: '8530092236' },
    { label: 'Email ID', value: 'help@example.test' },
    { label: 'WhatsApp', value: '9876543210' },
    { label: 'Office hours', value: 'Monday to Friday, 10 am to 6 pm' },
  ];
  const body = { enabled: true, title: 'Need any help?', intro: 'The programme office is happy to help.', fields };

  it('shows the configured contacts until it is saved, and keeps complete rows only', async () => {
    expect(await read('help')).toEqual({
      enabled: true,
      title: 'Need help?',
      intro: 'For any query about your registration, you can contact the programme office.',
      fields: [
        { label: 'Contact Number', value: '9000000001' },
        { label: 'Email ID', value: 'help@example.test' },
      ],
      updated_at: null,
      updated_by: null,
    });
    Object.assign(config.support, { email: null, mobile: null });
    expect((await read('help')).fields).toEqual([]);
    const res = await save('help', body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Help contact saved');
    expect(res.body.data).toEqual({ ...body, updated_at: expect.any(String), updated_by: 'Settings Admin' });
    /* The page sends its four rows, blank ones included. */
    const blank = { label: '', value: ' ' };
    const trimmed = await save('help', { ...body, fields: [fields[0], blank, fields[1], blank] });
    expect(trimmed.body.data.fields).toEqual([fields[0], fields[1]]);
    expect((await read('help')).fields).toEqual([fields[0], fields[1]]);
    /* Switched off, it may be empty. */
    expect((await save('help', { ...body, enabled: false, fields: [] })).body.data).toMatchObject({ enabled: false, fields: [] });
    expect((await save('help', { fields: [fields[0]] })).body.data).toMatchObject({
      enabled: true,
      title: 'Need help?',
      intro: '',
    });
  });

  it('names the half-filled rows as they are on the screen', async () => {
    const half = await save('help', {
      title: 'Need help?',
      fields: [{ label: '', value: '' }, { label: 'Contact Number' }, { value: 'help@example.test' }],
    });
    expect(half.status).toBe(422);
    expect(detailsOf(half)).toEqual([
      { field: 'body.fields.1.value', message: 'Value is required when a field name is given' },
      { field: 'body.fields.2.label', message: 'Field name is required when a value is given' },
      { field: 'body.fields', message: 'Add at least one contact detail to show in the Help panel' },
    ]);
    expect(detailsOf(await save('help', { ...body, fields: [] }))).toEqual([
      { field: 'body.fields', message: 'Add at least one contact detail to show in the Help panel' },
    ]);
    expect(detailsOf(await save('help', { ...body, fields: [...fields, { label: 'Fifth', value: 'row' }] }))[0]).toEqual({
      field: 'body.fields',
      message: 'At most 4 fields can be shown',
    });
    expect(
      detailsOf(
        await save('help', {
          title: 'x',
          intro: 'x'.repeat(301),
          fields: [{ label: 'x'.repeat(61), value: 'x'.repeat(201) }],
        }),
      ),
    ).toEqual([
      { field: 'body.title', message: 'Title must be at least 2 characters' },
      { field: 'body.intro', message: 'Intro must be at most 300 characters' },
      { field: 'body.fields.0.label', message: 'Field name must be at most 60 characters' },
      { field: 'body.fields.0.value', message: 'Value must be at most 200 characters' },
    ]);
    expect((await read('help')).updated_at).toBe(null);
  });
});
