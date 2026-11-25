import type { Request } from 'express';
import { DatabaseError } from 'pg';
import { config } from '../../config';
import { one, pool, transaction, type Db } from '../../db/pool';
import type { StudentAccount } from '../../http/auth';
import { AppError } from '../../http/errors';
import { maskMobile } from '../../lib/aadhaar';
import { hashPassword, passwordMatches } from '../../lib/passwords';
import { normaliseMobile } from '../../lib/text';
import { hashOtp, hashResetToken, newResetToken, otpMatches, passwordVersion, randomOtp, signSession } from '../../lib/tokens';
import { audit } from '../../services/audit';
import { mailer } from '../../services/mailer';
import { sms } from '../../services/sms';
import type { SignupBody } from './accounts.schemas';

/*
 * A student's account: sign-up with a code texted to the mobile number, sign-in, and a new password from an e-mailed link.
 * Times are the database's, so every server counts alike. A code, link or sign-in attempt is counted before it is checked,
 * in one statement, so requests sent at the same moment cannot pass a limit together.
 */
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 10;
export const RESET_LINK_MINUTES = 30;
export const RESET_WAIT_SECONDS = 60;
const RESET_MAX_PER_HOUR = 5;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW = `interval '15 minutes'`;

const MESSAGES = {
  OTP_INCORRECT: 'Incorrect OTP',
  OTP_EXPIRED: 'OTP has expired. Please request a new OTP.',
  OTP_NOT_PENDING: 'No OTP is pending for this account. Please request a new OTP.',
  OTP_TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Please request a new OTP when the current one expires.',
  SIGNUP_PASSWORD_MISMATCH:
    'This is not the password chosen when the account was created. Enter that password, or create the account again.',
  RESET_LINK_INVALID: 'This password reset link is not valid or has already been used. Please request a new link.',
  RESET_LINK_EXPIRED: 'This password reset link has expired. Please request a new link.',
} as const;
const refused = (code: keyof typeof MESSAGES) => new AppError(400, MESSAGES[code], code);
const noAccount = () => AppError.notFound('No account was found for this email address. Please create an account.');
const alreadyVerified = () => AppError.conflict('This email address is already verified. Please log in.');
const accountExists = () => AppError.conflict('An account with this email address already exists. Please log in.');
const disabled = () => AppError.forbidden('This account has been disabled. Please contact the programme office.');

interface Account extends StudentAccount {
  password_hash: string;
  is_active: boolean;
  otp_hash: string | null;
  otp_expires_at: Date | null;
  otp_sent_at: Date | null;
  otp_attempts: number;
  otp_send_count: number;
  otp_window_start: Date | null;
  reset_token_hash: string | null;
  reset_expires_at: Date | null;
  reset_sent_at: Date | null;
  reset_send_count: number;
  reset_window_start: Date | null;
  /* Seconds the pending code and link still work (null = none; 0 or less = over), and since each was sent. */
  otp_left: number | null;
  otp_age: number | null;
  reset_left: number | null;
  reset_age: number | null;
  /* Sent within the current hour. */
  otp_sends: number;
  reset_sends: number;
}

const seconds = (interval: string) => `extract(epoch FROM ${interval})::float8`;
const sends = (what: 'otp' | 'reset') =>
  `CASE WHEN ${what}_window_start > clock_timestamp() - interval '1 hour' THEN ${what}_send_count ELSE 0 END`;
const COLUMNS = `id, first_name, middle_name, last_name, email, mobile, password_hash, verified_at, password_changed_at, is_active,
  otp_hash, otp_expires_at, otp_sent_at, otp_attempts, otp_send_count, otp_window_start,
  reset_token_hash, reset_expires_at, reset_sent_at, reset_send_count, reset_window_start,
  ${seconds('otp_expires_at - clock_timestamp()')} AS otp_left, ${seconds('clock_timestamp() - otp_sent_at')} AS otp_age,
  ${seconds('reset_expires_at - clock_timestamp()')} AS reset_left, ${seconds('clock_timestamp() - reset_sent_at')} AS reset_age,
  ${sends('otp')} AS otp_sends, ${sends('reset')} AS reset_sends`;

const byEmail = (email: string, db: Db = pool) =>
  one<Account>(`SELECT ${COLUMNS} FROM student_accounts WHERE email = $1 AND deleted_at IS NULL`, [email], db);
/* The account's row until the transaction ends. */
const lockByEmail = (email: string, db: Db) =>
  one<Account>(`SELECT ${COLUMNS} FROM student_accounts WHERE email = $1 AND deleted_at IS NULL FOR UPDATE`, [email], db);

export const accountDto = (a: StudentAccount) => ({
  id: a.id,
  first_name: a.first_name,
  middle_name: a.middle_name,
  last_name: a.last_name,
  email: a.email,
  mobile_number: a.mobile,
  email_verified: !!a.verified_at,
});

function session(a: StudentAccount) {
  const { token, expiresAt } = signSession('student', a.id, passwordVersion(a.password_changed_at));
  return { token, expires_at: expiresAt, account: accountDto(a) };
}

const event = (action: string, accountId: string, details?: Record<string, unknown>) => ({
  action: `edp.account.${action}`,
  resource: 'student_account',
  resourceId: accountId,
  actor: { kind: 'STUDENT' as const, id: accountId },
  details,
});

/* Every verified account has exactly one application, made on first use. */
export const ensureApplication = (db: Db, accountId: string) =>
  db.query(`INSERT INTO applications (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [accountId]);

/* 45 → "45 seconds", 287 → "4 min 47 s", 300 → "5 min". */
const duration = (s: number) =>
  s < 60 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
/* Whole seconds until `wait` seconds have passed since something was sent `age` seconds ago (0 = now, or nothing sent). */
const secondsLeft = (wait: number, age: number | null) => (age === null ? 0 : Math.max(0, Math.min(wait, Math.ceil(wait - age))));

/* ------------------------------------------------------------------------------------------------------ one-time codes */

/* The pending code's remaining lifetime and the wait before a new one, in seconds (0 = expired / now). */
const otpTiming = (a: Account) => ({
  email: a.email,
  mobile_masked: maskMobile(a.mobile),
  otp_expires_in: Math.max(0, Math.ceil(a.otp_left ?? 0)),
  resend_after: secondsLeft(config.otp.resendSeconds, a.otp_age),
});
type OtpTiming = ReturnType<typeof otpTiming>;

interface NewOtp {
  otp: string;
  hash: string;
}
const otpTooSoon = (message: string) => AppError.tooMany(message, 'OTP_RESEND_TOO_SOON');

/*
 * Replaces the code of a locked account, or says why it cannot be replaced yet: not before config.otp.resendSeconds (default:
 * the code's lifetime, so once it has expired), and at most OTP_MAX_PER_HOUR an hour. Only an HMAC of the code is stored.
 */
async function newOtp(db: Db, a: Account): Promise<NewOtp | AppError> {
  const wait = secondsLeft(config.otp.resendSeconds, a.otp_age);
  if (wait > 0) return otpTooSoon(`Please wait ${duration(wait)} before requesting a new OTP.`);
  if (a.otp_sends >= OTP_MAX_PER_HOUR) return otpTooSoon('Too many OTP requests. Please try again after an hour.');
  const otp = config.otp.fixed ?? randomOtp();
  const hash = hashOtp(a.id, otp);
  await db.query(
    `UPDATE student_accounts SET otp_hash = $2, otp_expires_at = statement_timestamp() + make_interval(secs => $3),
       otp_sent_at = statement_timestamp(), otp_attempts = 0, otp_send_count = $4,
       otp_window_start = CASE WHEN $4 = 1 THEN statement_timestamp() ELSE otp_window_start END
     WHERE id = $1`,
    [a.id, hash, config.otp.ttlSeconds, a.otp_sends + 1],
  );
  return { otp, hash };
}

/* Texts the new code. If that fails, the account is as it was before: the student can ask again at once, and it does not count. */
async function textOtp(a: Account, { otp, hash }: NewOtp): Promise<OtpTiming> {
  const { ttlSeconds, resendSeconds } = config.otp;
  try {
    await sms.sendOtp(a.mobile, otp, ttlSeconds);
  } catch (err) {
    await pool.query(
      `UPDATE student_accounts SET otp_hash = $3, otp_expires_at = $4, otp_sent_at = $5, otp_attempts = $6, otp_send_count = $7,
         otp_window_start = $8
       WHERE id = $1 AND otp_hash = $2`,
      [a.id, hash, a.otp_hash, a.otp_expires_at, a.otp_sent_at, a.otp_attempts, a.otp_send_count, a.otp_window_start],
    );
    throw err;
  }
  return { ...otpTiming(a), otp_expires_in: ttlSeconds, resend_after: resendSeconds };
}

async function sendNewOtp(email: string): Promise<OtpTiming> {
  const { account, otp } = await transaction(async (db) => {
    const account = await lockByEmail(email, db);
    if (!account) throw noAccount();
    if (account.verified_at) throw alreadyVerified();
    return { account, otp: await newOtp(db, account) };
  });
  if (otp instanceof AppError) throw otp;
  return textOtp(account, otp);
}

/* Why a code could not be tried. */
async function otpProblem(email: string): Promise<AppError> {
  const a = await byEmail(email);
  if (!a) return refused('OTP_NOT_PENDING');
  if (a.verified_at) return alreadyVerified();
  if (!a.otp_hash || a.otp_left === null) return refused('OTP_NOT_PENDING');
  if (a.otp_left <= 0) return refused('OTP_EXPIRED');
  if (a.otp_attempts >= OTP_MAX_ATTEMPTS) return AppError.tooMany(MESSAGES.OTP_TOO_MANY_ATTEMPTS, 'OTP_TOO_MANY_ATTEMPTS');
  /* It was replaced at this very moment. */
  return refused('OTP_INCORRECT');
}

/* ---------------------------------------------------------------------------------------------------------- reset links */

/* The account a link belongs to, while it can be used. */
async function accountOfLink(token: string): Promise<Account> {
  const a = await one<Account>(`SELECT ${COLUMNS} FROM student_accounts WHERE reset_token_hash = $1 AND deleted_at IS NULL`, [
    hashResetToken(token),
  ]);
  if (!a?.is_active || a.reset_left === null) throw refused('RESET_LINK_INVALID');
  if (a.reset_left <= 0) throw refused('RESET_LINK_EXPIRED');
  return a;
}

export const accountsService = {
  /*
   * Sign-up: the account is stored unverified and a code is texted; a verified e-mail → 409. Signing up again before
   * verifying replaces the details and the password (e.g. a corrected mobile number). While the code already sent still works
   * no new one is sent, unless the mobile number changed: the old code went to the old number and is dropped. The code alone
   * does not finish the sign-up: verify-otp also needs the password chosen here, so someone who signs up with another person's
   * e-mail cannot end up with a verified account carrying their own password.
   */
  async register(req: Request, body: SignupBody): Promise<OtpTiming> {
    if ((await byEmail(body.email))?.verified_at) throw accountExists();
    const passwordHash = await hashPassword(body.password);
    const values = [
      body.first_name,
      body.middle_name || null,
      body.last_name,
      normaliseMobile(body.mobile_number),
      passwordHash,
    ] as const;
    const { account, otp } = await transaction(async (db) => {
      const existing = await lockByEmail(body.email, db);
      if (existing?.verified_at) throw accountExists();
      let account: Account;
      if (existing) {
        const mobileChanged = existing.mobile !== values[3];
        account = (await one<Account>(
          `UPDATE student_accounts SET first_name = $2, middle_name = $3, last_name = $4, mobile = $5, password_hash = $6,
             failed_logins = 0, failed_window_start = NULL,
             otp_hash = CASE WHEN $7 THEN NULL ELSE otp_hash END, otp_expires_at = CASE WHEN $7 THEN NULL ELSE otp_expires_at END,
             otp_sent_at = CASE WHEN $7 THEN NULL ELSE otp_sent_at END, otp_attempts = CASE WHEN $7 THEN 0 ELSE otp_attempts END
           WHERE id = $1 RETURNING ${COLUMNS}`,
          [existing.id, ...values, mobileChanged],
          db,
        ))!;
        await audit.inTx(db, req, event('signup_replaced', account.id, { mobile_changed: mobileChanged }));
      } else {
        account = (await one<Account>(
          `INSERT INTO student_accounts (first_name, middle_name, last_name, mobile, password_hash, email)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
          [...values, body.email],
          db,
        ))!;
        await audit.inTx(db, req, event('create', account.id));
      }
      return { account, otp: otpTiming(account).otp_expires_in > 0 ? null : await newOtp(db, account) };
    }).catch((err: unknown) => {
      if (err instanceof DatabaseError && err.constraint === 'uq_student_accounts_email')
        throw AppError.conflict('This email address was just registered. Please enter the OTP sent to it.');
      throw err;
    });
    if (!otp) return otpTiming(account);
    if (otp instanceof AppError) throw otp;
    return textOtp(account, otp);
  },

  resendOtp: (email: string): Promise<OtpTiming> => sendNewOtp(email),

  /*
   * When the pending code expires and when a new one can be asked for, as the server counts them: the OTP page asks on
   * opening, as it cannot know when the code was sent.
   */
  async otpStatus(email: string): Promise<OtpTiming> {
    const a = await byEmail(email);
    if (!a) throw noAccount();
    if (a.verified_at) throw alreadyVerified();
    return otpTiming(a);
  },

  /*
   * Checks the texted code. The code proves the handset, not who chose the password, so the password of the sign-up must come
   * with it; a wrong one counts as a wrong attempt. Right → the account is verified and the student signed in.
   */
  async verifyOtp(req: Request, email: string, otp: string, password: string) {
    const account = await one<Account>(
      `UPDATE student_accounts SET otp_attempts = otp_attempts + 1
       WHERE email = $1 AND deleted_at IS NULL AND verified_at IS NULL AND otp_hash IS NOT NULL
         AND otp_expires_at > clock_timestamp() AND otp_attempts < $2
       RETURNING ${COLUMNS}`,
      [email, OTP_MAX_ATTEMPTS],
    );
    if (!account) throw await otpProblem(email);
    if (!otpMatches(account.id, otp, account.otp_hash)) throw refused('OTP_INCORRECT');
    if (!(await passwordMatches(password, account.password_hash))) throw refused('SIGNUP_PASSWORD_MISMATCH');
    if (!account.is_active) throw disabled();
    return transaction(async (db) => {
      /* Used once, and only if the password is still the one just checked (not replaced by a sign-up in between). */
      const verified = await one<Account>(
        `UPDATE student_accounts SET verified_at = now(), last_login_at = now(), otp_hash = NULL, otp_expires_at = NULL,
           otp_attempts = 0
         WHERE id = $1 AND verified_at IS NULL AND password_hash = $2 RETURNING ${COLUMNS}`,
        [account.id, account.password_hash],
        db,
      );
      if (!verified) {
        if ((await byEmail(email, db))?.verified_at) throw alreadyVerified();
        throw refused('SIGNUP_PASSWORD_MISMATCH');
      }
      await ensureApplication(db, account.id);
      await audit.inTx(db, req, event('verified', account.id));
      return session(verified);
    });
  },

  /*
   * E-mail and password. LOGIN_MAX_FAILURES wrong passwords within 15 minutes make the account wait (429); a right one starts
   * the count again. An unknown e-mail takes as long as a wrong password. An account that is not verified yet gets a new code,
   * if one may be sent, and 403 EMAIL_NOT_VERIFIED.
   */
  async login(email: string, password: string) {
    const open = `coalesce(failed_window_start > clock_timestamp() - ${LOGIN_WINDOW}, false)`;
    const account = await one<Account>(
      `UPDATE student_accounts SET failed_logins = CASE WHEN ${open} THEN failed_logins + 1 ELSE 1 END,
         failed_window_start = CASE WHEN ${open} THEN failed_window_start ELSE clock_timestamp() END
       WHERE email = $1 AND deleted_at IS NULL AND NOT (${open} AND failed_logins >= $2)
       RETURNING ${COLUMNS}`,
      [email, LOGIN_MAX_FAILURES],
    );
    if (!account && (await byEmail(email))) throw AppError.tooMany('Too many attempts. Please try again later.');
    const matches = await passwordMatches(password, account?.password_hash);
    if (!account || !matches) throw AppError.unauthorized('Incorrect email or password');
    const signsIn = account.is_active && !!account.verified_at;
    await transaction(async (db) => {
      await db.query(
        `UPDATE student_accounts SET failed_logins = 0, failed_window_start = NULL,
           last_login_at = CASE WHEN $2 THEN now() ELSE last_login_at END
         WHERE id = $1`,
        [account.id, signsIn],
      );
      if (signsIn) await ensureApplication(db, account.id);
    });
    if (!account.is_active) throw disabled();
    if (!account.verified_at) {
      await sendNewOtp(email).catch((err: unknown) => {
        if (!(err instanceof AppError && err.code === 'OTP_RESEND_TOO_SOON')) throw err;
      });
      throw AppError.forbidden(
        'Your mobile number is not verified yet. Enter the OTP sent to your mobile number.',
        'EMAIL_NOT_VERIFIED',
      );
    }
    return session(account);
  },

  /*
   * Forgot password: e-mails a link to the portal's page for a new password, to a registered e-mail only (another one → 404:
   * the programme office chose to tell the student so). A new link replaces the one before; at most one per
   * RESET_WAIT_SECONDS and RESET_MAX_PER_HOUR an hour. The link's address is PORTAL_URL, never the request's.
   */
  async forgotPassword(req: Request, email: string): Promise<void> {
    const token = newResetToken();
    const hash = hashResetToken(token);
    const tooSoon = (message: string) => AppError.tooMany(message, 'RESET_TOO_SOON');
    const account = await transaction(async (db) => {
      const a = await lockByEmail(email, db);
      if (!a) throw new AppError(404, 'This email ID is not registered. Kindly check your email ID.', 'EMAIL_NOT_REGISTERED');
      if (!a.is_active) throw disabled();
      if (a.reset_sends >= RESET_MAX_PER_HOUR)
        throw tooSoon('Too many password reset requests for this email ID. Please try again after an hour.');
      const wait = secondsLeft(RESET_WAIT_SECONDS, a.reset_age);
      if (wait > 0)
        throw tooSoon(
          `A password reset link was just sent to this email ID. Please check your email, or try again in ${duration(wait)}.`,
        );
      await db.query(
        `UPDATE student_accounts SET reset_token_hash = $2, reset_expires_at = statement_timestamp() + make_interval(mins => $3),
           reset_sent_at = statement_timestamp(), reset_send_count = $4,
           reset_window_start = CASE WHEN $4 = 1 THEN statement_timestamp() ELSE reset_window_start END
         WHERE id = $1`,
        [a.id, hash, RESET_LINK_MINUTES, a.reset_sends + 1],
      );
      await audit.inTx(db, req, event('password_reset_requested', a.id));
      return a;
    });
    try {
      const link = `${config.portalUrl}/reset-password?token=${token}`;
      await mailer.sendPasswordReset(account.email, account.first_name, link, RESET_LINK_MINUTES);
    } catch (err) {
      /* Not sent: as before the request (an earlier link still works); the student can ask again at once. */
      await pool.query(
        `UPDATE student_accounts SET reset_token_hash = $3, reset_expires_at = $4, reset_sent_at = $5, reset_send_count = $6,
           reset_window_start = $7
         WHERE id = $1 AND reset_token_hash = $2`,
        [
          account.id,
          hash,
          account.reset_token_hash,
          account.reset_expires_at,
          account.reset_sent_at,
          account.reset_send_count,
          account.reset_window_start,
        ],
      );
      throw err;
    }
  },

  /* Whether a link can still be used (the page asks before showing the form), and for which e-mail. */
  async checkResetLink(token: string) {
    return { email: (await accountOfLink(token)).email };
  },

  /*
   * Sets the new password, once: the link stops working, every session from before is refused, a pending code is dropped and
   * the count of wrong passwords starts again. An account that was not verified yet becomes verified: the link reached its
   * e-mail.
   */
  async resetPassword(req: Request, token: string, password: string) {
    const account = await accountOfLink(token);
    const passwordHash = await hashPassword(password);
    await transaction(async (db) => {
      const done = await one<{ id: string }>(
        `UPDATE student_accounts SET password_hash = $2, password_changed_at = now(), reset_token_hash = NULL,
           reset_expires_at = NULL, verified_at = coalesce(verified_at, now()), otp_hash = NULL, otp_expires_at = NULL,
           otp_attempts = 0, failed_logins = 0, failed_window_start = NULL
         WHERE id = $1 AND reset_token_hash = $3 AND reset_expires_at > now() AND is_active AND deleted_at IS NULL RETURNING id`,
        [account.id, passwordHash, hashResetToken(token)],
        db,
      );
      if (!done) throw refused('RESET_LINK_INVALID');
      await ensureApplication(db, account.id);
      await audit.inTx(db, req, event('password_reset', account.id, { verified_by_link: !account.verified_at }));
    });
    return { email: account.email };
  },
};
