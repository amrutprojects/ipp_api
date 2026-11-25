import bcrypt from 'bcrypt';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { makePanelUser, PASSWORD, type TestPanelUser } from '../helpers/factory';
import { audits, detailsOf, fieldsOf, get, patch, post, UNKNOWN_ID } from './helpers';

let admin: TestPanelUser;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Lead Auditor', email: 'lead.auditor@example.test' });
});
afterAll(closeDatabase);

const login = (email: string, password = PASSWORD) => post('/manage/auth/login', undefined, { email, password });

describe('POST /manage/auth/login', () => {
  it('signs a panel user in, and remembers when', async () => {
    const res = await login('  LEAD.Auditor@example.test ');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 200, message: 'Logged in' });
    expect(res.body.data).toEqual({
      token: expect.any(String),
      expires_at: expect.any(String),
      admin: { id: admin.id, name: 'Lead Auditor', email: 'lead.auditor@example.test', role: 'ADMIN' },
    });
    const hours = (Date.parse(res.body.data.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
    const me = await get('/manage/me', res.body.data.token);
    expect(me.body.data).toEqual({ id: admin.id, name: 'Lead Auditor', email: 'lead.auditor@example.test', role: 'ADMIN' });
    const [listed] = (await get('/manage/users', admin.token)).body.data;
    expect(Date.now() - Date.parse(listed.last_login_at)).toBeLessThan(60_000);
  });

  it('gives one answer for an unknown email, a wrong password, and an inactive or deleted account', async () => {
    const inactive = await makePanelUser('VIEWER');
    await pool.query(`UPDATE panel_users SET is_active = false WHERE id = $1`, [inactive.id]);
    const deleted = await makePanelUser('VIEWER');
    await pool.query(`UPDATE panel_users SET deleted_at = now() WHERE id = $1`, [deleted.id]);
    for (const res of [
      await login('nobody@example.test'),
      await login(admin.email, 'Wrong-pass-1'),
      await login(inactive.email),
      await login(deleted.email),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ message: 'Incorrect email or password', data: null, error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('validates the email and the password', async () => {
    expect(detailsOf(await post('/manage/auth/login', undefined, {}))).toEqual([
      { field: 'body.email', message: 'Email is required' },
      { field: 'body.password', message: 'Password is required' },
    ]);
    expect(detailsOf(await login('not-an-email', ''))).toEqual([
      { field: 'body.email', message: 'Enter a valid email address' },
      { field: 'body.password', message: 'Password is required' },
    ]);
    expect(fieldsOf(await login(admin.email, 'x'.repeat(201)))).toEqual(['body.password']);
    expect(
      detailsOf(await post('/manage/auth/login', undefined, { email: admin.email, password: PASSWORD, remember: true })),
    ).toEqual([{ field: 'body.remember', message: 'Unknown field' }]);
  });

  it('lets an account wait after 10 wrong passwords in 15 minutes; a right one clears the count', async () => {
    for (let i = 0; i < 9; i++) expect((await login(admin.email, 'Wrong-pass-1')).status).toBe(401);
    expect((await login(admin.email)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login(admin.email, 'Wrong-pass-1')).status).toBe(401);
    /* Also the right password now. */
    const refused = await login(admin.email);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      message: 'Too many attempts. Please try again later.',
      error: { code: 'RATE_LIMITED' },
    });
    /* Another account is not affected. */
    const other = await makePanelUser('VIEWER');
    expect((await login(other.email)).status).toBe(200);
    /* The window is over: the count starts again. */
    await pool.query(`UPDATE panel_users SET failed_window_start = now() - interval '15 minutes 1 second' WHERE id = $1`, [
      admin.id,
    ]);
    expect((await login(admin.email, 'Wrong-pass-1')).status).toBe(401);
    expect(await one(`SELECT failed_logins FROM panel_users WHERE id = $1`, [admin.id])).toEqual({ failed_logins: 1 });
    expect((await login(admin.email)).status).toBe(200);
    expect(await one(`SELECT failed_logins, failed_window_start FROM panel_users WHERE id = $1`, [admin.id])).toEqual({
      failed_logins: 0,
      failed_window_start: null,
    });
  });

  it('counts tries made at the same time', async () => {
    const all = await Promise.all(Array.from({ length: 16 }, () => login(admin.email, 'Wrong-pass-1')));
    expect(all.filter((r) => r.status === 401)).toHaveLength(10);
    expect(all.filter((r) => r.status === 429)).toHaveLength(6);
  });
});

describe('panel users', () => {
  const add = (over: object = {}, token = admin.token) =>
    post('/manage/users', token, {
      name: 'Priya Viewer',
      email: 'Priya.Viewer@example.test',
      password: 'Viewer-pass-1',
      role: 'VIEWER',
      ...over,
    });

  it('adds a user, who can then sign in; the list is newest first', async () => {
    const res = await add({ name: '  Priya Viewer ' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('User added');
    expect(res.body.data).toEqual({
      id: expect.any(String),
      name: 'Priya Viewer',
      email: 'priya.viewer@example.test',
      role: 'VIEWER',
      is_active: true,
      last_login_at: null,
      created_at: expect.any(String),
    });
    const signedIn = await login('priya.viewer@example.test', 'Viewer-pass-1');
    expect(signedIn.body.data.admin.role).toBe('VIEWER');
    const list = await get('/manage/users', admin.token);
    expect(list.body.meta).toBeUndefined();
    expect(list.body.data.map((u: { email: string }) => u.email)).toEqual([
      'priya.viewer@example.test',
      'lead.auditor@example.test',
    ]);
    expect(Object.keys(list.body.data[0]).sort()).toEqual(Object.keys(res.body.data).sort());

    const stored = (await one<{ password_hash: string }>(`SELECT password_hash FROM panel_users WHERE id = $1`, [
      res.body.data.id,
    ]))!;
    expect(await bcrypt.compare('Viewer-pass-1', stored.password_hash)).toBe(true);
    const [event] = await audits('edp.user.create');
    expect(event).toMatchObject({
      resource: 'panel_user',
      resource_id: res.body.data.id,
      actor_kind: 'PANEL',
      actor_id: admin.id,
      details: { role: 'VIEWER' },
    });
    expect(JSON.stringify(event)).not.toMatch(/priya|Viewer-pass/i);
  });

  it('validates a new user', async () => {
    const bad = await add({ name: 'V', email: 'nope', password: 'short', role: 'BOSS' });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toBe('Validation failed');
    expect(detailsOf(bad)).toEqual([
      { field: 'body.name', message: 'Name must be at least 2 characters' },
      { field: 'body.email', message: 'Enter a valid email address' },
      { field: 'body.password', message: 'Password must be at least 8 characters' },
      { field: 'body.password', message: 'Password must contain a digit' },
      { field: 'body.role', message: 'Choose Admin or Viewer' },
    ]);
    expect(fieldsOf(await post('/manage/users', admin.token, {}))).toEqual([
      'body.email',
      'body.name',
      'body.password',
      'body.role',
    ]);
    /* Longer than bcrypt reads, in characters or in bytes. */
    for (const password of ['x'.repeat(72) + '1', 'अ'.repeat(24) + 'a1'])
      expect((await add({ password })).body.error.details[0]).toEqual({
        field: 'body.password',
        message: 'Password must be at most 72 characters',
      });
    expect(detailsOf(await add({ is_active: true }))).toEqual([{ field: 'body.is_active', message: 'Unknown field' }]);
    expect(detailsOf(await add({ name: 'A\u0000b' }))).toEqual([
      { field: 'body.name', message: 'Name contains characters that cannot be saved' },
    ]);
  });

  it('refuses an email in use, also of an inactive user, and by two at once; a deleted one is free again', async () => {
    const first = await add();
    await pool.query(`UPDATE panel_users SET is_active = false WHERE id = $1`, [first.body.data.id]);
    const twice = await add({ name: 'Someone Else' });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ message: 'A user with this email already exists', error: { code: 'CONFLICT' } });
    await pool.query(`UPDATE panel_users SET deleted_at = now() WHERE id = $1`, [first.body.data.id]);
    const race = await Promise.all([add(), add()]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('switches a user off and on', async () => {
    const viewer = await makePanelUser('VIEWER');
    const off = await patch(`/manage/users/${viewer.id}/status`, admin.token, { is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.message).toBe('User deactivated');
    expect(off.body.data).toEqual({
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      role: 'VIEWER',
      is_active: false,
      last_login_at: null,
      created_at: expect.any(String),
    });
    expect((await get('/manage/me', viewer.token)).status).toBe(401);
    expect((await login(viewer.email)).status).toBe(401);
    const on = await patch(`/manage/users/${viewer.id}/status`, admin.token, { is_active: true });
    expect(on.body).toMatchObject({ message: 'User activated', data: { is_active: true } });
    /* The same once more changes nothing, and is not recorded. */
    expect((await patch(`/manage/users/${viewer.id}/status`, admin.token, { is_active: true })).status).toBe(200);
    expect((await audits('edp.user.status')).map((a) => [a.resource_id, a.actor_id, a.details])).toEqual([
      [viewer.id, admin.id, { isActive: false }],
      [viewer.id, admin.id, { isActive: true }],
    ]);
  });

  it('answers 404 for an unknown user, and 422 for a wrong body', async () => {
    for (const id of [UNKNOWN_ID, 'abc']) {
      const res = await patch(`/manage/users/${id}/status`, admin.token, { is_active: false });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('User not found');
    }
    expect(detailsOf(await patch(`/manage/users/${admin.id}/status`, admin.token, {}))).toEqual([
      { field: 'body.is_active', message: 'is_active is required' },
    ]);
    expect(detailsOf(await patch(`/manage/users/${admin.id}/status`, admin.token, { is_active: 'no' }))).toEqual([
      { field: 'body.is_active', message: 'is_active must be true or false' },
    ]);
  });

  it('lets nobody deactivate their own account', async () => {
    await makePanelUser('ADMIN');
    const res = await patch(`/manage/users/${admin.id}/status`, admin.token, { is_active: false });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('You cannot deactivate your own account');
  });

  it('keeps one active ADMIN, also when two deactivate each other at the same moment', async () => {
    const other = await makePanelUser('ADMIN');
    const off = (id: string, token: string) => patch(`/manage/users/${id}/status`, token, { is_active: false });
    const active = async () =>
      (await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM panel_users WHERE role = 'ADMIN' AND is_active AND deleted_at IS NULL`,
      ))!.n;
    for (let round = 0; round < 5; round++) {
      await pool.query(`UPDATE panel_users SET is_active = true`);
      const both = await Promise.all([off(other.id, admin.token), off(admin.id, other.token)]);
      const statuses = both.map((r) => r.status).sort();
      /* The second is too late: it finds itself the last one's, or no longer signed in. */
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]);
      expect(await active()).toBe(1);
    }
    /* With a third one, an ADMIN deactivated meanwhile changes nothing any more. */
    await pool.query(`UPDATE panel_users SET is_active = true`);
    await makePanelUser('ADMIN');
    const both = await Promise.all([off(other.id, admin.token), off(admin.id, other.token)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await active()).toBe(2);
  });
});
