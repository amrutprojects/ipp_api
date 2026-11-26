import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { one, pool } from '../../src/db/pool';
import { storage } from '../../src/services/storage';
import { FILES, makeApplication, makeCentre, request } from '../helpers/factory';
import {
  application,
  code,
  details,
  fileRows,
  folderOf,
  isStored,
  newEmail,
  ready,
  setUp,
  storedIn,
  submit,
  upload,
  verifiedToken,
} from './helpers';

setUp();

afterEach(async () => {
  await pool.query(`UPDATE program_documents SET is_active = code <> 'HSC_DIPLOMA', name_en = CASE code WHEN 'PHOTO' THEN 'Photo' ELSE name_en END
                    WHERE is_system`);
  await pool.query(`UPDATE program_documents SET is_active = false WHERE NOT is_system`);
});

const MB = 1024 * 1024;
const big = (start: Buffer, size: number) => Buffer.concat([start, Buffer.alloc(size - start.length)]);
/* A student with an empty form. */
async function student() {
  const token = await verifiedToken(newEmail());
  const me = (await request('get', '/me', token)).body.data;
  const { id } = (await one<{ id: string }>(`SELECT id FROM applications WHERE account_id = $1`, [me.id]))!;
  return { token, id, email: me.email as string };
}
const remove = (token: string, docType: string) => request('delete', `/application/documents/${docType}`, token);
const file = (token: string, docType: string) => request('get', `/application/documents/${docType}/file`, token);
const body = async (token: string, docType: string) => Buffer.from((await file(token, docType).buffer()).body as Buffer);
const NO_FILE = 'No file has been uploaded for this document';

describe('POST /application/documents', () => {
  it('stores the files of the draft, with what is known about each', async () => {
    const s = await student();
    const res = await upload(s.token, [
      ['PHOTO', FILES.jpg, 'My Photo.JPEG'],
      ['SIGNATURE', FILES.png, 'sign.png'],
      ['APPLICANT_VIDEO', FILES.mp4, 'video.mp4'],
    ]);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Uploaded');
    expect(res.body.data).toMatchObject({ status: 'DRAFT', editable: true, submitted_files: [] });
    expect(res.body.data.draft_files).toEqual([
      {
        doc_type: 'PHOTO',
        name: 'Photo',
        original_name: 'My Photo.JPEG',
        mime_type: 'image/jpeg',
        size_bytes: FILES.jpg.length,
        uploaded_at: expect.stringMatching(/^\d{4}-/),
      },
      expect.objectContaining({ doc_type: 'SIGNATURE', mime_type: 'image/png' }),
      expect.objectContaining({ doc_type: 'APPLICANT_VIDEO', name: 'Applicant Video with Aadhaar', mime_type: 'video/mp4' }),
    ]);
    const rows = await fileRows(s.id);
    expect(rows).toHaveLength(3);
    /* The student's own folder: first name, last name, mobile number. */
    const folder = (await folderOf(s.id))!;
    expect(folder).toMatch(/^candidates\/Kavya Jadhav 9765412345( \(\d+\))?$/);
    for (const f of rows) {
      expect(f.storage_key).toMatch(new RegExp(`^${folder}/${f.document_code}-[0-9a-f-]{36}\\.(jpg|png|mp4)$`));
      expect(isStored(f.storage_key)).toBe(true);
    }
    expect(rows.find((f) => f.document_code === 'PHOTO')!.sha256).toBe(
      crypto.createHash('sha256').update(FILES.jpg).digest('hex'),
    );
  });

  it('replaces the earlier file of the document; the old one is gone, its check too', async () => {
    const s = await student();
    await upload(s.token, [['PHOTO', FILES.jpg, 'first.jpg']]);
    const [first] = await fileRows(s.id);
    await pool.query(`INSERT INTO document_checks (application_id, document_code) VALUES ($1, 'PHOTO')`, [s.id]);
    const res = await upload(s.token, [['photo', FILES.pdf, 'second.pdf']]);
    expect(res.status).toBe(200);
    expect(res.body.data.draft_files).toEqual([expect.objectContaining({ doc_type: 'PHOTO', original_name: 'second.pdf' })]);
    const [second] = await fileRows(s.id);
    expect(second!.storage_key).not.toBe(first!.storage_key);
    expect(isStored(first!.storage_key)).toBe(false);
    expect(isStored(second!.storage_key)).toBe(true);
    expect(await one(`SELECT 1 FROM document_checks WHERE application_id = $1`, [s.id])).toBeNull();
    expect((await body(s.token, 'PHOTO')).equals(FILES.pdf)).toBe(true);
  });

  it('checks each file by its content, its name and its size, and reports every problem; then nothing is stored', async () => {
    const s = await student();
    const res = await upload(s.token, [
      ['PHOTO', Buffer.from('hello'), 'photo.pdf'],
      ['SIGNATURE', FILES.pdf, 'sign.png'],
      ['AADHAAR_CARD', FILES.mp4, 'card.mp4'],
      ['AADHAAR_PHOTO', big(FILES.pdf, 5 * MB + 1), 'photo.pdf'],
      ['APPLICANT_VIDEO', FILES.pdf, 'video.pdf'],
      ['PAN_CARD', FILES.pdf, 'pan.pdf'],
      ['PAN_CARD', FILES.pdf, 'pan2.pdf'],
      ['HSC_DIPLOMA', FILES.pdf, 'hsc.pdf'],
      ['FITNESS', FILES.pdf, 'x.pdf'],
      ['EDU_CERT', Buffer.alloc(0), 'empty.pdf'],
      ['DOMICILE', FILES.pdf, 'domicile'],
    ]);
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('Validation failed');
    expect(details(res)).toEqual([
      { field: 'files.PHOTO', message: 'Photo: only PDF, JPG, JPEG or PNG files are accepted' },
      { field: 'files.SIGNATURE', message: 'Signature: only PDF, JPG, JPEG or PNG files are accepted' },
      { field: 'files.AADHAAR_CARD', message: 'Aadhar Card: only PDF, JPG, JPEG or PNG files are accepted' },
      { field: 'files.AADHAAR_PHOTO', message: 'Applicant Photograph with Aadhaar: file is larger than 5 MB' },
      { field: 'files.APPLICANT_VIDEO', message: 'Applicant Video with Aadhaar: only MP4 videos are accepted' },
      { field: 'files.PAN_CARD', message: 'Only one PAN Card file may be uploaded' },
      { field: 'files.HSC_DIPLOMA', message: 'Unknown or inactive document type' },
      { field: 'files.FITNESS', message: 'Unknown or inactive document type' },
      {
        field: 'files.EDU_CERT',
        message: 'Highest Qualification Certificate / Marksheet: only PDF, JPG, JPEG or PNG files are accepted',
      },
      { field: 'files.DOMICILE', message: 'Domicile of Certificate Maharashtra: only PDF, JPG, JPEG or PNG files are accepted' },
    ]);
    expect(await fileRows(s.id)).toEqual([]);
    expect(storedIn((await folderOf(s.id)) ?? 'candidates/none')).toEqual([]);
  });

  it('takes exactly 5 MB for a document and 50 MB for a video', async () => {
    const s = await student();
    expect((await upload(s.token, [['PHOTO', big(FILES.pdf, 5 * MB), 'photo.pdf']])).status).toBe(200);
    expect((await upload(s.token, [['APPLICANT_VIDEO', big(FILES.mp4, 6 * MB), 'video.mp4']])).status).toBe(200);
    expect((await upload(s.token, [['APPLICANT_VIDEO', FILES.mp4, 'video.mov']])).status).toBe(422);
    const huge = await upload(s.token, [['APPLICANT_VIDEO', big(FILES.mp4, 50 * MB + 1), 'video.mp4']]);
    expect(huge.status).toBe(422);
    expect(details(huge)).toEqual([{ field: 'files.APPLICANT_VIDEO', message: 'File is larger than 50 MB' }]);
    /* The video before is still there, whole. */
    expect((await body(s.token, 'APPLICANT_VIDEO')).equals(big(FILES.mp4, 6 * MB))).toBe(true);
  });

  it('follows the Documents master: names, own documents and videos, switched-off ones', async () => {
    await pool.query(
      `INSERT INTO program_documents (code, name_en, required, kind, display_order) VALUES
         ('IPP_DOC_1', 'Caste Validity', true, 'DOCUMENT', 500), ('IPP_DOC_2', 'Interview', false, 'VIDEO', 510)`,
    );
    await pool.query(`UPDATE program_documents SET name_en = 'Passport Photo' WHERE code = 'PHOTO'`);
    const s = await student();
    expect(
      details(
        await upload(s.token, [
          ['IPP_DOC_2', FILES.pdf, 'x.pdf'],
          ['PHOTO', Buffer.from('hello'), 'x.pdf'],
        ]),
      ),
    ).toEqual([
      { field: 'files.IPP_DOC_2', message: 'Interview: only MP4 videos are accepted' },
      { field: 'files.PHOTO', message: 'Passport Photo: only PDF, JPG, JPEG or PNG files are accepted' },
    ]);
    expect((await upload(s.token, [['IPP_DOC_2', big(FILES.mp4, 6 * MB), 'x.mp4']])).status).toBe(200);
    expect(details(await upload(s.token, [['IPP_DOC_2', big(FILES.mp4, 50 * MB + 1), 'x.mp4']]))).toEqual([
      { field: 'files.IPP_DOC_2', message: 'File is larger than 50 MB' },
    ]);
    await upload(s.token, [['IPP_DOC_1', FILES.pdf, 'x.pdf']]);
    expect((await application(s.token)).body.data.draft_files.map((f: { doc_type: string }) => f.doc_type)).toEqual([
      'IPP_DOC_1',
      'IPP_DOC_2',
    ]);
    /* Switched off: not taken and not listed any more, but still the student's own file. */
    await pool.query(`UPDATE program_documents SET is_active = false WHERE code = 'IPP_DOC_1'`);
    expect(details(await upload(s.token, [['IPP_DOC_1', FILES.pdf, 'x.pdf']]))).toEqual([
      { field: 'files.IPP_DOC_1', message: 'Unknown or inactive document type' },
    ]);
    expect((await application(s.token)).body.data.draft_files.map((f: { doc_type: string }) => f.doc_type)).toEqual([
      'IPP_DOC_2',
    ]);
    expect((await file(s.token, 'IPP_DOC_1')).status).toBe(200);
  });

  it('needs at least one file', async () => {
    const s = await student();
    const res = await request('post', '/application/documents', s.token);
    expect(res.status).toBe(422);
    expect(details(res)).toEqual([{ field: 'files', message: 'Choose a file to upload' }]);
    expect((await request('post', '/application/documents', s.token).field('data', '{}')).status).toBe(422);
  });

  it('leaves characters out of the file’s name that cannot be saved', async () => {
    const s = await student();
    const boundary = 'x-boundary';
    const res = await request('post', '/application/documents', s.token)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(
        Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="PHOTO"; filename*=utf-8''a%00b.pdf\r\n\r\n`),
          FILES.pdf,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      );
    expect(res.status).toBe(200);
    expect(res.body.data.draft_files[0].original_name).toBe('ab.pdf');
  });

  it('a storage that fails stores nothing and keeps the earlier file', async () => {
    const s = await student();
    await upload(s.token, [['SIGNATURE', FILES.png, 'first.png']]);
    const before = await fileRows(s.id);
    const write = storage.write;
    vi.spyOn(storage, 'write').mockImplementationOnce(write).mockRejectedValueOnce(new Error('disk full'));
    const res = await upload(s.token, [
      ['PHOTO', FILES.pdf, 'photo.pdf'],
      ['SIGNATURE', FILES.pdf, 'second.pdf'],
    ]);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Something went wrong. Please try again.');
    expect(await fileRows(s.id)).toEqual(before);
    expect(storedIn((await folderOf(s.id))!)).toHaveLength(1);
    expect((await body(s.token, 'SIGNATURE')).equals(FILES.png)).toBe(true);
  });

  it('an old file that cannot be deleted does not fail the upload', async () => {
    const s = await student();
    await upload(s.token, [['PHOTO', FILES.jpg, 'first.jpg']]);
    vi.spyOn(storage, 'remove').mockRejectedValue(new Error('busy'));
    expect((await upload(s.token, [['PHOTO', FILES.pdf, 'second.pdf']])).status).toBe(200);
    expect((await body(s.token, 'PHOTO')).equals(FILES.pdf)).toBe(true);
  });

  it('two uploads of one document at once keep one file, and no other is left behind', async () => {
    const s = await student();
    const results = await Promise.all([
      upload(s.token, [['PHOTO', FILES.pdf, 'a.pdf']]),
      upload(s.token, [['PHOTO', FILES.jpg, 'b.jpg']]),
      upload(s.token, [['PHOTO', FILES.png, 'c.png']]),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const rows = await fileRows(s.id);
    expect(rows).toHaveLength(1);
    expect(storedIn((await folderOf(s.id))!)).toEqual([rows[0]!.storage_key.split('/').at(-1)]);
  });

  it('a form submitted while its file is being stored keeps what was submitted', async () => {
    const r = await ready();
    const write = storage.write;
    vi.spyOn(storage, 'write').mockImplementationOnce(async (key, data) => {
      await write(key, data);
      vi.mocked(storage.write).mockImplementation(write);
      expect((await submit(r.token)).status).toBe(201);
    });
    const res = await upload(r.token, [['PHOTO', FILES.jpg, 'late.jpg']]);
    expect(res.status).toBe(409);
    expect(code(res)).toBe('ALREADY_SUBMITTED');
    expect((await body(r.token, 'PHOTO')).equals(FILES.pdf)).toBe(true);
    /* Only what was submitted is left in the student's folder. */
    expect(storedIn((await folderOf(r.id))!).every((f) => !f.includes('-'))).toBe(true);
  });

  it('is an activity of the student', async () => {
    const s = await student();
    const active = async () =>
      (await one<{ old: boolean }>(`SELECT student_active_at < now() - interval '1 day' AS old FROM applications WHERE id = $1`, [
        s.id,
      ]))!.old;
    const age = () => pool.query(`UPDATE applications SET student_active_at = now() - interval '2 days' WHERE id = $1`, [s.id]);
    await age();
    await upload(s.token, [['PHOTO', FILES.pdf, 'a.pdf']]);
    expect(await active()).toBe(false);
    await age();
    await remove(s.token, 'PHOTO');
    expect(await active()).toBe(false);
  });
});

describe('DELETE /application/documents/:docType', () => {
  it('removes the file, in the database and the storage', async () => {
    const s = await student();
    await upload(s.token, [
      ['PHOTO', FILES.pdf, 'a.pdf'],
      ['SIGNATURE', FILES.pdf, 'b.pdf'],
    ]);
    const photo = (await fileRows(s.id)).find((f) => f.document_code === 'PHOTO')!;
    const res = await remove(s.token, 'photo');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Removed');
    expect(res.body.data.draft_files.map((f: { doc_type: string }) => f.doc_type)).toEqual(['SIGNATURE']);
    expect(isStored(photo.storage_key)).toBe(false);
    const again = await remove(s.token, 'PHOTO');
    expect(again.status).toBe(404);
    expect(again.body.message).toBe(NO_FILE);
    expect(code(again)).toBe('NOT_FOUND');
  });

  it('a code that cannot be one is a document without a file', async () => {
    const s = await student();
    for (const docType of ['PHO-TO', 'x'.repeat(41), '%00']) {
      const res = await remove(s.token, docType);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe(NO_FILE);
    }
  });

  it('nobody else’s', async () => {
    const [s, other] = [await student(), await student()];
    await upload(s.token, [['PHOTO', FILES.pdf, 'a.pdf']]);
    expect((await remove(other.token, 'PHOTO')).status).toBe(404);
    expect((await file(other.token, 'PHOTO')).status).toBe(404);
    expect(await fileRows(s.id)).toHaveLength(1);
  });
});

describe('GET /application/documents/:docType/file', () => {
  it('sends the file as it is, for its owner only and not to be kept', async () => {
    const s = await student();
    await upload(s.token, [['PHOTO', FILES.png, 'My photo (1).png']]);
    const res = await file(s.token, 'photo').buffer();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline; filename="My%20photo%20(1).png"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(res.body as Buffer).equals(FILES.png)).toBe(true);
    const none = await file(s.token, 'SIGNATURE');
    expect(none.status).toBe(404);
    expect(none.body.message).toBe(NO_FILE);
  });

  it('a file missing in the storage is an error answer', async () => {
    const s = await student();
    await upload(s.token, [['PHOTO', FILES.png, 'a.png']]);
    await storage.remove((await fileRows(s.id))[0]!.storage_key);
    const res = await file(s.token, 'PHOTO');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('also after the submission', async () => {
    const { student: s } = await makeApplication('SUBMITTED', { centre: await makeCentre() });
    const res = await file(s.token, 'PHOTO').buffer();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });
});

describe('a submitted form', () => {
  it('takes no file and gives none back', async () => {
    const { student: s, applicationId } = await makeApplication('SUBMITTED', { centre: await makeCentre() });
    const before = await fileRows(applicationId);
    for (const res of [await upload(s.token, [['PHOTO', FILES.pdf, 'late.pdf']]), await remove(s.token, 'PHOTO')]) {
      expect(res.status).toBe(409);
      expect(code(res)).toBe('ALREADY_SUBMITTED');
      expect(res.body.message).toBe('Your form has already been submitted. A submitted form cannot be changed.');
    }
    expect(await fileRows(applicationId)).toEqual(before);
  });
});
