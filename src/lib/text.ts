import { z } from 'zod';

/*
 * Control characters other than tab and line breaks: PostgreSQL refuses NUL outright, which would otherwise be a 500 instead
 * of a 422 naming the field.
 */
export const hasControlChars = (v: string) =>
  [...v].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f);
  });

const required = (label: string) => ({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` });
const storable = (label: string) => (v: string) => !hasControlChars(v) || `${label} contains characters that cannot be saved`;

/* Trimmed text of min to max characters that can be stored; composed (NFC), so the same Marathi text is always the same. */
export const content = (label: string, max: number, min = 0) =>
  z
    .string(required(label))
    .trim()
    .min(min, min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((v) => storable(label)(v) === true, `${label} contains characters that cannot be saved`)
    .transform((v) => v.normalize('NFC'));

/* Trimmed, non-empty text up to `max` characters. */
export const text = (label: string, max: number) =>
  z
    .string(required(label))
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((v) => !hasControlChars(v), `${label} contains characters that cannot be saved`);

export const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
export const personName = (label: string, max: number) =>
  text(label, max).refine((v) => !v || NAME_RE.test(v), `${label} may contain only letters, spaces and . ' -`);

/* +91 / 0 prefix, spaces, dashes and brackets allowed, then 10 digits starting 6–9. */
export const normaliseMobile = (v: string) =>
  v
    .replace(/[\s()-]/g, '')
    .replace(/^\+?91(?=\d{10}$)/, '')
    .replace(/^0(?=\d{10}$)/, '');
export const MOBILE_RE = /^[6-9]\d{9}$/;
export const mobileNumber = (label: string) =>
  text(label, 20).refine((v) => MOBILE_RE.test(normaliseMobile(v)), `${label} must be a 10-digit Indian number starting 6–9`);

/* A sign-in e-mail, lower case. */
export const email = z
  .string({ required_error: 'Email is required', invalid_type_error: 'Email must be text' })
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(254, 'Email must be at most 254 characters')
  .email('Enter a valid email address');

/* 8–72 characters (bcrypt's limit, in bytes) with at least one letter and one digit. */
export const password = z
  .string({ required_error: 'Password is required', invalid_type_error: 'Password must be text' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a digit')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Password must be at most 72 characters');

/* An id of a record: a malformed one is a record that does not exist (404), never a 500. */
export const UUID_RE = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);
export const uuid = (label = 'Id') =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .regex(UUID_RE, `${label} is not valid`);

/* A real calendar date, YYYY-MM-DD. */
export function isDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
