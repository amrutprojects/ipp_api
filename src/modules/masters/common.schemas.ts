import { z } from 'zod';
import { blankAsMissing, listQuery } from '../../lib/paging';
import { hasControlChars, uuid } from '../../lib/text';
import { NAME_MAX, ORDER_MAX } from '../../program/constants';

/*
 * What the masters accept. Names are one line: composed (NFC), single-spaced and trimmed, so the same name is always stored
 * the same way and the unique indexes see it. In a change, a key that is not sent leaves its value as it is; a blank optional
 * text clears it (null).
 */
const blankAsNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankAsNull, schema.nullable().optional());
/* A blank value is the same as none. */
export const unlessBlank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : blankAsMissing(v)), schema.optional());

const given = (label: string) => ({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` });
const oneLine = (v: string) => v.normalize('NFC').replace(/\s+/g, ' ').trim();
const line = (label: string, max: number) =>
  z
    .string(given(label))
    .transform(oneLine)
    .pipe(
      z
        .string()
        .max(max, `${label} must be at most ${max} characters`)
        .refine((v) => !hasControlChars(v), `${label} contains characters that cannot be saved`),
    );

/* A name or label, in English (required) and in Marathi (optional). */
export const named = (label: string) => line(label, NAME_MAX).pipe(z.string().min(1, `${label} is required`));
export const optionalNamed = (label: string, max = NAME_MAX) => optional(line(label, max));
export const names = { name_en: named('Name'), name_mr: optionalNamed('Marathi name') };

export const order = z
  .number({ invalid_type_error: 'Order must be a number' })
  .int('Order must be a whole number')
  .min(0, 'Order must be 0 or more')
  .max(ORDER_MAX, `Order must be at most ${ORDER_MAX}`);
export const flag = (label: string) =>
  z.boolean({ required_error: `${label} is required`, invalid_type_error: `${label} must be true or false` });

/* The name of a state, district or taluka, in any script. */
export const placeName = z
  .string(given('Name'))
  .transform(oneLine)
  .pipe(
    z
      .string()
      .min(2, 'Must be at least 2 characters')
      .max(100, 'Must be at most 100 characters')
      .regex(/^[\p{L}\p{M}][\p{L}\p{M}\d .,'’()/-]*$/u, 'Use letters, digits, spaces and . , ( ) - / only'),
  );
/* The name of a center: may start with a digit and carry "&". */
export const entityName = z
  .string(given('Name'))
  .transform(oneLine)
  .pipe(
    z
      .string()
      .min(2, 'Must be at least 2 characters')
      .max(150, 'Must be at most 150 characters')
      .regex(/^[\p{L}\p{M}\d][\p{L}\p{M}\d .,'’()/&-]*$/u, 'Use letters, digits, spaces and . , ( ) - / & only'),
  );

/* A code, stored in upper case. */
const code = (max: number, pattern: RegExp, message: string) =>
  z
    .string(given('Code'))
    .trim()
    .toUpperCase()
    .pipe(
      z.string().min(2, 'Must be at least 2 characters').max(max, `Must be at most ${max} characters`).regex(pattern, message),
    );
export const stateCode = code(10, /^[A-Z][A-Z0-9]*$/, 'Use A–Z and 0–9 only, starting with a letter');
/* Of a district, taluka or center. */
export const placeCode = code(20, /^[A-Z][A-Z0-9-]*$/, 'Use A–Z, 0–9 and hyphen, starting with a letter');

/* The id of another record, as the database writes it. */
export const ref = (label: string) => uuid(label).toLowerCase();
export const idParams = z.object({ id: uuid() });

/* A change must change something. */
export const hasChange = (b: Record<string, unknown>) => Object.values(b).some((v) => v !== undefined);
export const NO_CHANGE = 'Nothing to change';

/* Query of a list, A to Z unless asked otherwise. */
export const masterListQuery = <S extends readonly [string, ...string[]]>(sortable: S) =>
  listQuery(sortable, 'ASC').extend({
    search: z
      .string()
      .trim()
      .max(100)
      .refine((v) => !hasControlChars(v), 'Search contains characters that cannot be used')
      .optional(),
  });
/* Active or inactive ones only; blank = both. */
export const statusFilter = z.preprocess(
  (v) => (typeof v === 'string' ? blankAsMissing(v.trim().toUpperCase()) : v),
  z.enum(['ACTIVE', 'INACTIVE'], { errorMap: () => ({ message: 'Choose Active or Inactive' }) }).optional(),
);
