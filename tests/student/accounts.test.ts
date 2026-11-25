import bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config';
import { one, pool, rows } from '../../src/db/pool';
import { AppError } from '../../src/http/errors';
import { signSession } from '../../src/lib/tokens';
import { sms } from '../../src/services/sms';
import { makeAccount, makePanelUser, PASSWORD, request } from '../helpers/factory';
import {
  accountRow,
  ageOtp,
  auditActions,
  code,
  details,
  fields,
  lastOtp,
  login,
  newEmail,
  post,
  sent,
  setUp,
  signUp,
  verify,
  verifiedToken,
  wrongOtp,
} from './helpers';

/* Another cost than the tests' usual one, so a hash of a fixed cost would show. */
vi.hoisted(() => {
  process.env.BCRYPT_ROUNDS = '5';
});
setUp();

const UUID = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;

describe('POST /auth/register', () => {
  it('stores the account unverified and texts a 6-digit code to its mobile number', async () => {
    const res = await signUp('Asha.Patil@Example.test', { middle_name: ' Ramesh ', mobile_number: '+91 97654-12345' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      status: 201,
      message: 'An OTP has been sent to your mobile number',
      data: { email: 'asha.patil@example.test', mobile_masked: '+91XXXXXX2345', otp_expires_in: 300, resend_after: 300 },
    });
    expect(sent.otps).toEqual([{ mobile: '9765412345', otp: expect.stringMatching(/^\d{6}$/), ttl: 300 }]);

    const row = await accountRow('asha.patil@example.test');
    expect(row).toMatchObject({
      first_name: 'Kavya',
      middle_name: 'Ramesh',
      last_name: 'Jadhav',
      mobile: '9765412345',
      verified_at: null,
      otp_attempts: 0,
      otp_send_count: 1,
    });
    /* Only an HMAC of the code and a hash of the password are stored. */
    expect(row.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await bcrypt.compare(PASSWORD, row.password_hash as string)).toBe(true);
    expect((row.otp_expires_at as Date).getTime() - (row.otp_sent_at as Date).getTime()).toBe(300_000);
    expect(await auditActions(row.id as string)).toEqual(['edp.account.create']);
    /* Nothing personal in the audit log. */
    const [log] = await rows(`SELECT details, actor_kind, actor_id FROM audit_logs WHERE resource_id = $1`, [row.id]);
    expect(log).toEqual({ details: null, actor_kind: 'STUDENT', actor_id: row.id });
    /* An unverified account has no form. */
    expect(await one(`SELECT 1 FROM applications WHERE account_id = $1`, [row.id])).toBeNull();
  });

  it('reports every wrong field with its message', async () => {
    const res = await signUp('not-an-email', {
      first_name: ' ',
      middle_name: '1',
      last_name: 'J4',
      mobile_number: '12345',
      password: 'short',
      confirm_password: '',
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Validation failed',
      data: null,
      error: { code: 'VALIDATION_ERROR' },
    });
    /* The first message of each field is the one the page shows. */
    const first = new Map<string, string>();
    for (const d of details(res)) if (!first.has(d.field)) first.set(d.field, d.message);
    expect(Object.fromEntries(first)).toEqual({
      'body.first_name': 'First name is required',
      'body.middle_name': "Middle name may contain only letters, spaces and . ' -",
      'body.last_name': "Last name may contain only letters, spaces and . ' -",
      'body.email': 'Enter a valid email address',
      'body.mobile_number': 'Mobile number must be a 10-digit Indian number starting 6–9',
      'body.password': 'Password must be at least 8 characters',
      'body.confirm_password': 'Please re-enter the password',
    });
    const one = async (over: Record<string, unknown>) => details(await signUp(newEmail(), over))[0];
    expect(await one({ first_name: 'x'.repeat(101) })).toEqual({
      field: 'body.first_name',
      message: 'First name must be at most 100 characters',
    });
    expect(await one({ last_name: undefined })).toEqual({ field: 'body.last_name', message: 'Last name is required' });
    expect(await one({ mobile_number: '' })).toEqual({ field: 'body.mobile_number', message: 'Mobile number is required' });
    expect(await one({ email: '' })).toEqual({ field: 'body.email', message: 'Email is required' });
    expect(await one({ password: 'onlyletters', confirm_password: 'onlyletters' })).toEqual({
      field: 'body.password',
      message: 'Password must contain a digit',
    });
    expect(await one({ password: '12345678', confirm_password: '12345678' })).toEqual({
      field: 'body.password',
      message: 'Password must contain a letter',
    });
    expect(await one({ password: 'a1'.repeat(37), confirm_password: 'a1'.repeat(37) })).toEqual({
      field: 'body.password',
      message: 'Password must be at most 72 characters',
    });
    expect(await one({ confirm_password: 'Different-123' })).toEqual({
      field: 'body.confirm_password',
      message: 'Passwords do not match',
    });
    expect(await one({ role: 'ADMIN' })).toEqual({ field: 'body.role', message: 'Unknown field' });
    expect(sent.otps).toHaveLength(0);
  });

  it('refuses the e-mail of a verified account', async () => {
    const email = newEmail();
    await verifiedToken(email);
    const res = await signUp(email.toUpperCase(), {
      first_name: 'Other',
      password: 'Other-pass-9',
      confirm_password: 'Other-pass-9',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('An account with this email address already exists. Please log in.');
    expect(code(res)).toBe('CONFLICT');
    expect((await accountRow(email)).first_name).toBe('Kavya');
    expect((await login(email)).status).toBe(200);
  });

  it('signing up again replaces the details; while the code sent still works no new one is sent', async () => {
    const email = newEmail();
    await signUp(email);
    await ageOtp(email, 240, 60);
    const again = await signUp(email, { first_name: 'Kaveri', password: 'Second-pass-2', confirm_password: 'Second-pass-2' });
    expect(again.status).toBe(201);
    expect(again.body.data.otp_expires_in).toBeGreaterThanOrEqual(55);
    expect(again.body.data.otp_expires_in).toBeLessThanOrEqual(60);
    expect(again.body.data.resend_after).toBeGreaterThanOrEqual(55);
    expect(again.body.data.resend_after).toBeLessThanOrEqual(60);
    expect(sent.otps).toHaveLength(1);
    const ok = await verify(email, lastOtp(), 'Second-pass-2');
    expect(ok.body.data.account.first_name).toBe('Kaveri');
    expect(await auditActions(ok.body.data.account.id)).toEqual([
      'edp.account.create',
      'edp.account.signup_replaced',
      'edp.account.verified',
    ]);
  });

  it('a corrected mobile number drops the code sent to the old one and gets a new one at once', async () => {
    const email = newEmail();
    await signUp(email);
    const first = lastOtp();
    const again = await signUp(email, { mobile_number: '9876500000' });
    expect(again.body.data).toEqual({ email, mobile_masked: '+91XXXXXX0000', otp_expires_in: 300, resend_after: 300 });
    expect(sent.otps.map((o) => o.mobile)).toEqual(['9765412345', '9876500000']);
    if (first !== lastOtp()) expect(code(await verify(email, first))).toBe('OTP_INCORRECT');
    expect((await verify(email)).body.data.account.mobile_number).toBe('9876500000');
  });

  it('after the code has expired a new one is sent', async () => {
    const email = newEmail();
    await signUp(email);
    await ageOtp(email, 310, -10);
    expect((await signUp(email)).body.data).toMatchObject({ otp_expires_in: 300, resend_after: 300 });
    expect(sent.otps).toHaveLength(2);
    expect((await verify(email)).status).toBe(200);
  });

  it('two sign-ups with one new e-mail at once: one account, the other is told so', async () => {
    const email = newEmail();
    const results = await Promise.all([signUp(email, { first_name: 'One' }), signUp(email, { first_name: 'Two' })]);
    const statuses = results.map((r) => r.status).sort();
    /* Whichever came second either found the account (its details then replace the first's) or met it at the same moment. */
    expect([
      [201, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    for (const r of results.filter((x) => x.status === 409))
      expect(r.body.message).toBe('This email address was just registered. Please enter the OTP sent to it.');
    expect(await rows(`SELECT id FROM student_accounts WHERE email = $1`, [email])).toHaveLength(1);
    expect(sent.otps).toHaveLength(1);
  });

  it('a unique violation at the insert is answered as "just registered"', async () => {
    const email = newEmail();
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        `INSERT INTO student_accounts (first_name, last_name, email, mobile, password_hash) VALUES ('A', 'B', $1, '9876543210', 'x')`,
        [email],
      );
      const waiting = signUp(email).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      await other.query('COMMIT');
      const res = await waiting;
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('This email address was just registered. Please enter the OTP sent to it.');
      expect(sent.otps).toHaveLength(0);
    } finally {
      other.release();
    }
  });

  it('a sign-up that meets the verification cannot change the verified account', async () => {
    const email = newEmail();
    await signUp(email);
    /* The sign-up has read the account (unverified) and is hashing its password when the account becomes verified. */
    const hash = bcrypt.hash;
    vi.spyOn(bcrypt, 'hash').mockImplementationOnce(async (...args: unknown[]) => {
      await pool.query(`UPDATE student_accounts SET verified_at = now() WHERE email = $1`, [email]);
      return (hash as (...a: unknown[]) => Promise<string>)(...args);
    });
    const res = await signUp(email, { password: 'Intruder-99', confirm_password: 'Intruder-99' });
    expect(res.status).toBe(409);
    expect((await login(email, 'Intruder-99')).status).toBe(401);
    expect((await login(email)).status).toBe(200);
  });

  it('an SMS that cannot be sent leaves the account as before, and does not count', async () => {
    const email = newEmail();
    const fails = () =>
      vi
        .mocked(sms.sendOtp)
        .mockRejectedValueOnce(
          AppError.unavailable('The OTP SMS could not be sent right now. Please try again in a few minutes.', 'SMS_UNAVAILABLE'),
        );
    fails();
    const res = await signUp(email);
    expect(res.status).toBe(503);
    expect(code(res)).toBe('SMS_UNAVAILABLE');
    expect(await accountRow(email)).toMatchObject({
      verified_at: null,
      otp_hash: null,
      otp_expires_at: null,
      otp_sent_at: null,
      otp_send_count: 0,
      otp_window_start: null,
    });
    expect(code(await verify(email, '123456'))).toBe('OTP_NOT_PENDING');
    /* Signing up again works at once. */
    expect((await signUp(email)).status).toBe(201);
    expect((await verify(email)).status).toBe(200);
  });

  it('with a shorter wait, a failed new code leaves the one before in place', async () => {
    const email = newEmail();
    const wait = config.otp.resendSeconds;
    config.otp.resendSeconds = 30;
    try {
      await signUp(email);
      await ageOtp(email, 60, 240);
      vi.mocked(sms.sendOtp).mockRejectedValueOnce(AppError.unavailable('no', 'SMS_UNAVAILABLE'));
      expect((await post('/auth/resend-otp', { email })).status).toBe(503);
      expect((await accountRow(email)).otp_send_count).toBe(1);
      expect((await verify(email)).status).toBe(200);
    } finally {
      config.otp.resendSeconds = wait;
    }
  });

  it('uses the fixed local code where it is set, and a random one everywhere else', async () => {
    const email = newEmail();
    config.otp.fixed = '666666';
    try {
      expect((await signUp(email)).status).toBe(201);
      expect(lastOtp()).toBe('666666');
      expect((await verify(email, '666666')).status).toBe(200);
    } finally {
      config.otp.fixed = null;
    }
    const other = newEmail();
    await signUp(other);
    if (lastOtp() !== '666666') expect((await verify(other, '666666')).status).toBe(400);
    expect((await verify(other)).status).toBe(200);
  });
});

describe('POST /auth/verify-otp', () => {
  it('verifies the account, makes its form and signs the student in; the code works once', async () => {
    const email = newEmail();
    await signUp(email, { middle_name: 'Ramesh' });
    const wrong = await verify(email, wrongOtp());
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('Incorrect OTP');
    expect(code(wrong)).toBe('OTP_INCORRECT');

    const ok = await verify(email);
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe('Account created. Your mobile number is verified.');
    expect(ok.body.data).toEqual({
      token: expect.any(String),
      expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      account: {
        id: expect.stringMatching(UUID),
        first_name: 'Kavya',
        middle_name: 'Ramesh',
        last_name: 'Jadhav',
        email,
        mobile_number: '9765412345',
        email_verified: true,
      },
    });
    const { id } = ok.body.data.account;
    const row = await accountRow(email);
    expect(row).toMatchObject({ otp_hash: null, otp_expires_at: null, otp_attempts: 0 });
    expect(row.verified_at).toBeInstanceOf(Date);
    expect(row.last_login_at).toBeInstanceOf(Date);
    expect(await one(`SELECT status, current_step FROM applications WHERE account_id = $1`, [id])).toEqual({
      status: 'DRAFT',
      current_step: 1,
    });
    expect(await auditActions(id)).toEqual(['edp.account.create', 'edp.account.verified']);
    expect((await request('get', '/me', ok.body.data.token)).body.data).toEqual(ok.body.data.account);

    const again = await verify(email);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('This email address is already verified. Please log in.');
  });

  it('says why a code cannot be tried, in this order', async () => {
    const unknown = await verify('nobody@example.test', '123456');
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe('No OTP is pending for this account. Please request a new OTP.');
    expect(code(unknown)).toBe('OTP_NOT_PENDING');

    const email = newEmail();
    await signUp(email);
    /* Wrong five times, and expired: expired is said first. */
    await pool.query(`UPDATE student_accounts SET otp_attempts = 5 WHERE email = $1`, [email]);
    await ageOtp(email, 310, -10);
    const expired = await verify(email);
    expect(expired.status).toBe(400);
    expect(expired.body.message).toBe('OTP has expired. Please request a new OTP.');
    expect(code(expired)).toBe('OTP_EXPIRED');
    /* Just before: still valid. */
    await ageOtp(email, 290, 10);
    await pool.query(`UPDATE student_accounts SET otp_attempts = 0 WHERE email = $1`, [email]);
    expect((await verify(email)).status).toBe(200);
  });

  it('stops after five wrong codes until a new one is requested', async () => {
    const email = newEmail();
    await signUp(email);
    for (let i = 0; i < 5; i++) expect(code(await verify(email, wrongOtp()))).toBe('OTP_INCORRECT');
    const locked = await verify(email);
    expect(locked.status).toBe(429);
    expect(locked.body.message).toBe('Too many incorrect attempts. Please request a new OTP when the current one expires.');
    expect(code(locked)).toBe('OTP_TOO_MANY_ATTEMPTS');
    await ageOtp(email, 310, -10);
    expect(code(await verify(email))).toBe('OTP_EXPIRED');
    expect((await post('/auth/resend-otp', { email })).status).toBe(200);
    expect((await verify(email)).status).toBe(200);
  });

  it('the right code on the fifth try still works', async () => {
    const email = newEmail();
    await signUp(email);
    for (let i = 0; i < 4; i++) await verify(email, wrongOtp());
    expect((await verify(email)).status).toBe(200);
  });

  it('guesses sent at the same moment count too: never more than five are checked', async () => {
    const email = newEmail();
    await signUp(email);
    const bad = wrongOtp();
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(email, bad)));
    const codes = results.map((r) => code(r));
    expect(codes.filter((c) => c === 'OTP_INCORRECT')).toHaveLength(5);
    expect(codes.filter((c) => c === 'OTP_TOO_MANY_ATTEMPTS')).toHaveLength(7);
    expect((await accountRow(email)).otp_attempts).toBe(5);
  });

  it('needs the password of the latest sign-up, so a sign-up by someone else cannot take the account over', async () => {
    const email = newEmail();
    await signUp(email, { first_name: 'Other', password: 'Other-pass-9', confirm_password: 'Other-pass-9' });
    await signUp(email, { first_name: 'Owner' });
    const mismatch = await verify(email, lastOtp(), 'Other-pass-9');
    expect(mismatch.status).toBe(400);
    expect(code(mismatch)).toBe('SIGNUP_PASSWORD_MISMATCH');
    expect(mismatch.body.message).toBe(
      'This is not the password chosen when the account was created. Enter that password, or create the account again.',
    );
    /* Counted as a wrong attempt. */
    expect((await accountRow(email)).otp_attempts).toBe(1);
    const ok = await verify(email);
    expect(ok.body.data.account.first_name).toBe('Owner');
    expect((await login(email, 'Other-pass-9')).status).toBe(401);
  });

  it('does not verify when a sign-up replaced the password in between', async () => {
    const email = newEmail();
    await signUp(email);
    const compare = bcrypt.compare;
    vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async (...args: unknown[]) => {
      const matches = await (compare as (...a: unknown[]) => Promise<boolean>)(...args);
      await pool.query(`UPDATE student_accounts SET password_hash = 'replaced' WHERE email = $1`, [email]);
      return matches;
    });
    expect(code(await verify(email))).toBe('SIGNUP_PASSWORD_MISMATCH');
    expect((await accountRow(email)).verified_at).toBeNull();
  });

  it('two requests with the right code at once: one session, the other finds it verified', async () => {
    const email = newEmail();
    await signUp(email);
    const otp = lastOtp();
    const results = await Promise.all([verify(email, otp), verify(email, otp)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await rows(`SELECT 1 FROM applications p JOIN student_accounts a ON a.id = p.account_id WHERE a.email = $1`, [email]),
    ).toHaveLength(1);
  });

  it('checks the code and password fields', async () => {
    expect(details(await post('/auth/verify-otp', { email: 'a@b.test', otp: '12a456', password: '' }))).toEqual([
      { field: 'body.otp', message: 'Enter the 6-digit OTP' },
      { field: 'body.password', message: 'Password is required' },
    ]);
  });
});

describe('POST /auth/resend-otp and /auth/otp-status', () => {
  it('sends a new code only once the last one has expired; the new one replaces it', async () => {
    const email = newEmail();
    await signUp(email);
    const first = lastOtp();
    const tooSoon = await post('/auth/resend-otp', { email });
    expect(tooSoon.status).toBe(429);
    expect(code(tooSoon)).toBe('OTP_RESEND_TOO_SOON');
    expect(tooSoon.body.message).toMatch(/^Please wait (5 min|4 min \d+ s) before requesting a new OTP\.$/);
    await ageOtp(email, 290, 10);
    expect((await post('/auth/resend-otp', { email })).body.message).toMatch(
      /^Please wait (9|10) seconds before requesting a new OTP\.$/,
    );
    await ageOtp(email, 299.5, 0.5);
    expect((await post('/auth/resend-otp', { email })).body.message).toBe('Please wait 1 second before requesting a new OTP.');
    expect(sent.otps).toHaveLength(1);

    await ageOtp(email, 310, -10);
    const resend = await post('/auth/resend-otp', { email });
    expect(resend.status).toBe(200);
    expect(resend.body.message).toBe('An OTP has been sent to your mobile number');
    expect(resend.body.data).toEqual({ email, mobile_masked: '+91XXXXXX2345', otp_expires_in: 300, resend_after: 300 });
    if (first !== lastOtp()) expect(code(await verify(email, first))).toBe('OTP_INCORRECT');
    expect((await verify(email)).status).toBe(200);
  });

  it('sends at most ten codes an hour', async () => {
    const email = newEmail();
    await signUp(email);
    for (let i = 0; i < 9; i++) {
      await ageOtp(email, 310, -10);
      expect((await post('/auth/resend-otp', { email })).status).toBe(200);
    }
    await ageOtp(email, 310, -10);
    const res = await post('/auth/resend-otp', { email });
    expect(res.status).toBe(429);
    expect(code(res)).toBe('OTP_RESEND_TOO_SOON');
    expect(res.body.message).toBe('Too many OTP requests. Please try again after an hour.');
    /* Nor by signing up again. */
    expect((await signUp(email)).status).toBe(429);
    expect(sent.otps).toHaveLength(10);
    /* The hour counts from the first one. */
    await pool.query(`UPDATE student_accounts SET otp_window_start = now() - interval '61 minutes' WHERE email = $1`, [email]);
    expect((await post('/auth/resend-otp', { email })).status).toBe(200);
    expect((await accountRow(email)).otp_send_count).toBe(1);
  });

  it('two requests at once send one code', async () => {
    const email = newEmail();
    await signUp(email);
    await ageOtp(email, 310, -10);
    const results = await Promise.all([post('/auth/resend-otp', { email }), post('/auth/resend-otp', { email })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(code(results.find((r) => r.status === 429)!)).toBe('OTP_RESEND_TOO_SOON');
    expect(sent.otps).toHaveLength(2);
  });

  it("answers the page with the server's timing", async () => {
    const email = newEmail();
    await signUp(email);
    await ageOtp(email, 240, 60);
    const status = await post('/auth/otp-status', { email });
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({
      email,
      mobile_masked: '+91XXXXXX2345',
      otp_expires_in: expect.any(Number),
      resend_after: expect.any(Number),
    });
    for (const k of ['otp_expires_in', 'resend_after']) {
      expect(status.body.data[k]).toBeGreaterThanOrEqual(58);
      expect(status.body.data[k]).toBeLessThanOrEqual(60);
    }
    await ageOtp(email, 310, -10);
    expect((await post('/auth/otp-status', { email })).body.data).toMatchObject({ otp_expires_in: 0, resend_after: 0 });
  });

  it.each(['/auth/resend-otp', '/auth/otp-status'])('%s: no account 404, already verified 409, no e-mail 422', async (path) => {
    const unknown = await post(path, { email: 'nobody@example.test' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe('No account was found for this email address. Please create an account.');
    const email = newEmail();
    await verifiedToken(email);
    const verified = await post(path, { email });
    expect(verified.status).toBe(409);
    expect(verified.body.message).toBe('This email address is already verified. Please log in.');
    expect(details(await post(path, {}))).toEqual([{ field: 'body.email', message: 'Email is required' }]);
  });
});

describe('POST /auth/login', () => {
  it('signs in a verified student, whatever the case of the e-mail', async () => {
    const s = await makeAccount();
    const res = await login(` ${s.email.toUpperCase()} `);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged in');
    expect(res.body.data).toEqual({
      token: expect.any(String),
      expires_at: expect.any(String),
      account: {
        id: s.id,
        first_name: s.first_name,
        middle_name: null,
        last_name: s.last_name,
        email: s.email,
        mobile_number: s.mobile,
        email_verified: true,
      },
    });
    expect((await accountRow(s.email)).last_login_at).toBeInstanceOf(Date);
    expect(await one(`SELECT 1 AS made FROM applications WHERE account_id = $1`, [s.id])).toEqual({ made: 1 });
    expect((await request('get', '/me', res.body.data.token)).status).toBe(200);
  });

  it('answers a wrong password and an unknown e-mail alike, after comparing a password of the same cost', async () => {
    const s = await makeAccount();
    const compare = vi.spyOn(bcrypt, 'compare');
    const wrong = await login(s.email, 'Wrong-pass-1');
    const unknown = await login('nobody@example.test', 'Wrong-pass-1');
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Incorrect email or password');
      expect(code(res)).toBe('UNAUTHORIZED');
    }
    const hashes = compare.mock.calls.map((c) => String(c[1]));
    expect(hashes).toHaveLength(2);
    expect(hashes.map((h) => bcrypt.getRounds(h))).toEqual([5, 5]);
  });

  it('refuses a disabled account, and a deleted one like an unknown one', async () => {
    const s = await makeAccount();
    await pool.query(`UPDATE student_accounts SET is_active = false WHERE id = $1`, [s.id]);
    const res = await login(s.email);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This account has been disabled. Please contact the programme office.');
    expect(code(res)).toBe('FORBIDDEN');
    /* Not told with a wrong password. */
    expect((await login(s.email, 'Wrong-pass-1')).status).toBe(401);
    await pool.query(`UPDATE student_accounts SET deleted_at = now() WHERE id = $1`, [s.id]);
    expect((await login(s.email)).status).toBe(401);
  });

  it('an unverified account gets a new code if one may be sent, and the OTP page', async () => {
    const email = newEmail();
    await signUp(email);
    const pending = await login(email);
    expect(pending.status).toBe(403);
    expect(code(pending)).toBe('EMAIL_NOT_VERIFIED');
    expect(pending.body.message).toBe('Your mobile number is not verified yet. Enter the OTP sent to your mobile number.');
    expect(sent.otps).toHaveLength(1);
    await ageOtp(email, 310, -10);
    expect(code(await login(email))).toBe('EMAIL_NOT_VERIFIED');
    expect(sent.otps).toHaveLength(2);
    expect((await accountRow(email)).last_login_at).toBeNull();
    /* The SMS gateway is down. */
    await ageOtp(email, 310, -10);
    vi.mocked(sms.sendOtp).mockRejectedValueOnce(AppError.unavailable('no', 'SMS_UNAVAILABLE'));
    expect(code(await login(email))).toBe('SMS_UNAVAILABLE');
    /* A wrong password sends nothing. */
    expect((await login(email, 'Wrong-pass-1')).status).toBe(401);
    expect(sent.otps).toHaveLength(2);
  });

  it('makes an account wait after ten wrong passwords within 15 minutes', async () => {
    const s = await makeAccount();
    for (let i = 0; i < 10; i++) expect((await login(s.email, 'Wrong-pass-1')).status).toBe(401);
    const locked = await login(s.email);
    expect(locked.status).toBe(429);
    expect(code(locked)).toBe('RATE_LIMITED');
    expect(locked.body.message).toBe('Too many attempts. Please try again later.');
    /* Another account is not affected; after 15 minutes the count starts again. */
    expect((await login((await makeAccount()).email)).status).toBe(200);
    await pool.query(`UPDATE student_accounts SET failed_window_start = now() - interval '14 minutes' WHERE id = $1`, [s.id]);
    expect((await login(s.email)).status).toBe(429);
    await pool.query(`UPDATE student_accounts SET failed_window_start = now() - interval '16 minutes' WHERE id = $1`, [s.id]);
    expect((await login(s.email, 'Wrong-pass-1')).status).toBe(401);
    expect((await accountRow(s.email)).failed_logins).toBe(1);
    expect((await login(s.email)).status).toBe(200);
  });

  it('a right password starts the count again', async () => {
    const s = await makeAccount();
    for (let i = 0; i < 9; i++) await login(s.email, 'Wrong-pass-1');
    expect((await login(s.email)).status).toBe(200);
    expect(await accountRow(s.email)).toMatchObject({ failed_logins: 0, failed_window_start: null });
    for (let i = 0; i < 9; i++) expect((await login(s.email, 'Wrong-pass-1')).status).toBe(401);
    expect((await login(s.email)).status).toBe(200);
  });

  it('passwords sent at the same moment count too', async () => {
    const s = await makeAccount();
    const results = await Promise.all(Array.from({ length: 16 }, () => login(s.email, 'Wrong-pass-1')));
    expect(results.filter((r) => r.status === 401)).toHaveLength(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(6);
  });

  it('needs both fields', async () => {
    expect(details(await post('/auth/login', { email: '', password: '' }))).toEqual([
      { field: 'body.email', message: 'Email is required' },
      { field: 'body.email', message: 'Enter a valid email address' },
      { field: 'body.password', message: 'Password is required' },
    ]);
    expect(fields(await post('/auth/login', { email: 'a@b.test', password: 'x', remember: true }))).toEqual(['body.remember']);
  });
});

describe('GET /me', () => {
  it('needs a student session of a verified, active account', async () => {
    const none = await request('get', '/me');
    expect(none.status).toBe(401);
    expect(none.body.message).toBe('Please log in to continue.');
    expect((await request('get', '/me', 'nonsense')).status).toBe(401);
    expect((await request('get', '/me', (await makePanelUser()).token)).status).toBe(401);
    expect((await request('get', '/me', signSession('student', '00000000-0000-0000-0000-000000000000', 0).token)).status).toBe(
      401,
    );
    expect((await request('get', '/me', (await makeAccount({ verified: false })).token)).status).toBe(401);

    const s = await makeAccount();
    const me = await request('get', '/me', s.token);
    expect(me.status).toBe(200);
    expect(me.body.data).toEqual({
      id: s.id,
      first_name: s.first_name,
      middle_name: null,
      last_name: s.last_name,
      email: s.email,
      mobile_number: s.mobile,
      email_verified: true,
    });
    await pool.query(`UPDATE student_accounts SET is_active = false WHERE id = $1`, [s.id]);
    expect((await request('get', '/me', s.token)).status).toBe(401);
  });
});
