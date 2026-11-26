import { logger } from '../lib/logger';
import { ageOn, today } from '../lib/dates';
import { isDate, MOBILE_RE, normaliseMobile } from '../lib/text';
import type { FieldType, Form } from './constants';
import { chosen, CUSTOM_VALUE_MAX, YEARS } from './field-types';
import { aadhaarDigits, isAadhaar } from './rules';
import { answer, matches } from './sandbox';

/*
 * The checks an ADMIN gives to a field: ready-made rules, any number of them, and own checks (a regular expression or a
 * JavaScript function), each with its own message. They are applied to a value that is given and of the field's type. These
 * are all the checks of a field beyond its type: the program's own fields start with the ones they always had (seeds,
 * migration 0006), and every one of them can be changed or taken away.
 */
export const RULE_TYPES = [
  'letters',
  'digits',
  'letters_digits',
  'no_spaces',
  'uppercase',
  'pin_code',
  'pan',
  'ifsc',
  'email',
  'indian_mobile',
  'aadhaar',
  'min_length',
  'max_length',
  'whole_number',
  'min_digits',
  'max_digits',
  'max_decimals',
  'min_value',
  'max_value',
  'not_future',
  'not_past',
  'min_date',
  'max_date',
  'min_age',
  'max_age',
  'min_time',
  'max_time',
  'min_choices',
  'max_choices',
  'different_from',
  'grading_scale',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export const CHECK_KINDS = ['REGEX', 'JS'] as const;
export const CUSTOM_CHECKS_MAX = 5;

/* The limit of a rule: a number; a date (YYYY-MM-DD) of min_date and max_date; a time (HH:MM) of min_time and max_time. */
export type Limit = number | string;
export interface Rule {
  type: RuleType;
  value?: Limit;
}
export interface CustomCheck {
  kind: (typeof CHECK_KINDS)[number];
  source: string;
  flags?: string;
  message_en: string;
  message_mr: string | null;
}
export interface FieldValidation {
  rules: Rule[];
  custom: CustomCheck[];
}

interface RuleDefinition {
  on: readonly FieldType[];
  /* What is wrong with the rule's limit for a field of this type; absent = the rule has none. */
  limit?: (value: Limit | undefined, type: FieldType) => string | null;
  right(value: string, limit: Limit): boolean;
  message(label: string, limit: Limit): string;
  /* Checked against the other answers of the form (form.ts), not on the value alone. */
  across?: true;
}

const numberFrom =
  (min: number, max: (type: FieldType) => number, whole: (type: FieldType) => boolean) =>
  (value: Limit | undefined, type: FieldType): string | null => {
    if (typeof value !== 'number') return 'Enter a number';
    if (whole(type) && !Number.isInteger(value)) return 'Enter a whole number';
    return value < min || value > max(type) ? `Enter a number from ${min} to ${max(type)}` : null;
  };
const always = () => true;
const length = numberFrom(1, (type) => CUSTOM_VALUE_MAX[type], always);
const digits = numberFrom(1, () => 16, always);
const years = numberFrom(0, () => 120, always);
const decimals = numberFrom(0, () => 4, always);
/* Another field, by its key. */
const field = (value: Limit | undefined) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? null : 'Choose a field';
const choices = numberFrom(1, () => 100, always);
const year = numberFrom(YEARS.MIN, () => YEARS.MAX, always);
const anyNumber = numberFrom(
  -1e12,
  () => 1e12,
  () => false,
);
const amount = (value: Limit | undefined, type: FieldType) => (type === 'YEAR' ? year : anyNumber)(value, type);
const date = (value: Limit | undefined) => (typeof value === 'string' && isDate(value) ? null : 'Choose a date');
const time = (value: Limit | undefined) =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? null : 'Choose a time';

const TEXTS: readonly FieldType[] = ['TEXT', 'TEXTAREA'];
const AMOUNTS: readonly FieldType[] = ['NUMBER', 'YEAR'];
const DAYS: readonly FieldType[] = ['DATE', 'MONTH', 'YEAR'];
const format = (on: readonly FieldType[], right: (v: string) => boolean, message: string): RuleDefinition => ({
  on,
  right,
  message: (label) => `${label} ${message}`,
});
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/* The digits of a number, without its sign and decimal point. */
const digitsIn = (v: string) => v.replace(/[^0-9]/g, '').length;
/* 2026-11-25 → 25/11/2026 */
const readable = (d: Limit) => String(d).split('-').reverse().join('/');
/* Today, as a date, a month or a year: dates are compared as text. */
const now = (like: string) => today().slice(0, like.length);

export const RULES: Record<RuleType, RuleDefinition> = {
  letters: format(TEXTS, (v) => /^[\p{L}\p{M} .'’-]+$/u.test(v), 'may contain only letters and spaces'),
  digits: format(['TEXT'], (v) => /^[0-9]+$/.test(v), 'may contain only digits'),
  letters_digits: format(TEXTS, (v) => /^[\p{L}\p{M}\p{N} ]+$/u.test(v), 'may contain only letters, digits and spaces'),
  no_spaces: format(['TEXT'], (v) => !/\s/.test(v), 'cannot contain spaces'),
  uppercase: format(TEXTS, (v) => v === v.toUpperCase(), 'must be in capital letters'),
  pin_code: format(['TEXT'], (v) => /^[1-9]\d{5}$/.test(v), 'must be exactly 6 digits'),
  pan: format(['TEXT'], (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(v), 'must be a valid PAN, e.g. ABCDE1234F'),
  ifsc: format(['TEXT'], (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v), 'must be a valid IFSC code, e.g. SBIN0001234'),
  email: format(['TEXT'], (v) => v.length <= 254 && EMAIL_RE.test(v), 'must be a valid email address'),
  /* +91, a 0 and spaces in front are allowed. */
  indian_mobile: format(['TEXT'], (v) => MOBILE_RE.test(normaliseMobile(v)), 'must be a 10-digit Indian number starting 6–9'),
  /* Spaces and hyphens between the digits are allowed. */
  aadhaar: format(['TEXT'], (v) => isAadhaar(aadhaarDigits(v)), 'must be 12 digits with a valid checksum'),
  min_length: {
    on: TEXTS,
    limit: length,
    right: (v, n) => v.length >= Number(n),
    message: (l, n) => `${l} must be at least ${n} characters`,
  },
  max_length: {
    on: TEXTS,
    limit: length,
    right: (v, n) => v.length <= Number(n),
    message: (l, n) => `${l} must be at most ${n} characters`,
  },
  whole_number: format(['NUMBER'], (v) => /^-?\d+$/.test(v), 'must be a whole number'),
  min_digits: {
    on: ['NUMBER'],
    limit: digits,
    right: (v, n) => digitsIn(v) >= Number(n),
    message: (l, n) => `${l} must have at least ${n} digits`,
  },
  max_digits: {
    on: ['NUMBER'],
    limit: digits,
    right: (v, n) => digitsIn(v) <= Number(n),
    message: (l, n) => `${l} must have at most ${n} digits`,
  },
  max_decimals: {
    on: ['NUMBER'],
    limit: decimals,
    right: (v, n) => (v.split('.')[1]?.length ?? 0) <= Number(n),
    message: (l, n) => (Number(n) === 0 ? `${l} must be a whole number` : `${l} must have at most ${n} decimal places`),
  },
  min_value: {
    on: AMOUNTS,
    limit: amount,
    right: (v, n) => Number(v) >= Number(n),
    message: (l, n) => `${l} must be at least ${n}`,
  },
  max_value: {
    on: AMOUNTS,
    limit: amount,
    right: (v, n) => Number(v) <= Number(n),
    message: (l, n) => `${l} must be at most ${n}`,
  },
  not_future: format(DAYS, (v) => v <= now(v), 'cannot be in the future'),
  not_past: format(DAYS, (v) => v >= now(v), 'cannot be in the past'),
  min_date: {
    on: ['DATE'],
    limit: date,
    right: (v, d) => v >= String(d),
    message: (l, d) => `${l} must be on or after ${readable(d)}`,
  },
  max_date: {
    on: ['DATE'],
    limit: date,
    right: (v, d) => v <= String(d),
    message: (l, d) => `${l} must be on or before ${readable(d)}`,
  },
  min_age: {
    on: ['DATE'],
    limit: years,
    right: (v, n) => ageOn(v, today()) >= Number(n),
    message: (l, n) => `${l}: age must be at least ${n} years`,
  },
  max_age: {
    on: ['DATE'],
    limit: years,
    right: (v, n) => ageOn(v, today()) <= Number(n),
    message: (l, n) => `${l}: age must be at most ${n} years`,
  },
  min_time: {
    on: ['TIME'],
    limit: time,
    right: (v, t) => v >= String(t),
    message: (l, t) => `${l} must be ${t} or later`,
  },
  max_time: {
    on: ['TIME'],
    limit: time,
    right: (v, t) => v <= String(t),
    message: (l, t) => `${l} must be ${t} or earlier`,
  },
  min_choices: {
    on: ['CHECKBOXES'],
    limit: choices,
    right: (v, n) => (chosen(v)?.length ?? 0) >= Number(n),
    message: (l, n) => `${l}: choose at least ${n}`,
  },
  max_choices: {
    on: ['CHECKBOXES'],
    limit: choices,
    right: (v, n) => (chosen(v)?.length ?? 0) <= Number(n),
    message: (l, n) => `${l}: choose at most ${n}`,
  },
  /* Not the same as the answer of another field (its key); the message names that field by its label (form.ts). */
  different_from: {
    on: ['TEXT', 'TEXTAREA', 'EMAIL', 'MOBILE', 'NUMBER', 'URL'],
    limit: field,
    right: () => true,
    message: (l, other) => `${l} must be different from ${other}`,
    across: true,
  },
  /* A score within its grading: a percentage 0–100, a CGPA 0–its scale (form.ts). */
  grading_scale: {
    on: ['NUMBER'],
    right: () => true,
    message: (l) => `${l} must be within its grading`,
    across: true,
  },
};
/* A minimum and its maximum. */
export const PAIRS: [min: RuleType, max: RuleType][] = [
  ['min_length', 'max_length'],
  ['min_digits', 'max_digits'],
  ['min_value', 'max_value'],
  ['min_date', 'max_date'],
  ['min_age', 'max_age'],
  ['min_time', 'max_time'],
  ['min_choices', 'max_choices'],
];

/* A rule of a field (null = it has none of this type). */
export const ruleOf = (v: FieldValidation | null | undefined, type: RuleType): Rule | null =>
  v?.rules.find((r) => r.type === type) ?? null;

/* The rules of a field that fit its type, in the order they are checked. */
export const rulesFor = (type: FieldType, rules: Rule[]): Rule[] =>
  RULE_TYPES.flatMap((t) => rules.find((r) => r.type === t) ?? []).filter((r) => RULES[r.type].on.includes(type));

/* A form as a function sees it: the other answers, never the Aadhaar number. */
const visible = (form: Form): Form => Object.fromEntries(Object.entries(form).filter(([k]) => k !== 'aadhaar_number'));

async function customIssue(check: CustomCheck, label: string, key: string, value: string, form: Form): Promise<string | null> {
  const failed = (reason: string) => {
    logger.error({ field: key, kind: check.kind, reason }, 'a field check could not be run');
    return `${label} could not be checked. Please contact the programme office.`;
  };
  if (check.kind === 'REGEX') {
    const r = await matches(check.source, check.flags ?? '', value);
    if (!r.ok) return failed(r.slow ? 'too slow' : 'failed');
    return r.value ? null : check.message_en;
  }
  const r = await answer(check.source, value, visible(form));
  if (!r.ok) return failed(r.slow ? 'too slow' : 'failed');
  if (r.value === true || r.value === '') return null;
  return typeof r.value === 'string' ? r.value.slice(0, 200) : check.message_en;
}

/* What is wrong with a given value, by the field's checks: the first broken one; null = nothing. */
export async function validationIssue(
  field: { key: string; labelEn: string; type: FieldType; validation: FieldValidation | null },
  value: string,
  form: Form,
): Promise<string | null> {
  const { validation, labelEn: label } = field;
  if (!validation) return null;
  for (const r of rulesFor(field.type, validation.rules)) {
    const rule = RULES[r.type];
    if (!rule.across && !rule.right(value, r.value ?? 0)) return rule.message(label, r.value ?? 0);
  }
  for (const c of validation.custom) {
    const issue = await customIssue(c, label, field.key, value, form);
    if (issue) return issue;
  }
  return null;
}

/* The checks as the portal's form gets them: a function stays on the server, only its messages go out. */
export const publicValidation = (v: FieldValidation | null) =>
  v && {
    rules: v.rules,
    custom: v.custom.map(({ kind, source, flags, message_en, message_mr }) =>
      kind === 'REGEX' ? { kind, source, flags: flags ?? '', message_en, message_mr } : { kind, message_en, message_mr },
    ),
  };
