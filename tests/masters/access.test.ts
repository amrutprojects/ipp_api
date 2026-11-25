import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, rows } from '../../src/db/pool';
import { VIEW_ONLY } from '../../src/http/auth';
import { mastersApis } from '../../src/modules/masters';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  app,
  districtId,
  makeAccount,
  makeCentre,
  makePanelUser,
  optionId,
  request,
  type TestPanelUser,
  type TestStudent,
} from '../helpers/factory';
import { audits, NOBODY } from './helpers';

/* Method, path and who may call it, of every endpoint of the module. */
const ENDPOINTS = [
  ['get', '/manage/masters', 'panel'],
  ['get', '/manage/masters/:kind', 'panel'],
  ['post', '/manage/masters/:kind', 'admin'],
  ['patch', '/manage/masters/:kind/:id', 'admin'],
  ['delete', '/manage/masters/:kind/:id', 'admin'],
  ['get', '/manage/technologies/districts', 'panel'],
  ['put', '/manage/technologies/districts/:districtId', 'admin'],
  ['get', '/manage/documents', 'panel'],
  ['post', '/manage/documents', 'admin'],
  ['patch', '/manage/documents/:id', 'admin'],
  ['delete', '/manage/documents/:id', 'admin'],
  ['get', '/manage/fields', 'panel'],
  ['post', '/manage/fields', 'admin'],
  ['post', '/manage/fields/test-validation', 'admin'],
  ['patch', '/manage/fields/:id', 'admin'],
  ['delete', '/manage/fields/:id', 'admin'],
  ['get', '/manage/states', 'panel'],
  ['post', '/manage/states', 'admin'],
  ['patch', '/manage/states/:id', 'admin'],
  ['delete', '/manage/states/:id', 'admin'],
  ['get', '/manage/districts', 'panel'],
  ['post', '/manage/districts', 'admin'],
  ['patch', '/manage/districts/:id', 'admin'],
  ['delete', '/manage/districts/:id', 'admin'],
  ['get', '/manage/talukas', 'panel'],
  ['post', '/manage/talukas', 'admin'],
  ['patch', '/manage/talukas/:id', 'admin'],
  ['delete', '/manage/talukas/:id', 'admin'],
  ['get', '/manage/centres', 'panel'],
  ['post', '/manage/centres', 'admin'],
  ['get', '/manage/centres/:id', 'panel'],
  ['patch', '/manage/centres/:id', 'admin'],
  ['patch', '/manage/centres/:id/status', 'admin'],
  ['delete', '/manage/centres/:id', 'admin'],
  ['get', '/geography/states', 'public'],
  ['get', '/geography/states/:stateId/districts', 'public'],
  ['get', '/geography/districts/:districtId/talukas', 'public'],
] as const;

let admin: TestPanelUser;
let viewer: TestPanelUser;
let student: TestStudent;
/* A path of an existing record. */
let real: (path: string) => string;

beforeAll(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  viewer = await makePanelUser('VIEWER');
  student = await makeAccount();
  const id = async (table: string) => (await one<{ id: string }>(`SELECT id FROM ${table} WHERE deleted_at IS NULL LIMIT 1`))!.id;
  const ids: Record<string, string> = {
    '/manage/masters': await optionId('GENDER', 'Male'),
    '/manage/documents': await id('program_documents'),
    '/manage/fields': await id('program_fields'),
    '/manage/states': await id('states'),
    '/manage/districts': await districtId(),
    '/manage/talukas': NOBODY,
    '/manage/centres': await makeCentre(),
  };
  real = (path) =>
    path
      .replace(':kind', 'GENDER')
      .replace(':districtId', ids['/manage/districts']!)
      .replace(':stateId', ids['/manage/states']!)
      .replace(':id', ids[/^\/manage\/[a-z]+/.exec(path)?.[0] ?? ''] ?? '');
});
afterAll(closeDatabase);

const counts = () =>
  rows(
    `SELECT (SELECT count(*) FROM program_options) AS options, (SELECT count(*) FROM program_documents) AS documents,
            (SELECT count(*) FROM program_fields) AS fields, (SELECT count(*) FROM states) AS states,
            (SELECT count(*) FROM districts) AS districts, (SELECT count(*) FROM centres) AS centres,
            (SELECT max(updated_at) FROM program_options) AS changed`,
  );

describe('who may call what', () => {
  it('has exactly these endpoints', () => {
    const declared = mastersApis.flatMap((a) => a.endpoints).map((e) => [e.method, e.path, e.auth]);
    expect(declared).toHaveLength(ENDPOINTS.length);
    for (const e of ENDPOINTS) expect(declared).toContainEqual([...e]);
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth !== 'public'))(
    '%s %s is refused without a panel session',
    async (method, path) => {
      for (const token of [undefined, student.token, 'not-a-token']) {
        const res = await request(method, real(path), token);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ success: false, data: null });
      }
    },
  );

  it.each(ENDPOINTS.filter(([, , auth]) => auth === 'admin'))('%s %s is refused to a VIEWER', async (method, path) => {
    const before = await counts();
    const res = await request(method, real(path), viewer.token).send({ name_en: 'X', is_active: false });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(VIEW_ONLY);
    expect(await counts()).toEqual(before);
    expect(await audits('%')).toEqual([]);
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth === 'panel'))('%s %s is answered to a VIEWER', async (method, path) => {
    const res = await request(method, real(path), viewer.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 200 });
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth === 'public'))('%s %s is answered to everybody', async (method, path) => {
    const res = await request(method, real(path));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it.each(ENDPOINTS.filter(([, path]) => path.includes(':') && !path.endsWith(':kind')))(
    '%s %s: a malformed id and an unknown one are both a record that does not exist',
    async (method, path) => {
      const words: [string, string][] = [
        ['masters', 'Entry not found in this list'],
        ['technologies', 'District not found'],
        ['documents', 'Document not found'],
        ['fields', 'Field not found'],
        ['manage/states', 'State not found'],
        ['manage/districts', 'District not found'],
        ['manage/talukas', 'Taluka not found'],
        ['centres', 'Center not found'],
        ['geography/states', 'State not found'],
        ['geography/districts', 'District not found'],
      ];
      const message = words.find(([w]) => path.includes(w))![1];
      /* What the endpoint accepts, so only the id is wrong. */
      const body = path.includes('technologies')
        ? { codes: [] }
        : path.endsWith('status')
          ? { isActive: true }
          : path.includes('masters') || path.includes('documents')
            ? { name_en: 'X' }
            : path.includes('fields')
              ? { label_en: 'X' }
              : { name: 'Xx' };
      for (const id of ['not-an-id', '1', NOBODY]) {
        const url = path.replace(':kind', 'GENDER').replace(/:(id|stateId|districtId)/, id);
        const res = await request(method, url, admin.token).send(method === 'get' || method === 'delete' ? undefined : body);
        expect({ status: res.status, message: res.body.message }).toEqual({ status: 404, message });
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    },
  );

  it('is in the documentation, with who may call it', async () => {
    const doc = (await supertest(app).get('/api/openapi.json')).body as {
      paths: Record<string, Record<string, { summary: string; description: string }>>;
    };
    for (const [method, path, auth] of ENDPOINTS) {
      const entry = doc.paths[path.replace(/:([A-Za-z]+)/g, '{$1}')]?.[method];
      expect(entry?.summary).toBeTruthy();
      expect(entry?.description).toBe(
        { public: 'Public.', panel: 'Any panel user.', admin: 'A panel ADMIN (a VIEWER gets 403).' }[auth],
      );
    }
  });
});
