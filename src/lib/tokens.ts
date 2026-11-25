import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { env } from '../config/env';
import { AppError } from '../http/errors';

/*
 * Sessions are signed tokens (Bearer only). Each audience has a key of its own derived from SESSION_SECRET, so a student's
 * token is never accepted by the panel or the other way round. The keys of one-time codes and reset links are separate too:
 * the database holds only an HMAC of each, so a copy of it cannot be used to guess or replay one.
 */
export type Audience = 'student' | 'panel';
const ISSUER = 'ipp-backend';
const keyFor = (purpose: string) => crypto.createHmac('sha256', env.SESSION_SECRET).update(`ipp:${purpose}`).digest('hex');
const KEYS: Record<Audience, string> = { student: keyFor('student'), panel: keyFor('panel') };
const OTP_KEY = keyFor('otp');
const RESET_KEY = keyFor('password-reset');

/* `pv`: when the password was last changed (ms), 0 = never; a later change makes every earlier session invalid. */
export function signSession(audience: Audience, subject: string, pv: number): { token: string; expiresAt: string } {
  const seconds = Math.round(config.sessionHours * 3600);
  const token = jwt.sign({ pv }, KEYS[audience], {
    algorithm: 'HS256',
    subject,
    audience,
    issuer: ISSUER,
    expiresIn: seconds,
    jwtid: crypto.randomUUID(),
  });
  return { token, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
}

export function readSession(audience: Audience, token: string): { id: string; pv: number } {
  try {
    const p = jwt.verify(token, KEYS[audience], { algorithms: ['HS256'], audience, issuer: ISSUER }) as jwt.JwtPayload;
    if (!p.sub) throw new Error('no subject');
    return { id: p.sub, pv: typeof p.pv === 'number' ? p.pv : 0 };
  } catch {
    throw AppError.unauthorized('Your session has expired. Please log in again.');
  }
}

export const passwordVersion = (changedAt: Date | null) => changedAt?.getTime() ?? 0;

/* A password reset link's token (256 bits, URL-safe), and what the database keeps of it. */
export const newResetToken = () => crypto.randomBytes(32).toString('base64url');
export const hashResetToken = (token: string) => crypto.createHmac('sha256', RESET_KEY).update(token).digest('hex');

export const hashOtp = (accountId: string, otp: string) =>
  crypto.createHmac('sha256', OTP_KEY).update(`${accountId}:${otp}`).digest('hex');

export function otpMatches(accountId: string, otp: string, stored: string | null): boolean {
  if (!stored) return false;
  const a = Buffer.from(hashOtp(accountId, otp), 'hex');
  const b = Buffer.from(stored.trim(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const randomOtp = (digits = 6) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
