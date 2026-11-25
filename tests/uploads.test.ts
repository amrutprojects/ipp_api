import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { candidateFolder } from '../src/program/uploads';
import { closeDatabase, resetDatabase } from './helpers/db';
import { app, BASE, FILES, makeAccount, request, type TestStudent } from './helpers/factory';

let student: TestStudent;
beforeAll(async () => {
  await resetDatabase();
  student = await makeAccount();
});
afterAll(closeDatabase);

const MB = 1024 * 1024;
const upload = (field: string, data: Buffer, name: string) =>
  request('post', '/application/documents', student.token).attach(field, data, name);

describe('multipart uploads', () => {
  it('keep a Marathi file name readable, in lists and in downloads', async () => {
    const res = await upload('PHOTO', FILES.png, 'माझे छायाचित्र.png');
    expect(res.status).toBe(200);
    expect(res.body.data.draft_files[0].original_name).toBe('माझे छायाचित्र.png');
    const file = await request('get', '/application/documents/PHOTO/file', student.token);
    expect(decodeURIComponent(file.headers['content-disposition']!)).toContain('माझे छायाचित्र.png');
  });

  it('refuse a file over the multipart limit with the limit of its own document', async () => {
    const huge = Buffer.concat([FILES.pdf, Buffer.alloc(51 * MB)]);
    for (const [field, limit] of [
      ['PHOTO', 5],
      ['APPLICANT_VIDEO', 50],
    ] as const) {
      const res = await upload(field, huge, 'a.pdf');
      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual([{ field: `files.${field}`, message: `File is larger than ${limit} MB` }]);
    }
  });

  it('refuse more files than a form can have, and a request that is not the form it says it is', async () => {
    const many = request('post', '/application/documents', student.token);
    for (let i = 0; i < 21; i++) many.attach(`F${i}`, FILES.pdf, 'a.pdf');
    expect((await many).status).toBe(400);
    const broken = await supertest(app)
      .post(`${BASE}/application/documents`)
      .set('Authorization', `Bearer ${student.token}`)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x\r\nContent-Disposition: form-data; name="PHOTO"; filename="a.pdf"\r\n\r\nno end');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('a candidate folder', () => {
  it('has only letters, digits, . _ and -', () => {
    expect(candidateFolder('IPP-000001', 'Asha Rani', "D'Souza")).toBe('IPP-000001_Asha_Rani_D_Souza');
    expect(candidateFolder('IPP-000002', '../..', 'x/y')).not.toMatch(/\//);
    expect(candidateFolder('IPP-000003', 'आशा', 'जोशी')).toBe('IPP-000003');
  });
});
