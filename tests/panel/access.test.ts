import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { panelApis } from '../../src/modules/panel';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { app, BASE, makeAccount, makeApplication, makeCentre, makePanelUser, type TestPanelUser } from '../helpers/factory';
import { get, post, put, UNKNOWN_ID } from './helpers';

/* Who may call what: every endpoint of the panel, as declared. */
const ENDPOINTS: [method: string, path: string, auth: 'public' | 'panel' | 'admin'][] = [
  ['post', '/manage/auth/login', 'public'],
  ['get', '/manage/me', 'panel'],
  ['get', '/manage/summary', 'panel'],
  ['get', '/manage/filters', 'panel'],
  ['get', '/manage/applicants', 'panel'],
  ['get', '/manage/applicants/:id', 'panel'],
  ['post', '/manage/applicants/:id/approve', 'admin'],
  ['post', '/manage/applicants/approve-selected', 'admin'],
  ['post', '/manage/applicants/:id/documents/:docType/verify', 'admin'],
  ['post', '/manage/applicants/:id/return', 'admin'],
  ['get', '/manage/applicants/:id/returns', 'panel'],
  /* Trash: a deleted applicant is listed there and can be brought back. */
  ['get', '/manage/applicants/trash', 'panel'],
  ['delete', '/manage/applicants/:id', 'admin'],
  ['post', '/manage/applicants/:id/restore', 'admin'],
  ['get', '/manage/applicants/:id/documents/:docType/file', 'panel'],
  ['get', '/manage/applicants/:id/documents.zip', 'panel'],
  ['put', '/manage/applicants/:id/form', 'admin'],
  ['post', '/manage/applicants/:id/documents', 'admin'],
  ['get', '/manage/applicants/:id/follow-ups', 'panel'],
  ['post', '/manage/applicants/:id/follow-ups', 'admin'],
  ['get', '/manage/batches', 'panel'],
  ['post', '/manage/batches', 'admin'],
  ['get', '/manage/batches/:id', 'panel'],
  ['patch', '/manage/batches/:id', 'admin'],
  ['get', '/manage/settings/batch', 'panel'],
  ['put', '/manage/settings/batch', 'admin'],
  ['get', '/manage/settings/support', 'panel'],
  ['put', '/manage/settings/support', 'admin'],
  ['get', '/manage/settings/welcome', 'panel'],
  ['put', '/manage/settings/welcome', 'admin'],
  ['get', '/manage/settings/help', 'panel'],
  ['put', '/manage/settings/help', 'admin'],
  ['get', '/manage/settings/rejection', 'panel'],
  ['put', '/manage/settings/rejection', 'admin'],
  ['get', '/manage/link', 'panel'],
  ['post', '/manage/link/retry', 'admin'],
  ['post', '/manage/link/test', 'admin'],
  ['get', '/manage/users', 'admin'],
  ['post', '/manage/users', 'admin'],
  ['patch', '/manage/users/:id', 'admin'],
  ['delete', '/manage/users/:id', 'admin'],
  ['patch', '/manage/users/:id/status', 'admin'],
];
const declared = () => panelApis.flatMap((a) => a.endpoints);
const address = (path: string) => `${BASE}${path.replace(':id', UNKNOWN_ID).replace(':docType', 'PHOTO')}`;
type Method = 'get' | 'post' | 'put' | 'patch';

let admin: TestPanelUser;
let viewer: TestPanelUser;
beforeAll(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  viewer = await makePanelUser('VIEWER');
});
afterAll(closeDatabase);

describe('who may call the panel', () => {
  it('has the 42 endpoints of the panel, each with its guard', () => {
    const sorted = (list: string[][]) => list.map((e) => e.join(' ')).sort();
    expect(sorted(declared().map((e) => [e.method, e.path, e.auth]))).toEqual(sorted(ENDPOINTS));
    expect(ENDPOINTS).toHaveLength(42);
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth !== 'public'))('%s %s needs a panel session', async (method, path) => {
    const call = () => supertest(app)[method as Method](address(path));
    const none = await call();
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({ success: false, message: 'Please log in to continue.', error: { code: 'UNAUTHORIZED' } });
    /* A student's session is of another audience, whoever the student is. */
    const student = await makeAccount();
    const other = await call().set('Authorization', `Bearer ${student.token}`);
    expect(other.status).toBe(401);
    expect(other.body).toMatchObject({ message: 'Your session has expired. Please log in again.' });
    expect((await call().set('Authorization', 'Bearer not-a-token')).status).toBe(401);
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth === 'admin'))('%s %s is refused to a VIEWER', async (method, path) => {
    const res = await supertest(app)[method as Method](address(path)).set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      message: 'Your account can only view. Ask an administrator to make this change.',
      error: { code: 'FORBIDDEN' },
    });
  });

  it('lets a VIEWER see everything but the users', async () => {
    const centre = await makeCentre();
    const { student } = await makeApplication('SUBMITTED', { centre, by: admin });
    for (const path of [
      '/manage/me',
      '/manage/summary',
      '/manage/filters',
      '/manage/applicants',
      `/manage/applicants/${student.id}`,
      `/manage/applicants/${student.id}/follow-ups`,
      `/manage/applicants/${student.id}/documents/PHOTO/file`,
      `/manage/applicants/${student.id}/documents.zip`,
      '/manage/batches',
      '/manage/settings/batch',
      '/manage/settings/support',
      '/manage/settings/welcome',
      '/manage/settings/help',
      '/manage/settings/rejection',
      `/manage/applicants/${student.id}/returns`,
      '/manage/link',
    ])
      expect([path, (await get(path, viewer.token)).status]).toEqual([path, 200]);
  });

  it('reads the account on every request: a role change or a deactivation works at once, a password change ends the session', async () => {
    const user = await makePanelUser('ADMIN');
    expect((await get('/manage/users', user.token)).status).toBe(200);
    await pool.query(`UPDATE panel_users SET role = 'VIEWER' WHERE id = $1`, [user.id]);
    expect((await get('/manage/users', user.token)).status).toBe(403);
    expect((await get('/manage/me', user.token)).body.data.role).toBe('VIEWER');
    await pool.query(`UPDATE panel_users SET password_changed_at = now() WHERE id = $1`, [user.id]);
    expect((await get('/manage/me', user.token)).status).toBe(401);
    const second = await makePanelUser('VIEWER');
    await pool.query(`UPDATE panel_users SET is_active = false WHERE id = $1`, [second.id]);
    expect((await get('/manage/me', second.token)).status).toBe(401);
    const third = await makePanelUser('VIEWER');
    await pool.query(`UPDATE panel_users SET is_active = false, deleted_at = now() WHERE id = $1`, [third.id]);
    expect((await get('/manage/me', third.token)).status).toBe(401);
  });

  it('checks who is calling before what is sent, and what is sent before the record', async () => {
    expect((await put('/manage/settings/batch', viewer.token, { size: 'x' })).status).toBe(403);
    expect((await post(`/manage/applicants/${UNKNOWN_ID}/follow-ups`, admin.token, {})).status).toBe(422);
    expect((await post(`/manage/applicants/not-an-id/follow-ups`, admin.token, {})).status).toBe(404);
  });

  it('documents every endpoint with its answer and its errors', async () => {
    const doc = (await supertest(app).get('/api/openapi.json')).body as {
      paths: Record<string, Record<string, { summary: string; responses: Record<string, unknown> }>>;
    };
    for (const [method, path, auth] of ENDPOINTS) {
      const operation = doc.paths[path.replace(/:([A-Za-z]+)/g, '{$1}')]?.[method];
      expect([path, operation?.summary.length]).toEqual([path, expect.any(Number)]);
      if (auth === 'admin') expect(operation!.responses['403']).toBeDefined();
    }
  });
});
