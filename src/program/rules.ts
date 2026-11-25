import { z } from 'zod';
import { verhoeffValid } from '../lib/aadhaar';
import { ageOn, today } from '../lib/dates';
import { isDate, MOBILE_RE, NAME_RE, normaliseMobile } from '../lib/text';

/*
 * The format and range of each form field the program itself knows, applied to a value that is given (blank values, choices
 * and the rules across fields: form.ts). `label` is the name the messages use; the field's current label replaces it. The
 * messages are the ones the portal knows and translates.
 */
export interface FieldRule {
  label: string;
  schema: z.ZodTypeAny;
}

const rule = (label: string, schema: (label: string) => z.ZodTypeAny): FieldRule => ({ label, schema: schema(label) });
const maxText = (label: string, max: number) => z.string().trim().max(max, `${label} must be at most ${max} characters`);
const text = (max: number) => (label: string) => maxText(label, max);
const matches = (re: RegExp, message: (label: string) => string) => (label: string) =>
  z.string().trim().regex(re, message(label));
const person = (max: number) => (label: string) =>
  maxText(label, max).refine((v) => NAME_RE.test(v), `${label} may contain only letters, spaces and . ' -`);
const mobile = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => MOBILE_RE.test(normaliseMobile(v)), `${label} must be a 10-digit Indian number starting 6–9`);

/* The date of birth of someone aged 14 to 100. */
const dateOfBirth = (label: string) =>
  z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return issue(`${label} must be in YYYY-MM-DD format`);
      if (!isDate(v)) return issue(`${label} is not a real date`);
      const day = today();
      if (v > day) return issue(`${label} cannot be in the future`);
      const age = ageOn(v, day);
      if (age < 14 || age > 100) issue('Applicant must be between 14 and 100 years old');
    });

/* A date from 1940 until today. */
const pastDate = (label: string) =>
  z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return issue(`${label} must be in YYYY-MM-DD format`);
      if (!isDate(v)) return issue(`${label} is not a real date`);
      if (v < '1940-01-01') return issue(`${label} is too far in the past`);
      if (v > today()) issue(`${label} cannot be in the future`);
    });

/* 12 digits (spaces and hyphens allowed), not starting 0 or 1, with a valid check digit. */
export const aadhaarDigits = (v: string) => v.replace(/[\s-]/g, '');
export const isAadhaar = (digits: string) => /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
const aadhaar = (label: string) =>
  maxText(label, 20).refine((v) => isAadhaar(aadhaarDigits(v)), `${label} must be 12 digits with a valid checksum`);

export const FIELD_RULES: Record<string, FieldRule> = {
  first_name: rule('First name', person(100)),
  last_name: rule('Last name', person(100)),
  father_name: rule('Father name', person(150)),
  mother_name: rule('Mother name', person(150)),
  email: rule('Email', (l) => maxText(l, 254).email('Email address is not valid')),
  date_of_birth: rule('Date of birth', dateOfBirth),
  current_address: rule('Current address', text(500)),
  aadhaar_number: rule('Aadhaar number', aadhaar),
  mobile_number: rule('Mobile number', mobile),
  permanent_address: rule('Permanent address', text(500)),
  landmark: rule('Landmark', text(150)),
  /* Typed, not selected: not checked against the Taluka master. */
  taluka: rule('Taluka', text(100)),
  pin_code: rule(
    'PIN code',
    matches(/^[1-9]\d{5}$/, (l) => `${l} must be exactly 6 digits`),
  ),
  alternate_mobile_number: rule('Alternate mobile number', mobile),
  alternate_email: rule('Alternate email', (l) => maxText(l, 254).email(`${l} must be a valid email address`)),
  disability_type: rule('Disability type', text(100)),
  disability_certificate_number: rule(
    'Disability certificate number',
    matches(/^[A-Za-z0-9/-]{4,50}$/, (l) => `${l} may contain only letters, digits, / and - (4–50 characters)`),
  ),
  qualification_name: rule('Name of qualification', text(150)),
  qualification_stream: rule('Subject / stream / branch', text(150)),
  qualification_board: rule('College name', text(200)),
  qualification_completed_on: rule('Date of qualification completion', pastDate),
  score: rule(
    'Percentage / CGPA',
    matches(/^\d{1,3}(\.\d{1,2})?$/, () => 'Enter a number with at most 2 decimal places'),
  ),
};
