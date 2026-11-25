import { isDate, MOBILE_RE, normaliseMobile } from '../lib/text';
import { YES_NO, type FieldType } from './constants';

/*
 * The types of the own fields: what a given value of each must look like, and how it is read. Every value is stored as text;
 * CHECKBOXES as a JSON list of the chosen values. A choice of a list is checked against its master (form.ts).
 */
const CHOICE_TYPES: readonly FieldType[] = ['DROPDOWN', 'RADIO', 'CHECKBOXES'];
/* A type with choices of its own (kind FIELD:<key>). */
export const hasChoices = (type: FieldType) => CHOICE_TYPES.includes(type);

/* The longest stored value of each type. */
export const CUSTOM_VALUE_MAX: Record<FieldType, number> = {
  TEXT: 250,
  TEXTAREA: 2000,
  EMAIL: 254,
  MOBILE: 20,
  URL: 500,
  NUMBER: 20,
  DATE: 10,
  TIME: 5,
  MONTH: 7,
  YEAR: 4,
  DROPDOWN: 120,
  RADIO: 120,
  CHECKBOXES: 2000,
  YES_NO: 3,
  CONSENT: 3,
};

/* The chosen values of CHECKBOXES; null = not such a list. */
export function chosen(value: string): string[] | null {
  try {
    const list: unknown = JSON.parse(value);
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) return null;
    return new Set(list).size === list.length ? list : null;
  } catch {
    return null;
  }
}

export const YEARS = { MIN: 1900, MAX: 2100 } as const;
const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isMonth = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isYear = (v: string) => /^\d{4}$/.test(v) && Number(v) >= YEARS.MIN && Number(v) <= YEARS.MAX;

/* What is wrong with a given value, by the type of its own field; null = nothing. */
export function typeIssue(f: { type: FieldType; labelEn: string }, v: string): string | null {
  const label = f.labelEn;
  switch (f.type) {
    case 'NUMBER':
      return /^-?\d{1,12}(\.\d{1,4})?$/.test(v) ? null : `${label} must be a number`;
    case 'DATE':
      return isDate(v) ? null : `${label} must be a real date in YYYY-MM-DD format`;
    case 'TIME':
      return isTime(v) ? null : `${label} must be a time in HH:MM format`;
    case 'MONTH':
      return isMonth(v) ? null : `${label} must be a month in YYYY-MM format`;
    case 'YEAR':
      return isYear(v) ? null : `${label} must be a year, e.g. 2026`;
    case 'EMAIL':
      return v.length <= CUSTOM_VALUE_MAX.EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)
        ? null
        : `${label} must be a valid email address`;
    case 'MOBILE':
      return MOBILE_RE.test(normaliseMobile(v)) ? null : `${label} must be a 10-digit Indian number starting 6–9`;
    case 'URL':
      return v.length <= CUSTOM_VALUE_MAX.URL && /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(v)
        ? null
        : `${label} must be a web address starting with http:// or https://`;
    case 'YES_NO':
      return (YES_NO as readonly string[]).includes(v) ? null : `${label}: select Yes or No`;
    case 'CONSENT':
      return v === 'Yes' ? null : `${label} must be ticked`;
    case 'CHECKBOXES':
      return chosen(v)?.length ? null : `Select valid choices for ${label}`;
    case 'DROPDOWN':
    case 'RADIO':
      return null;
    default:
      return v.length > CUSTOM_VALUE_MAX[f.type] ? `${label} must be at most ${CUSTOM_VALUE_MAX[f.type]} characters` : null;
  }
}

/* What a required field without a value is told. */
export const missingText = (f: { type: FieldType; labelEn: string }) =>
  f.type === 'CONSENT' ? `${f.labelEn} must be ticked` : `${f.labelEn} is required`;

/* Nothing chosen and nothing ticked are no value. */
export const isBlank = (type: FieldType, v: string) =>
  v === '' || (type === 'CHECKBOXES' && v === '[]') || (type === 'CONSENT' && v === 'No');
