import { describe, expect, it } from 'vitest';
import { one, pool } from '../src/db/pool';
import { organiseAll, studentFolder } from '../src/program/folders';
import { storage } from '../src/services/storage';
import { FILES, makeApplication, makeCentre, makePanelUser, request } from './helpers/factory';
import {
  application,
  fileRows,
  folderOf,
  isStored,
  post,
  setUp,
  signUp,
  step,
  steps,
  storedIn,
  submit,
  upload,
  uploadAll,
  verify,
} from './student/helpers';

/*
 * Each student's documents are kept in one folder of their own, named after them: "Asha Patil 9876501234" (first name,
 * last name, mobile number), whoever stores them: the student, the submission or the Auditor.
 */
setUp();

describe('the name of a folder', () => {
  it('is the first name, the last name and the mobile number', () => {
    expect(studentFolder('asha', 'patil', '9876501234')).toBe('Asha Patil 9876501234');
    expect(studentFolder('ASHA', 'PATIL', '+91 98765-01234')).toBe('Asha Patil 9876501234');
    expect(studentFolder('  kavya   r. ', "D'Souza", '09876501234')).toBe("Kavya R. D'Souza 9876501234");
    expect(studentFolder('McDonald', 'smith-jones', '9876543210')).toBe('McDonald Smith-Jones 9876543210');
    expect(studentFolder('ravi', "d'souza", '9876543210')).toBe("Ravi D'Souza 9876543210");
    expect(studentFolder('आशा', 'जोशी', '9876543210')).toBe('आशा जोशी 9876543210');
  });

  it('holds nothing that means something to S3 or to a disk', () => {
    for (const [first, last] of [
      ['../..', 'x/y'],
      ['a\\b', 'c:d*e?"<>|'],
      ['.', '..'],
      ['', ''],
    ]) {
      const folder = studentFolder(first!, last!, '');
      expect(folder).not.toMatch(/[/\\:*?"<>|]/);
      expect(folder).not.toMatch(/^\.+$/);
      expect(folder.length).toBeGreaterThan(0);
    }
    expect(studentFolder('', '', '')).toBe('Student');
    expect(studentFolder('x'.repeat(300), 'y', '9876543210').length).toBeLessThanOrEqual(150);
  });
});

/* A student who signed up as asha patil with 9876501234. */
async function asha(email = `asha${Math.random().toString(36).slice(2, 8)}@example.test`) {
  expect((await signUp(email, { first_name: 'asha', last_name: 'patil', mobile_number: '9876501234' })).status).toBe(201);
  const token = (await verify(email)).body.data.token as string;
  const { id } = (await one<{ id: string }>(
    `SELECT p.id FROM applications p JOIN student_accounts a ON a.id = p.account_id WHERE a.email = $1`,
    [email],
  ))!;
  return { token, id };
}

describe("the student's documents", () => {
  it('go into the folder of their name from the first upload, and stay there once submitted', async () => {
    const s = await asha();
    expect((await upload(s.token, [['PHOTO', FILES.jpg, 'me.jpg']])).status).toBe(200);
    expect(await folderOf(s.id)).toBe('candidates/Asha Patil 9876501234');
    expect((await fileRows(s.id))[0]!.storage_key).toMatch(/^candidates\/Asha Patil 9876501234\/PHOTO-[0-9a-f-]{36}\.jpg$/);

    const { basic, main } = await steps({ first_name: 'asha', last_name: 'patil', mobile_number: '9876501234' });
    expect((await step(s.token, 1, basic)).status).toBe(200);
    expect((await step(s.token, 2, main)).status).toBe(200);
    expect((await uploadAll(s.token)).status).toBe(200);
    expect((await submit(s.token)).status).toBe(201);
    const files = await fileRows(s.id);
    expect(files.map((f) => f.storage_key).every((k) => /^candidates\/Asha Patil 9876501234\/[A-Z_]+\.(pdf|jpg)$/.test(k))).toBe(
      true,
    );
    expect(files.every((f) => isStored(f.storage_key))).toBe(true);
    /* Nothing else in it: the draft's files are gone. */
    expect(storedIn('candidates/Asha Patil 9876501234').sort()).toEqual(files.map((f) => f.storage_key.split('/')[2]!).sort());
    /* The student still opens them. */
    const photo = await request('get', '/application/documents/PHOTO/file', s.token).buffer();
    expect(photo.status).toBe(200);
  });

  it('a name changed in the form before submitting: the submitted documents are in the folder of that name', async () => {
    const s = await asha();
    await upload(s.token, [['PHOTO', FILES.jpg, 'me.jpg']]);
    const draftFolder = (await folderOf(s.id))!;
    const { basic, main } = await steps({ first_name: 'Asha', last_name: 'Patil-Shinde', mobile_number: '9876500000' });
    await step(s.token, 1, basic);
    await step(s.token, 2, main);
    await uploadAll(s.token);
    expect((await submit(s.token)).status).toBe(201);
    expect(await folderOf(s.id)).toBe('candidates/Asha Patil-Shinde 9876500000');
    expect((await fileRows(s.id)).every((f) => f.storage_key.startsWith('candidates/Asha Patil-Shinde 9876500000/'))).toBe(true);
    /* Nothing is left in the folder of the name it had while it was a draft. */
    expect(storedIn(draftFolder)).toEqual([]);
  });

  it('two students of the same name and number never share a folder', async () => {
    const first = await asha();
    const second = await asha();
    await upload(first.token, [['PHOTO', FILES.jpg, 'a.jpg']]);
    await upload(second.token, [['PHOTO', FILES.png, 'b.png']]);
    const folders = [await folderOf(first.id), await folderOf(second.id)];
    expect(new Set(folders).size).toBe(2);
    expect(folders.every((f) => /^candidates\/Asha Patil 9876501234( \(\d+\))?$/.test(f!))).toBe(true);
    /* The first keeps its folder when it uploads again. */
    await upload(first.token, [['SIGNATURE', FILES.png, 's.png']]);
    expect(await folderOf(first.id)).toBe(folders[0]);
  });
});

describe("the Auditor's changes", () => {
  it('a replaced document goes into the folder; a corrected name or mobile number moves every document', async () => {
    const admin = await makePanelUser('ADMIN');
    const s = await makeApplication('VERIFIED_DOCS', {
      centre: await makeCentre(),
      by: admin,
      account: { first_name: 'Ravi', last_name: 'Kulkarni', mobile: '9822012345' },
    });
    const call = (method: 'put' | 'post', path: string) =>
      request(method, `/manage/applicants/${s.student.id}${path}`, admin.token);

    const replaced = await call('post', '/documents').attach('PHOTO', FILES.png, 'new.png');
    expect(replaced.status).toBe(200);
    expect(await folderOf(s.applicationId)).toBe('candidates/Ravi Kulkarni 9822012345');
    const before = await fileRows(s.applicationId);
    expect(before.every((f) => f.storage_key.startsWith('candidates/Ravi Kulkarni 9822012345/'))).toBe(true);

    const edit = await call('put', '/form').send({ data: { first_name: 'Ravindra', mobile_number: '9822099999' } });
    expect(edit.status).toBe(200);
    expect(await folderOf(s.applicationId)).toBe('candidates/Ravindra Kulkarni 9822099999');
    const after = await fileRows(s.applicationId);
    expect(after).toHaveLength(before.length);
    for (const f of after) {
      expect(f.storage_key.startsWith('candidates/Ravindra Kulkarni 9822099999/')).toBe(true);
      expect(isStored(f.storage_key)).toBe(true);
      expect(f.sha256).toBe(before.find((b) => b.document_code === f.document_code)!.sha256);
    }
    expect(storedIn('candidates/Ravi Kulkarni 9822012345')).toEqual([]);
    /* Still opened from the panel. */
    expect((await request('get', `/manage/applicants/${s.student.id}/documents/PHOTO/file`, admin.token)).status).toBe(200);
  });

  it('a move that fails leaves every document where it was, still found', async () => {
    const admin = await makePanelUser('ADMIN');
    const s = await makeApplication('VERIFIED_DOCS', {
      centre: await makeCentre(),
      by: admin,
      account: { first_name: 'Meera', last_name: 'Joshi', mobile: '9822054321' },
    });
    const before = await fileRows(s.applicationId);
    const copy = storage.copy;
    let n = 0;
    storage.copy = async (from, to) => {
      if (++n === 3) throw new Error('the bucket is busy');
      return copy(from, to);
    };
    try {
      const res = await request('put', `/manage/applicants/${s.student.id}/form`, admin.token).send({
        data: { last_name: 'Joshi-Rao' },
      });
      expect(res.status).toBe(200);
    } finally {
      storage.copy = copy;
    }
    const after = await fileRows(s.applicationId);
    expect(after.map((f) => f.storage_key).sort()).toEqual(before.map((f) => f.storage_key).sort());
    expect(after.every((f) => isStored(f.storage_key))).toBe(true);
    expect(storedIn('candidates/Meera Joshi-Rao 9822054321')).toEqual([]);
  });
});

describe('npm run storage:organise', () => {
  it('counts, then moves the documents stored before into the students’ folders', async () => {
    const s = await makeApplication('SUBMITTED', {
      centre: await makeCentre(),
      account: { first_name: 'Asha', last_name: 'Pawar', mobile: '9811122233' },
    });
    expect((await fileRows(s.applicationId)).every((f) => f.storage_key.startsWith('applications/'))).toBe(true);
    const count = await organiseAll(false);
    expect(count.applications).toBeGreaterThanOrEqual(1);
    expect((await fileRows(s.applicationId)).every((f) => f.storage_key.startsWith('applications/'))).toBe(true);

    await organiseAll(true);
    const files = await fileRows(s.applicationId);
    expect(files.every((f) => f.storage_key.startsWith('candidates/Asha Pawar 9811122233/') && isStored(f.storage_key))).toBe(
      true,
    );
    expect(storedIn(`applications/${s.applicationId}`)).toEqual([]);
    /* Once is enough: nothing is left to move. */
    expect((await organiseAll(false)).applications).toBe(0);
    expect(
      (await one<{ n: number }>(`SELECT count(*)::int AS n FROM applications WHERE storage_folder IS NOT NULL`))!.n,
    ).toBeGreaterThan(0);
  });
});

it('the student page of the submitted form still opens its documents', async () => {
  const s = await asha();
  await upload(s.token, [['PHOTO', FILES.jpg, 'me.jpg']]);
  expect((await application(s.token)).body.data.draft_files[0]).toMatchObject({ doc_type: 'PHOTO' });
  expect((await post('/application/documents', {}, s.token)).status).not.toBe(500);
  await pool.query('SELECT 1');
});
