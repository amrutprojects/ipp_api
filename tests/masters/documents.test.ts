import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one } from '../../src/db/pool';
import { loadProgram } from '../../src/program/masters';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { addFile, makeApplication, makeCentre, makePanelUser, type TestPanelUser } from '../helpers/factory';
import { audits, del, get, issues, NOBODY, oneOf, patch, post, refused, stored } from './helpers';

interface Document {
  id: string;
  code: string;
  name_en: string;
  name_mr: string | null;
  required: boolean;
  is_active: boolean;
  is_system: boolean;
  kind: string;
  order: number;
  in_use: boolean;
}

let admin: TestPanelUser;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
});
afterAll(closeDatabase);

const list = async () => (await get(admin, '/documents')).body.data as Document[];
const doc = async (code: string) => (await list()).find((d) => d.code === code)!;
const add = async (body: object) => {
  const res = await post(admin, '/documents', body);
  expect(res.status).toBe(201);
  return res.body.data as Document;
};
const asked = async () => (await loadProgram()).documents().map((d) => d.code);

describe('GET /manage/documents', () => {
  it('lists the documents in order, also a switched-off one', async () => {
    const all = await list();
    expect(all.map((d) => [d.code, d.order])).toEqual([
      ['PHOTO', 10],
      ['SIGNATURE', 20],
      ['AADHAAR_CARD', 30],
      ['AADHAAR_PHOTO', 40],
      ['APPLICANT_VIDEO', 50],
      ['PAN_CARD', 60],
      ['HSC_DIPLOMA', 70],
      ['EDU_CERT', 80],
      ['INCOME_EWS', 90],
      ['SCHOOL_LEAVING', 100],
      ['DOMICILE', 110],
    ]);
    expect(all[0]).toEqual({
      id: expect.any(String),
      code: 'PHOTO',
      name_en: 'Photo',
      name_mr: 'छायाचित्र',
      required: true,
      is_active: true,
      is_system: true,
      kind: 'DOCUMENT',
      order: 10,
      in_use: false,
    });
    expect(all.filter((d) => !d.is_active).map((d) => d.code)).toEqual(['HSC_DIPLOMA']);
    expect(await doc('APPLICANT_VIDEO')).toMatchObject({ kind: 'VIDEO', required: false });
  });

  it('says which ones have a file', async () => {
    const { applicationId } = await makeApplication('MAIN_DONE', { centre: await makeCentre() });
    await addFile(applicationId, 'PAN_CARD');
    expect((await list()).filter((d) => d.in_use).map((d) => d.code)).toEqual(['PAN_CARD']);
  });
});

describe('POST /manage/documents', () => {
  it('adds a document with the next code, at the end', async () => {
    const res = await post(admin, '/documents', { name_en: ' Caste  Validity ', name_mr: 'जात वैधता', required: true });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Document added');
    expect(res.body.data).toEqual({
      id: expect.any(String),
      code: 'IPP_DOC_1',
      name_en: 'Caste Validity',
      name_mr: 'जात वैधता',
      required: true,
      is_active: true,
      is_system: false,
      kind: 'DOCUMENT',
      order: 120,
      in_use: false,
    });
    expect(await add({ name_en: 'Interview', required: false, kind: 'VIDEO', order: 5, is_active: false })).toMatchObject({
      code: 'IPP_DOC_2',
      required: false,
      kind: 'VIDEO',
      order: 5,
      is_active: false,
    });
    /* Left out: required, a document, active. */
    expect(await add({ name_en: 'Plain' })).toMatchObject({
      code: 'IPP_DOC_3',
      required: true,
      kind: 'DOCUMENT',
      is_active: true,
    });
    expect((await asked()).slice(-2)).toEqual(['IPP_DOC_1', 'IPP_DOC_3']);
  });

  it('never gives a code twice, also a deleted one', async () => {
    const first = await add({ name_en: 'One' });
    await del(admin, `/documents/${first.id}`);
    expect((await add({ name_en: 'One' })).code).toBe('IPP_DOC_2');
    const both = await Promise.all(['Two', 'Three'].map((name_en) => post(admin, '/documents', { name_en })));
    expect(both.map((r) => r.body.data.code).sort()).toEqual(['IPP_DOC_3', 'IPP_DOC_4']);
  });

  it('says what is wrong, field by field, and refuses a name that is taken', async () => {
    const bad = async (body: object) => issues(await post(admin, '/documents', body));
    expect(await bad({ name_en: ' ' })).toEqual({ 'body.name_en': 'Name is required' });
    expect(await bad({ kind: 'PICTURE', required: 'yes', order: 'x' })).toEqual({
      'body.name_en': 'Name is required',
      'body.kind': 'Choose Document or Video',
      'body.required': 'required must be true or false',
      'body.order': 'Order must be a number',
    });
    expect(await bad({ name_en: 'x'.repeat(151), name_mr: 'y'.repeat(151) })).toEqual({
      'body.name_en': 'Name must be at most 150 characters',
      'body.name_mr': 'Marathi name must be at most 150 characters',
    });
    expect(await bad({ name_en: 'X', code: 'PHOTO' })).toEqual({ 'body.code': 'Unknown field' });
    refused(await post(admin, '/documents', { name_en: 'photo' }), 409, 'A document named "photo" already exists.');
    expect(await list()).toHaveLength(11);
  });

  it('of two of the same name at the same time one is added', async () => {
    const results = await Promise.all([1, 2].map(() => post(admin, '/documents', { name_en: 'Same' })));
    oneOf(201, results, 409, 'A document named "Same" already exists.');
  });
});

describe('PATCH /manage/documents/:id', () => {
  it('renames, orders and switches a document, the program’s own ones too', async () => {
    const photo = await doc('PHOTO');
    const path = `/documents/${photo.id}`;
    const res = await patch(admin, path, { name_en: 'Passport Photo', name_mr: '', required: false, order: 15 });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Document saved');
    expect(res.body.data).toEqual({ ...photo, name_en: 'Passport Photo', name_mr: null, required: false, order: 15 });
    expect((await patch(admin, path, { is_active: false })).body.data).toMatchObject({
      is_active: false,
      name_en: 'Passport Photo',
    });
    expect(await asked()).not.toContain('PHOTO');
    expect((await loadProgram()).documentName('PHOTO')).toBe('Passport Photo');
    expect((await patch(admin, `/documents/${(await doc('HSC_DIPLOMA')).id}`, { is_active: true })).body.data.is_active).toBe(
      true,
    );
    expect(await asked()).toContain('HSC_DIPLOMA');
  });

  it('refuses a taken name, an empty change, another kind, and what does not exist', async () => {
    const path = `/documents/${(await doc('PHOTO')).id}`;
    refused(await patch(admin, path, { name_en: 'SIGNATURE' }), 409, 'A document named "SIGNATURE" already exists.');
    expect(issues(await patch(admin, path, {}))).toEqual({ body: 'Nothing to change' });
    expect(issues(await patch(admin, path, { kind: 'VIDEO', required: true }))).toEqual({ 'body.kind': 'Unknown field' });
    expect((await doc('PHOTO')).kind).toBe('DOCUMENT');
    /* Its own name, in other letters. */
    expect((await patch(admin, path, { name_en: 'PHOTO' })).body.data.name_en).toBe('PHOTO');
    refused(await patch(admin, `/documents/${NOBODY}`, { required: true }), 404, 'Document not found');
  });
});

describe('DELETE /manage/documents/:id', () => {
  it('deletes an own document; its files stay and still have its name', async () => {
    const own = await add({ name_en: 'Caste Validity' });
    const { applicationId } = await makeApplication('MAIN_DONE', { centre: await makeCentre() });
    await addFile(applicationId, own.code);
    expect((await doc(own.code)).in_use).toBe(true);
    const res = await del(admin, `/documents/${own.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Document deleted', data: null });
    expect(await stored('program_documents', own.id)).toEqual({ is_active: false, deleted: true });
    refused(await del(admin, `/documents/${own.id}`), 404, 'Document not found');
    refused(await patch(admin, `/documents/${own.id}`, { required: false }), 404, 'Document not found');
    expect(await asked()).not.toContain(own.code);
    expect((await loadProgram()).documentName(own.code)).toBe('Caste Validity');
    expect(
      (await one<{ n: number }>('SELECT count(*) AS n FROM application_files WHERE document_code = $1', [own.code]))!.n,
    ).toBe(1);
    /* Its name is free again. */
    expect((await add({ name_en: 'Caste Validity' })).code).toBe('IPP_DOC_2');
  });

  it('keeps the documents of the program', async () => {
    const photo = await doc('PHOTO');
    refused(
      await del(admin, `/documents/${photo.id}`),
      409,
      'This document is part of the program and cannot be deleted. Switch it off instead.',
    );
    expect(await stored('program_documents', photo.id)).toEqual({ is_active: true, deleted: false });
  });
});

it('every change is recorded with the panel user, without names', async () => {
  const own = await add({ name_en: 'Caste Validity' });
  await patch(admin, `/documents/${own.id}`, { name_en: 'Validity', required: false });
  await del(admin, `/documents/${own.id}`);
  expect(await audits('edp.document.%')).toEqual(
    [
      { action: 'edp.document.create', details: { code: 'IPP_DOC_1' } },
      { action: 'edp.document.update', details: { code: 'IPP_DOC_1', fields: ['name_en', 'required'] } },
      { action: 'edp.document.delete', details: { code: 'IPP_DOC_1', in_use: false } },
    ].map((e) => ({ ...e, resource: 'program_documents', resource_id: own.id, actor_kind: 'PANEL', actor_id: admin.id })),
  );
});
