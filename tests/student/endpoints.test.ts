import { expect, it } from 'vitest';
import { studentApis } from '../../src/modules/student';

it('the student part is these 19 endpoints; sign-up, sign-in and passwords are limited more strictly', () => {
  const endpoints = studentApis.flatMap((a) => a.endpoints);
  expect(endpoints.map((e) => `${e.method.toUpperCase()} ${e.path} ${e.auth}${e.limited ? ' limited' : ''}`).sort()).toEqual(
    [
      'POST /auth/register public limited',
      'POST /auth/verify-otp public limited',
      'POST /auth/resend-otp public limited',
      'POST /auth/otp-status public limited',
      'POST /auth/login public limited',
      'POST /auth/forgot-password public limited',
      'POST /auth/reset-password/check public limited',
      'POST /auth/reset-password public limited',
      'GET /options public',
      'GET /me student',
      'GET /application student',
      'PUT /application/steps/:step student',
      'POST /application/documents student',
      'DELETE /application/documents/:docType student',
      'GET /application/documents/:docType/file student',
      'POST /application/submit student',
      'PUT /application/correction student',
      'POST /application/correction/documents student',
      'POST /application/resubmit student',
    ].sort(),
  );
  for (const e of endpoints) expect(e.summary && (e.returns || e.file)).toBeTruthy();
});
