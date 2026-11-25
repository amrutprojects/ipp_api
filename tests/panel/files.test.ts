import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { storage } from '../../src/services/storage';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { addFile, FILES, makeAccount, makeApplication, makeCentre, makePanelUser, type TestPanelUser } from '../helpers/factory';
import { bytes, get, UNKNOWN_ID, unzip } from './helpers';

let viewer: TestPanelUser;
let centre: string;
beforeEach(async () => {
  await resetDatabase();
  viewer = await makePanelUser('VIEWER');
  centre = await makeCentre();
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeDatabase);

const file = (id: string, code: string, query = '') =>
  bytes(`/manage/applicants/${id}/documents/${code}/file${query}`, viewer.token);
const zip = (id: string) => bytes(`/manage/applicants/${id}/documents.zip`, viewer.token);
const codeOf = async (id: string) =>
  (await one<{ registration_code: string }>(`SELECT registration_code FROM applications WHERE account_id = $1`, [id]))!
    .registration_code;
const kavya = { first_name: 'Kavya', last_name: 'Jadhav' };

describe('one document', () => {
  it('opens inline under its own name, private and not executable', async () => {
    const s = await makeApplication('SUBMITTED', { centre, account: kavya });
    await addFile(s.applicationId, 'APPLICANT_VIDEO', FILES.mp4, 'my video (1).mp4');
    await pool.query(`UPDATE application_files SET mime_type = 'video/mp4' WHERE document_code = 'APPLICANT_VIDEO'`);
    const photo = await file(s.student.id, 'PHOTO');
    expect(photo.status).toBe(200);
    expect(photo.body).toEqual(FILES.pdf);
    expect(photo.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="photo.pdf"; filename*=UTF-8''photo.pdf`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    const video = await file(s.student.id, 'applicant_video');
    expect(video.body).toEqual(FILES.mp4);
    expect(video.headers['content-type']).toBe('video/mp4');
    expect(video.headers['content-disposition']).toBe(
      `inline; filename="my_video__1_.mp4"; filename*=UTF-8''my%20video%20%281%29.mp4`,
    );
  });

  it('downloads under the name of the candidate', async () => {
    const s = await makeApplication('SUBMITTED', { centre, account: kavya });
    const name = `${await codeOf(s.student.id)}_Kavya_Jadhav_PAN_Card.pdf`;
    const res = await file(s.student.id, 'PAN_CARD', '?download=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
    expect(name).toMatch(/^IPP-\d{6}_/);
    const other = await file(s.student.id, 'EDU_CERT', '?download=1');
    expect(other.headers['content-disposition']).toContain('_Highest_Qualification_Certificate_Marksheet.pdf"');
    /* Read by the portal from another origin. */
    const cross = await file(s.student.id, 'PAN_CARD', '?download=1').set('Origin', 'http://localhost:5176');
    expect(cross.headers['access-control-expose-headers']).toContain('Content-Disposition');
    expect((await file(s.student.id, 'PAN_CARD', '?download=0')).headers['content-disposition']).toMatch(/^inline/);
    expect((await get(`/manage/applicants/${s.student.id}/documents/PAN_CARD/file?download=yes`, viewer.token)).status).toBe(422);
  });

  it('keeps names in other scripts, and letters out of the file names that cannot hold them', async () => {
    const s = await makeApplication('SUBMITTED', {
      centre,
      account: { first_name: 'काव्या', last_name: 'Jadhav Patil' },
      values: { first_name: 'काव्या', last_name: 'Jadhav Patil' },
    });
    await pool.query(`UPDATE application_files SET original_name = $1 WHERE document_code = 'PHOTO'`, ["माझा 'फोटो'.pdf"]);
    const header = (await file(s.student.id, 'PHOTO')).headers['content-disposition'] as string;
    expect(header).toMatch(/^inline; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/);
    expect(decodeURIComponent(/UTF-8''(.+)$/.exec(header)![1]!)).toBe("माझा 'फोटो'.pdf");
    const code = await codeOf(s.student.id);
    expect((await file(s.student.id, 'PHOTO', '?download=1')).headers['content-disposition']).toContain(
      `filename="${code}_Jadhav_Patil_Photo.pdf"`,
    );
  });

  it('is there for drafts too, under the name of the account until the form has one', async () => {
    const s = await makeApplication('DRAFT', { centre, account: kavya });
    await addFile(s.applicationId, 'PHOTO');
    const res = await file(s.student.id, 'PHOTO', '?download=1');
    expect(res.headers['content-disposition']).toContain('filename="DRAFT_Kavya_Jadhav_Photo.pdf"');
    const named = await makeApplication('BASIC_DONE', { centre, values: { first_name: 'Asha', last_name: 'Pawar' } });
    await addFile(named.applicationId, 'PHOTO');
    expect((await file(named.student.id, 'PHOTO', '?download=1')).headers['content-disposition']).toContain(
      'filename="DRAFT_Asha_Pawar_Photo.pdf"',
    );
  });

  it('answers 404 when there is none', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    for (const code of ['APPLICANT_VIDEO', 'FITNESS', '%00', 'a%2Fb']) {
      const res = await get(`/manage/applicants/${s.student.id}/documents/${code}/file`, viewer.token);
      expect([code, res.status, res.body.message]).toEqual([code, 404, 'No file has been uploaded for this document']);
    }
    for (const id of [UNKNOWN_ID, 'abc']) {
      const res = await get(`/manage/applicants/${id}/documents/PHOTO/file`, viewer.token);
      expect([id, res.status, res.body.message]).toEqual([id, 404, 'Student not found']);
    }
    const none = await get(`/manage/applicants/${(await makeAccount()).id}/documents/PHOTO/file`, viewer.token);
    expect(none.body.message).toBe('No file has been uploaded for this document');
    /* Lost by the storage: an answer, not a broken connection. */
    const [stored] = await rows<{ storage_key: string }>(
      `SELECT storage_key FROM application_files WHERE application_id = $1 AND document_code = 'PHOTO'`,
      [s.applicationId],
    );
    await storage.remove(stored!.storage_key);
    expect((await get(`/manage/applicants/${s.student.id}/documents/PHOTO/file`, viewer.token)).status).toBe(404);
  });
});

describe('all documents as a ZIP', () => {
  it('holds one folder of the candidate, the documents in the order of the form', async () => {
    const s = await makeApplication('SUBMITTED', { centre, account: kavya });
    await addFile(s.applicationId, 'APPLICANT_VIDEO', FILES.mp4, 'video.mp4');
    /* One that is no longer asked for comes last. */
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'SIGNATURE'`);
    const folder = `${await codeOf(s.student.id)}_Kavya_Jadhav`;
    const res = await zip(s.student.id);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${folder}.zip"; filename*=UTF-8''${folder}.zip`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    const entries = await unzip(res.body as Buffer);
    expect(entries.map((e) => e.name)).toEqual([
      `${folder}/01_Photo.pdf`,
      `${folder}/02_Aadhar_Card.pdf`,
      `${folder}/03_Applicant_Photograph_with_Aadhaar.pdf`,
      `${folder}/04_Applicant_Video_with_Aadhaar.pdf`,
      `${folder}/05_PAN_Card.pdf`,
      `${folder}/06_Highest_Qualification_Certificate_Marksheet.pdf`,
      `${folder}/07_EWS_Certificate.pdf`,
      `${folder}/08_School_Leaving_Certificate_Transfer_Certificate.pdf`,
      `${folder}/09_Domicile_of_Certificate_Maharashtra.pdf`,
      `${folder}/10_Signature.pdf`,
    ]);
    expect(entries[0]!.content).toEqual(FILES.pdf);
    expect(entries[3]!.content).toEqual(FILES.mp4);
  });

  it('is there for drafts too', async () => {
    const s = await makeApplication('DRAFT', { centre, account: kavya });
    await addFile(s.applicationId, 'PAN_CARD');
    const res = await zip(s.student.id);
    expect(res.headers['content-disposition']).toContain('filename="DRAFT_Kavya_Jadhav.zip"');
    expect((await unzip(res.body as Buffer)).map((e) => e.name)).toEqual(['DRAFT_Kavya_Jadhav/06_PAN_Card.pdf']);
  });

  it('answers 404 when nothing was uploaded or the student is unknown', async () => {
    const draft = await makeApplication('DRAFT', { centre });
    for (const id of [draft.student.id, (await makeAccount()).id]) {
      const res = await get(`/manage/applicants/${id}/documents.zip`, viewer.token);
      expect([res.status, res.body.message]).toEqual([404, 'No documents have been uploaded yet']);
    }
    for (const id of [UNKNOWN_ID, 'abc']) {
      const res = await get(`/manage/applicants/${id}/documents.zip`, viewer.token);
      expect([res.status, res.body.message]).toEqual([404, 'Student not found']);
    }
  });

  it('survives a file the storage has lost: the others are there, and a note in its place', async () => {
    const s = await makeApplication('SUBMITTED', { centre, account: kavya });
    const [stored] = await rows<{ storage_key: string }>(
      `SELECT storage_key FROM application_files WHERE application_id = $1 AND document_code = 'PAN_CARD'`,
      [s.applicationId],
    );
    await storage.remove(stored!.storage_key);
    const res = await zip(s.student.id);
    expect(res.status).toBe(200);
    const names = (await unzip(res.body as Buffer)).map((e) => e.name.split('/')[1]);
    expect(names).toHaveLength(9);
    expect(names).toContain('06_PAN_Card_MISSING.txt');
    expect(names).not.toContain('06_PAN_Card.pdf');
    expect((await get('/manage/me', viewer.token)).status).toBe(200);
  });

  it('streams a large file whole', async () => {
    const s = await makeApplication('DRAFT', { centre, account: kavya });
    const large = Buffer.concat([FILES.mp4, Buffer.alloc(8 * 1024 * 1024, 7)]);
    await addFile(s.applicationId, 'APPLICANT_VIDEO', large, 'video.mp4');
    await addFile(s.applicationId, 'PHOTO');
    const entries = await unzip((await zip(s.student.id)).body as Buffer);
    expect(entries.map((e) => e.content.length)).toEqual([FILES.pdf.length, large.length]);
    expect(entries[1]!.content.equals(large)).toBe(true);
    expect(((await file(s.student.id, 'APPLICANT_VIDEO')).body as Buffer).equals(large)).toBe(true);
  });
});

describe('a file that breaks off while it is sent', () => {
  it('breaks the answer off, so it is never taken for a whole one, and the server goes on', async () => {
    const s = await makeApplication('SUBMITTED', { centre });
    vi.spyOn(storage, 'read').mockImplementation(async () =>
      Readable.from(
        (async function* () {
          yield FILES.pdf;
          throw new Error('the storage is gone');
        })(),
        { objectMode: false },
      ),
    );
    await expect(file(s.student.id, 'PHOTO')).rejects.toThrow(/aborted|hang up/);
    await expect(zip(s.student.id)).rejects.toThrow(/aborted|hang up/);
    vi.restoreAllMocks();
    vi.spyOn(storage, 'read').mockRejectedValue(new Error('the storage is gone'));
    const refused = await get(`/manage/applicants/${s.student.id}/documents/PHOTO/file`, viewer.token);
    expect([refused.status, refused.body.error.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(JSON.stringify(refused.body)).not.toContain('storage');
    await expect(zip(s.student.id)).rejects.toThrow(/aborted|hang up/);
    expect((await get('/manage/me', viewer.token)).status).toBe(200);
  });
});
