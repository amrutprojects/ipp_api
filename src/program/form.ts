import { one, pool, type Db } from '../db/pool';
import type { FieldError } from '../http/errors';
import { maskAadhaar } from '../lib/aadhaar';
import { normaliseMobile } from '../lib/text';
import { byType } from './built-in';
import { isLinkedKind, YES_NO, type Form, type Step } from './constants';
import { chosen, hasChoices, isBlank, missingText, typeIssue } from './field-types';
import { optionsKind, optionValue, type Program, type ProgramField } from './masters';
import { aadhaarDigits, FIELD_RULES } from './rules';
import { validationIssue } from './validation';

/*
 * The form checked and shown by the program's masters: which fields there are, whether each is required, what its choices
 * are and what it is called now. The formats and ranges of the program's own fields' values: rules.ts.
 */

/* A field shown only in some cases: the disability details of a person with a disability, the scale of a CGPA. */
const DISABILITY_DETAILS: readonly string[] = ['disability_type', 'disability_certificate_number'];
function applies(key: string, value: (key: string) => string): boolean {
  if (DISABILITY_DETAILS.includes(key)) return value('disability_status') === 'Yes';
  if (key === 'cgpa_scale') return value('grading_type') === 'CGPA';
  return true;
}

export interface CheckOptions {
  /* Only the fields of this step (default: both); rules across fields still read the whole form. */
  step?: Step;
  /* The form as stored: a value it already holds and that is no longer offered is accepted (the Auditor's edit). */
  stored?: Form;
  db?: Db;
}

/*
 * Checks a step, or the whole form, against the active fields: switched-off fields are left out, a blank required field is
 * an error, a blank optional one is not checked further, and a filled one must have the right format, be one of the active
 * choices, and fit the other fields. `values` are the checked values (a field that does not apply is blank).
 */
export async function checkForm(
  program: Program,
  form: Form,
  opts: CheckOptions = {},
): Promise<{ values: Form; errors: FieldError[] }> {
  const values: Form = {};
  const errors: FieldError[] = [];
  const issue = (key: string, message: string) => errors.push({ field: `body.${key}`, message });
  const unchanged = (key: string, v: string) => !!opts.stored && (opts.stored[key]?.trim() ?? '') === v;
  /* A field's value; a switched-off field has none. */
  const value = (key: string) => (program.field(key)?.isActive ? (form[key] ?? '').trim() : '');

  const refs = (await one<{ district: boolean; centre: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM districts WHERE id = uuid_or_null($1) AND is_active) AS district,
            EXISTS (SELECT 1 FROM centres WHERE id = uuid_or_null($2) AND is_active) AS centre`,
    [value('district_id'), value('centre_id')],
    opts.db ?? pool,
  ))!;

  const choiceIssue = (f: ProgramField, v: string): string | null => {
    const { key, labelEn: label } = f;
    if (key === 'district_id') return refs.district || unchanged(key, v) ? null : `${label} not found or inactive`;
    if (key === 'centre_id') return refs.centre || unchanged(key, v) ? null : `${label} not found or inactive`;
    if (key === 'disability_status') return (YES_NO as readonly string[]).includes(v) ? null : `Select a valid ${label}`;
    const kind = optionsKind(f);
    if (!kind) return null;
    if (f.type === 'CHECKBOXES') {
      const before = opts.stored ? (chosen(opts.stored[key] ?? '') ?? []) : [];
      const offered = (o: string) => program.options(kind).some((x) => optionValue(x) === o) || before.includes(o);
      return chosen(v)!.every(offered) ? null : `Select valid choices for ${label}`;
    }
    /* A technology depends on the district: it stays as it is only while the district does. */
    const stays = unchanged(key, v) && (key !== 'technology' || unchanged('district_id', value('district_id')));
    if (stays && program.option(kind, v)) return null;
    if (!program.options(kind).some((o) => optionValue(o) === v))
      return isLinkedKind(kind) ? `${label} not found or inactive` : `Select a valid ${label}`;
    if (key === 'technology' && !program.technologies(value('district_id')).some((o) => o.code === v))
      return `${label} is not offered in the selected district`;
    return null;
  };

  /*
   * What the field itself says of a value: its type (an own field, or one given another type), its choices, else the
   * program's format for it. `value` = as it is kept.
   */
  const checked = (f: ProgramField, v: string): { value: string; wrong: string[] } => {
    const answer = (wrong: string | null) => ({ value: v, wrong: wrong ? [wrong] : [] });
    if (byType(f)) return answer(typeIssue(f, v) ?? choiceIssue(f, v));
    if (hasChoices(f.type)) return answer(choiceIssue(f, v));
    const rule = FIELD_RULES[f.key];
    const parsed = rule?.schema.safeParse(v);
    if (!parsed) return answer(null);
    if (parsed.success) return { value: String(parsed.data ?? ''), wrong: [] };
    /* The rule's own name of the field gives way to the current label. */
    const named = (m: string) => (m.startsWith(rule!.label) ? f.labelEn + m.slice(rule!.label.length) : m);
    return { value: v, wrong: parsed.error.issues.map((i) => named(i.message)) };
  };

  for (const f of program.activeFields(opts.step)) {
    const v = value(f.key);
    if (!applies(f.key, value)) {
      values[f.key] = '';
      continue;
    }
    if (isBlank(f.type, v)) {
      if (f.required) issue(f.key, missingText(f));
      else values[f.key] = '';
      continue;
    }
    const { value: kept, wrong } = checked(f, v);
    /* Then the checks an ADMIN gave it. An unchanged stored value stays accepted. */
    if (!wrong.length && !unchanged(f.key, v)) {
      const broken = await validationIssue(f, f.key === 'aadhaar_number' ? aadhaarDigits(kept) : kept, form);
      if (broken) wrong.push(broken);
    }
    for (const message of wrong) issue(f.key, message);
    if (!wrong.length) values[f.key] = kept;
  }

  /* Rules across fields: only for values that are right on their own. */
  const ok = (key: string) => values[key] || '';
  const alternate = ok('alternate_mobile_number');
  if (alternate && normaliseMobile(alternate) === normaliseMobile(value('mobile_number')))
    issue(
      'alternate_mobile_number',
      `${program.label('alternate_mobile_number')} must be different from ${program.label('mobile_number')}`,
    );
  const alternateEmail = ok('alternate_email');
  if (alternateEmail && alternateEmail.toLowerCase() === value('email').toLowerCase())
    issue('alternate_email', `${program.label('alternate_email')} must be different from ${program.label('email')}`);
  const score = ok('score');
  const scoreField = program.field('score');
  if (score && scoreField && !byType(scoreField)) {
    /* 0–100; a CGPA 0–its scale (the largest one while no scale is asked for; a missing one is reported on its own). */
    const grading = value('grading_type');
    const asked = program.field('cgpa_scale');
    const given = Number(value('cgpa_scale'));
    const largest = Math.max(0, ...program.options('CGPA_SCALE').map((o) => Number(o.code)));
    let limit = 100;
    if (grading === 'CGPA' && given) limit = given;
    else if (grading === 'CGPA' && !(asked?.isActive && asked.required)) limit = largest || 100;
    if (Number(score) > limit) {
      const label = program.label('score');
      issue(
        'score',
        `${grading ? (program.optionName('GRADING_TYPE', grading) ?? label) : label} must be between 0 and ${limit}`,
      );
    }
  }
  return { values, errors };
}

/* Names of the form's references and choices, as they are now (also for one since switched off or deleted). */
export async function referenceNames(program: Program, form: Form, db: Db = pool) {
  const row = (await one<{ centre: string | null; district: string | null }>(
    `SELECT (SELECT name FROM centres WHERE id = uuid_or_null($1)) AS centre,
            (SELECT name FROM districts WHERE id = uuid_or_null($2)) AS district`,
    [form.centre_id ?? '', form.district_id ?? ''],
    db,
  ))!;
  const choice = (key: string, kind: string) => (form[key] ? (program.optionName(kind, form[key]) ?? form[key]) : null);
  /* Typed, unless it was given choices of its own: shown as given. */
  const taluka = program.field('taluka');
  const talukaKind = taluka && optionsKind(taluka);
  return {
    caste: choice('caste_id', 'CASTE'),
    course_centre: choice('region_id', 'REGION'),
    education: choice('education_id', 'EDUCATION'),
    centre: row.centre,
    district: row.district,
    taluka: talukaKind ? choice('taluka', talukaKind) : form.taluka || null,
    religion: choice('religion', 'RELIGION'),
    technology: choice('technology', 'TECHNOLOGY'),
    gender: choice('gender', 'GENDER'),
    marital_status: choice('marital_status', 'MARITAL_STATUS'),
    educational_status: choice('educational_status', 'EDUCATIONAL_STATUS'),
    grading_type: choice('grading_type', 'GRADING_TYPE'),
    qualification_class: choice('qualification_class', 'QUALIFICATION_CLASS'),
  };
}
export type FormNames = Awaited<ReturnType<typeof referenceNames>>;

const NAMED: Record<string, keyof FormNames> = {
  caste_id: 'caste',
  region_id: 'course_centre',
  education_id: 'education',
  centre_id: 'centre',
  district_id: 'district',
  religion: 'religion',
  technology: 'technology',
  gender: 'gender',
  marital_status: 'marital_status',
  educational_status: 'educational_status',
  grading_type: 'grading_type',
  qualification_class: 'qualification_class',
};

/* A field's value as people read it: names for choices, dates as stored, the Aadhaar masked; '' when it has none. */
export function fieldText(program: Program, f: ProgramField, form: Form, names: FormNames, aadhaarMasked: string | null): string {
  if (f.key === 'aadhaar_number')
    return aadhaarMasked ?? (form.aadhaar_number ? (maskAadhaar(form.aadhaar_number.slice(-4)) ?? '') : '');
  const v = form[f.key] ?? '';
  if (!v) return '';
  const named = NAMED[f.key];
  if (named) return names[named] ?? v;
  const kind = optionsKind(f);
  if (kind && f.type === 'CHECKBOXES') return (chosen(v) ?? []).map((o) => program.optionName(kind, o) ?? o).join(', ');
  return (kind ? program.optionName(kind, v) : null) ?? v;
}

/* The form as every login shows it: every active field in order, and a switched-off one that has a value. */
export function viewFields(program: Program, form: Form, names: FormNames, aadhaarMasked: string | null) {
  return program.fields
    .map((f) => ({
      key: f.key,
      step: f.step,
      label_en: f.labelEn,
      label_mr: f.labelMr ?? f.labelEn,
      type: f.type,
      value: f.key === 'aadhaar_number' ? '' : (form[f.key] ?? ''),
      text: fieldText(program, f, form, names, aadhaarMasked),
      custom: f.isCustom,
      active: f.isActive,
    }))
    .filter((f) => f.active || f.text)
    .map(({ active: _active, ...f }) => f);
}
export type ViewField = ReturnType<typeof viewFields>[number];
