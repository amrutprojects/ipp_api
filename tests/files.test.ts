import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { fileOfToken, fileToken, LINK_SECONDS } from '../src/program/file-links';
import { closeDatabase, resetDatabase } from './helpers/db';
import { FILES, makeApplication, makeCentre, makePanelUser, request, type TestApplication, type TestPanelUser } from './helpers/factory';

/*
 * A document opened by a short-lived link (program/file-links.ts): asked for with a session, then opened by the browser tab
 * straight from GET /files/:token, which streams it so it shows as it arrives.
 */

let admin: TestPanelUser;
let s: TestApplication;
let other: TestApplication;
beforeAll(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN');
  const centre = await makeCentre();
  s = await makeApplication('SUBMITTED', { centre, by: admin });
  other = await makeApplication('SUBMITTED', { centre, by: admin });
});
afterAll(closeDatabase);

const linkOf = async (path: string, token: string) => {
  const res = await request('get', path, token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { url: string; expires_at: string };
};
/* GET of a link's address as the browser tab does it: no session. */
const open = (url: string) => request('get', url.replace(/^\/api\/v1\/edp/, ''));

describe('document links', () => {
  it('the student gets a link to their own file; the tab opens it without a session, streamed with its type and size', async () => {
    const link = await linkOf('/application/documents/PHOTO/link', s.student.token);
    expect(link.url).toMatch(/^\/api\/v1\/edp\/files\/[\w-]+\.[\w-]+$/);
    /* No name, mobile number or storage path in the address. */
    expect(link.url).not.toMatch(new RegExp(`${s.student.first_name}|${s.student.mobile}|candidates|drafts`, 'i'));
    expect(new Date(link.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(LINK_SECONDS * 1000);
    const res = await open(link.url).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(FILES.pdf.length));
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="photo.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe(`private, max-age=${LINK_SECONDS}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(Buffer.from(res.body as Buffer).equals(FILES.pdf)).toBe(true);
  });

  it('a panel user (a viewer too) gets a link to a student document', async () => {
    const viewer = await makePanelUser('VIEWER');
    const link = await linkOf(`/manage/applicants/${s.student.id}/documents/PHOTO/link`, viewer.token);
    expect((await open(link.url)).status).toBe(200);
    expect((await request('get', `/manage/applicants/${s.student.id}/documents/NOPE/link`, admin.token)).status).toBe(404);
    expect((await request('get', `/manage/applicants/${s.student.id}/documents/PHOTO/link`)).status).toBe(401);
    expect((await request('get', `/manage/applicants/${s.student.id}/documents/PHOTO/link`, s.student.token)).status).toBe(401);
  });

  it('a link that is expired, changed or made up opens nothing, nor one of a deleted form', async () => {
    const id = (await pool.query<{ id: string }>(`SELECT id FROM application_files WHERE application_id = $1 LIMIT 1`, [s.applicationId]))
      .rows[0]!.id;
    const old = fileToken(id, Date.now() - (LINK_SECONDS + 1) * 1000).token;
    expect(fileOfToken(old)).toBeNull();
    expect((await open(`/api/v1/edp/files/${old}`)).status).toBe(404);
    /* Another file's id under this file's signature. */
    const theirs = (await pool.query<{ id: string }>(`SELECT id FROM application_files WHERE application_id = $1 LIMIT 1`, [other.applicationId]))
      .rows[0]!.id;
    const [, signature] = fileToken(id).token.split('.');
    const forged = `${Buffer.from(`${theirs}.${Math.floor(Date.now() / 1000) + 60}`).toString('base64url')}.${signature}`;
    expect((await open(`/api/v1/edp/files/${forged}`)).status).toBe(404);
    expect((await open('/api/v1/edp/files/not-a.token')).status).toBe(404);
    expect((await open('/api/v1/edp/files/no-dot')).status).toBe(404);

    const fresh = fileToken(id).token;
    expect(fileOfToken(fresh)).toBe(id);
    await pool.query(`UPDATE applications SET deleted_at = now() WHERE id = $1`, [s.applicationId]);
    try {
      expect((await open(`/api/v1/edp/files/${fresh}`)).status).toBe(404);
    } finally {
      await pool.query(`UPDATE applications SET deleted_at = NULL WHERE id = $1`, [s.applicationId]);
    }
  });

  it('a student cannot get a link to a document they have not uploaded', async () => {
    expect((await request('get', '/application/documents/NOPE/link', s.student.token)).status).toBe(404);
    expect((await request('get', '/application/documents/PHOTO/link')).status).toBe(401);
  });
});
