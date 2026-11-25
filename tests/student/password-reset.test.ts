import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { config } from '../../src/config';
import { env } from '../../src/config/env';
import { one, pool, rows } from '../../src/db/pool';
import { logger } from '../../src/lib/logger';
import { mailer } from '../../src/services/mailer';
import { makeAccount, makePanelUser, PASSWORD, request } from '../helpers/factory';
import {
  accountRow,
  auditActions,
  code,
  details,
  lastToken,
  login,
  newEmail,
  post,
  sent,
  setUp,
  signUp,
  verify,
  verifiedToken,
} from './helpers';

setUp();

const NEW = 'New-pass-456';
const forgot = (email: string) => post('/auth/forgot-password', { email });
const check = (token: string) => post('/auth/reset-password/check', { token });
const reset = (token: string, password = NEW, confirm_password = password) =>
  post('/auth/reset-password', { token, password, confirm_password });
/* As if the last link had been sent `seconds` ago. */
const ageLink = (email: string, seconds: number) =>
  pool.query(`UPDATE student_accounts SET reset_sent_at = now() - make_interval(secs => $2) WHERE email = $1`, [email, seconds]);

const INVALID = 'This password reset link is not valid or has already been used. Please request a new link.';

describe('POST /auth/forgot-password', () => {
  it('e-mails a one-time link to the portal; only an HMAC of its token is stored', async () => {
    const s = await makeAccount();
    const res = await forgot(s.email.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('A password reset link has been sent to your email ID. The link is valid for 30 minutes.');
    expect(res.body.data).toEqual({ email: s.email, link_valid_minutes: 30, resend_after: 60 });
    expect(sent.links).toEqual([{ to: s.email, name: s.first_name, link: expect.any(String), minutes: 30 }]);
    /* PORTAL_URL, never the request's Host. */
    expect(sent.links[0]!.link).toMatch(/^http:\/\/localhost:5176\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
    const row = await accountRow(s.email);
    expect(row.reset_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((row.reset_expires_at as Date).getTime() - (row.reset_sent_at as Date).getTime()).toBe(30 * 60_000);
    expect(await auditActions(s.id)).toEqual(['edp.account.password_reset_requested']);
    const [log] = await rows<{ details: unknown }>(`SELECT details FROM audit_logs WHERE resource_id = $1`, [s.id]);
    expect(log!.details).toBeNull();
  });

  it('says when the e-mail is not registered, and sends nothing', async () => {
    const res = await forgot('nobody-here@example.test');
    expect(res.status).toBe(404);
    expect(code(res)).toBe('EMAIL_NOT_REGISTERED');
    expect(res.body.message).toBe('This email ID is not registered. Kindly check your email ID.');
    expect(sent.links).toHaveLength(0);
    expect(details(await forgot('x'))).toEqual([{ field: 'body.email', message: 'Enter a valid email address' }]);
  });

  it('refuses a disabled account', async () => {
    const s = await makeAccount();
    await forgot(s.email);
    await pool.query(`UPDATE student_accounts SET is_active = false WHERE id = $1`, [s.id]);
    const res = await forgot(s.email);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This account has been disabled. Please contact the programme office.');
    /* Its link does not work either. */
    expect(code(await reset(lastToken()))).toBe('RESET_LINK_INVALID');
    expect(code(await check(lastToken()))).toBe('RESET_LINK_INVALID');
    expect(sent.links).toHaveLength(1);
  });

  it('waits a minute between links; a newer link replaces the one before', async () => {
    const { email } = await makeAccount();
    await forgot(email);
    const first = lastToken();
    const tooSoon = await forgot(email);
    expect(tooSoon.status).toBe(429);
    expect(code(tooSoon)).toBe('RESET_TOO_SOON');
    expect(tooSoon.body.message).toMatch(
      /^A password reset link was just sent to this email ID\. Please check your email, or try again in (5\d seconds|1 min)\.$/,
    );
    expect(sent.links).toHaveLength(1);
    expect((await check(first)).status).toBe(200);
    await ageLink(email, 61);
    expect((await forgot(email)).status).toBe(200);
    expect(code(await reset(first))).toBe('RESET_LINK_INVALID');
    expect((await check(lastToken())).status).toBe(200);
  });

  it('two requests at once send one link', async () => {
    const { email } = await makeAccount();
    const results = await Promise.all([forgot(email), forgot(email)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(sent.links).toHaveLength(1);
    expect((await check(lastToken())).status).toBe(200);
  });

  it('sends at most five links an hour to one account', async () => {
    const { email } = await makeAccount();
    for (let i = 0; i < 5; i++) {
      await ageLink(email, 61);
      expect((await forgot(email)).status).toBe(200);
    }
    await ageLink(email, 61);
    const res = await forgot(email);
    expect(res.status).toBe(429);
    expect(code(res)).toBe('RESET_TOO_SOON');
    expect(res.body.message).toBe('Too many password reset requests for this email ID. Please try again after an hour.');
    expect(sent.links).toHaveLength(5);
    await pool.query(`UPDATE student_accounts SET reset_window_start = now() - interval '61 minutes' WHERE email = $1`, [email]);
    expect((await forgot(email)).status).toBe(200);
  });

  it('an e-mail that could not be sent does not count, and an earlier link still works', async () => {
    const { email } = await makeAccount();
    for (let i = 0; i < 6; i++) {
      vi.mocked(mailer.sendPasswordReset).mockRejectedValueOnce(new Error('SMTP unavailable'));
      expect((await forgot(email)).status).toBe(500);
    }
    expect(await accountRow(email)).toMatchObject({ reset_send_count: 0, reset_token_hash: null, reset_sent_at: null });
    expect((await forgot(email)).status).toBe(200);
    expect(sent.links).toHaveLength(1);
    await ageLink(email, 61);
    vi.mocked(mailer.sendPasswordReset).mockRejectedValueOnce(new Error('SMTP unavailable'));
    expect((await forgot(email)).status).toBe(500);
    expect((await accountRow(email)).reset_send_count).toBe(1);
    expect((await reset(lastToken())).status).toBe(200);
  });
});

describe('POST /auth/reset-password and /check', () => {
  it('sets the new password once, signs out every device and starts the count of wrong passwords again', async () => {
    const email = newEmail();
    const session = await verifiedToken(email);
    for (let i = 0; i < 10; i++) await login(email, 'Wrong-pass-1');
    expect((await login(email)).status).toBe(429);
    await forgot(email);
    const token = lastToken();
    const ready = await check(token);
    expect(ready.status).toBe(200);
    expect(ready.body.data).toEqual({ email });

    const done = await reset(token);
    expect(done.status).toBe(200);
    expect(done.body.message).toBe('Your password has been changed. Please log in with your new password.');
    expect(done.body.data).toEqual({ email });
    expect((await login(email, PASSWORD)).status).toBe(401);
    const again = await login(email, NEW);
    expect(again.status).toBe(200);
    expect((await request('get', '/me', again.body.data.token)).status).toBe(200);
    const old = await request('get', '/me', session);
    expect(old.status).toBe(401);
    expect(old.body.message).toMatch(/^Your password was changed\./);

    /* The link works once. */
    const reused = await reset(token, 'Third-pass-789');
    expect(reused.status).toBe(400);
    expect(code(reused)).toBe('RESET_LINK_INVALID');
    expect(reused.body.message).toBe(INVALID);
    expect(code(await check(token))).toBe('RESET_LINK_INVALID');
    const row = await accountRow(email);
    expect(row).toMatchObject({ reset_token_hash: null, reset_expires_at: null, failed_logins: 0 });
    expect(row.password_changed_at).toBeInstanceOf(Date);
    expect((await auditActions(row.id as string)).slice(-1)).toEqual(['edp.account.password_reset']);
  });

  it('checks the new password like the sign-up', async () => {
    const { email } = await makeAccount();
    await forgot(email);
    const token = lastToken();
    expect(details(await reset(token, 'short'))[0]).toEqual({
      field: 'body.password',
      message: 'Password must be at least 8 characters',
    });
    expect(details(await reset(token, NEW, 'New-pass-457'))).toEqual([
      { field: 'body.confirm_password', message: 'Passwords do not match' },
    ]);
    expect(details(await reset(' '))[0]).toEqual({ field: 'body.token', message: 'The password reset link is incomplete' });
    expect(details(await check('x'.repeat(201)))[0]).toEqual({
      field: 'body.token',
      message: 'This password reset link is not valid',
    });
    expect(details(await post('/auth/reset-password/check', {}))[0]!.message).toBe('The password reset link is incomplete');
    /* The link still works. */
    expect((await reset(token)).status).toBe(200);
  });

  it('refuses an unknown link, and one that has expired', async () => {
    const unknown = await check('x'.repeat(43));
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe(INVALID);
    const { email } = await makeAccount();
    await forgot(email);
    await pool.query(`UPDATE student_accounts SET reset_expires_at = now() - interval '1 second' WHERE email = $1`, [email]);
    for (const res of [await check(lastToken()), await reset(lastToken())]) {
      expect(res.status).toBe(400);
      expect(code(res)).toBe('RESET_LINK_EXPIRED');
      expect(res.body.message).toBe('This password reset link has expired. Please request a new link.');
    }
    expect((await login(email)).status).toBe(200);
  });

  it('used twice at once: one change, the other link is invalid', async () => {
    const { email } = await makeAccount();
    await forgot(email);
    const token = lastToken();
    const [a, b] = await Promise.all([reset(token, 'First-pass-1'), reset(token, 'Second-pass-2')]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(code(a.status === 400 ? a : b)).toBe('RESET_LINK_INVALID');
    expect((await login(email, a.status === 200 ? 'First-pass-1' : 'Second-pass-2')).status).toBe(200);
  });

  it('verifies an account that never entered its code, and drops the code', async () => {
    const email = newEmail();
    await signUp(email);
    await forgot(email);
    expect((await reset(lastToken())).status).toBe(200);
    expect((await verify(email)).status).toBe(409);
    const ok = await login(email, NEW);
    expect(ok.status).toBe(200);
    expect(ok.body.data.account.email_verified).toBe(true);
    expect(await one(`SELECT status FROM applications WHERE account_id = $1`, [ok.body.data.account.id])).toEqual({
      status: 'DRAFT',
    });
    expect((await accountRow(email)).otp_hash).toBeNull();
  });
});

describe('the password reset e-mail', () => {
  const LINK = 'http://localhost:5176/reset-password?token=abc';
  const smtp = { ...config.smtp };
  const from = env.SMTP_FROM;
  beforeEach(() => {
    /* The real function: what it hands to the mail server is looked at. */
    vi.mocked(mailer.sendPasswordReset).mockRestore();
  });
  afterEach(async () => {
    Object.assign(config.smtp, smtp);
    Object.assign(env, { SMTP_FROM: from });
    await pool.query(`DELETE FROM settings`);
  });

  /* A mail server that keeps the message, as it would be sent. */
  function mailServer() {
    Object.assign(config.smtp, { host: 'smtp.example.test', user: 'portal@example.test', pass: 'x' });
    const real = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const messages: string[] = [];
    const envelopes: unknown[] = [];
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: async (mail: object) => {
        const info = (await real.sendMail(mail)) as unknown as { message: Buffer; envelope: unknown };
        messages.push(info.message.toString('utf8'));
        envelopes.push(mail);
        return info;
      },
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    return {
      create,
      messages,
      mails: envelopes as { text: string; html: string; subject: string; replyTo?: string; from: unknown }[],
    };
  }

  it('has a text and an HTML part, the logo inside, and replies to the support team', async () => {
    const admin = await makePanelUser();
    await pool.query(`INSERT INTO settings (key, value, updated_by) VALUES ('support', $1, $2)`, [
      JSON.stringify({
        message: 'Write to {email} or call {mobile} <now>.',
        email: 'help@example.test',
        mobile: '+91 80000 00000',
      }),
      admin.id,
    ]);
    const { create, messages, mails } = mailServer();
    await mailer.sendPasswordReset('kavya@example.test', '<Kavya> & Co', LINK, 30);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        auth: { user: 'portal@example.test', pass: 'x' },
        connectionTimeout: 10_000,
      }),
    );
    const [mail] = mails;
    expect(mail!.subject).toBe('Reset your password – 3 Month Internship Placement Program');
    expect(mail!.replyTo).toBe('help@example.test');
    expect(mail!.from).toEqual({
      name: '3 Month Internship Placement Program – Sumago Infotech',
      address: 'portal@example.test',
    });
    expect(mail!.text).toContain('Dear <Kavya> & Co,');
    expect(mail!.text).toContain(`\n${LINK}\n`);
    expect(mail!.text).toContain('This link is valid for 30 minutes and can be used once.');
    /* Everything that was typed by someone is escaped. */
    expect(mail!.html).toContain('Dear &#60;Kavya&#62; &#38; Co,');
    expect(mail!.html).toContain(`<a href="${LINK}"`);
    expect(mail!.html).toContain('If you did not ask to reset your password');
    expect(mail!.html).toContain('Write to <a href="mailto:help@example.test"');
    expect(mail!.html).toContain('&#60;now&#62;');
    expect(mail!.html).toContain('href="tel:+918000000000"');
    const [message] = messages;
    expect(message).toMatch(/^To: kavya@example\.test$/m);
    expect(message).toMatch(/^X-Entity-Ref-ID: [0-9a-f-]{36}$/m);
    expect(message).toContain('multipart/alternative');
    expect(message).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(message).toMatch(/Content-Type: text\/html; charset=utf-8/);
    expect(message).toMatch(/Content-Type: image\/png; name=sumago-logo\.png/);
    expect(message).toMatch(/Content-Id: <sumago-logo@ipp>/i);
    expect(message).toMatch(/Content-Disposition: inline; filename=sumago-logo\.png/);
    expect(mail!.html).toContain('src="cid:sumago-logo@ipp"');
  });

  it('has no Reply-To without a support e-mail, and takes the sender from SMTP_FROM', async () => {
    Object.assign(env, { SMTP_FROM: 'Portal <noreply@example.test>' });
    const { mails } = mailServer();
    await mailer.sendPasswordReset('kavya@example.test', 'Kavya', LINK, 30);
    expect(mails[0]!.replyTo).toBeUndefined();
    expect(mails[0]!.from).toBe('Portal <noreply@example.test>');
  });

  it('a mail server that refuses is a 503, and the log does not name the student', async () => {
    const { email } = await makeAccount();
    const { create } = mailServer();
    const error = vi.spyOn(logger, 'error');
    create.mockReturnValue({
      sendMail: async () => {
        throw Object.assign(new Error(`550 no such user ${email}`), { code: 'EENVELOPE', responseCode: 550, rejected: [email] });
      },
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const res = await forgot(email);
    expect(res.status).toBe(503);
    expect(code(res)).toBe('EMAIL_UNAVAILABLE');
    expect(res.body.message).toBe('Email could not be sent right now. Please try again in a few minutes.');
    expect((await accountRow(email)).reset_token_hash).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls.map(([a]) => a))).not.toContain(email);
  });

  it('without a mail server writes the link to the log on a developer’s machine, and refuses anywhere else', async () => {
    config.smtp.host = undefined;
    const warn = vi.spyOn(logger, 'warn');
    await mailer.sendPasswordReset('kavya@example.test', 'Kavya', LINK, 30);
    expect(warn).toHaveBeenCalledWith({ link: LINK }, expect.any(String));
    Object.assign(env, { isLocal: false });
    try {
      warn.mockClear();
      await expect(mailer.sendPasswordReset('kavya@example.test', 'Kavya', LINK, 30)).rejects.toMatchObject({
        status: 503,
        code: 'EMAIL_UNAVAILABLE',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, { isLocal: true });
    }
  });
});
