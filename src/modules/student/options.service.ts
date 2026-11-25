import { rows } from '../../db/pool';
import { fileRule } from '../../lib/file-type';
import { byType } from '../../program/built-in';
import {
  loadProgram,
  optionsKind,
  optionValue,
  shownName,
  type ProgramDocument,
  type ProgramOption,
} from '../../program/masters';
import { publicValidation } from '../../program/validation';
import { helpForStudents, supportForStudents, welcomeForStudents } from '../../program/settings';

const documentType = (d: ProgramDocument) => {
  const { formats, maxMb } = fileRule(d.kind === 'VIDEO');
  return {
    id: d.id,
    code: d.code,
    name: d.nameEn,
    name_mr: d.nameMr,
    is_mandatory: d.required,
    kind: d.kind,
    formats,
    max_mb: maxMb,
  };
};

/* A choice of a dropdown: what the form stores, and its names. */
const choice = (o: ProgramOption) => ({ value: optionValue(o), name_en: o.nameEn, name_mr: o.nameMr });
const ref = (o: ProgramOption) => ({ id: o.id, code: o.code, name: shownName(o) });
const coded = (o: ProgramOption) => ({ code: o.code, name: o.nameEn, name_mr: o.nameMr });

/*
 * What the portal's form is made of, as the masters are now: the active fields, the choices of every dropdown, districts,
 * centers, technologies per district and documents; and the texts the panel edits (support, welcome, help).
 */
export async function options() {
  const [program, districts, centres, support, welcome, help] = await Promise.all([
    loadProgram(),
    rows<{ id: string; name: string; code: string }>(
      `SELECT id, name, code FROM districts WHERE is_active ORDER BY lower(name), id`,
    ),
    rows<{ id: string; name: string; code: string; district_name: string }>(
      `SELECT c.id, c.name, c.code, d.name AS district_name FROM centres c JOIN districts d ON d.id = c.district_id
       WHERE c.is_active ORDER BY lower(c.name), c.id`,
    ),
    supportForStudents(),
    welcomeForStudents(),
    helpForStudents(),
  ]);
  const list = (kind: string) => program.options(kind);
  const codes = (kind: string) => list(kind).map((o) => o.code);
  const technologies = list('TECHNOLOGY').map(({ code, nameEn }) => ({ code, name: nameEn }));
  return {
    fields: program.activeFields().map((f) => ({
      key: f.key,
      step: f.step,
      label_en: f.labelEn,
      label_mr: f.labelMr ?? f.labelEn,
      required: f.required,
      type: f.type,
      custom: f.isCustom,
      by_type: byType(f),
      order: f.displayOrder,
      options_kind: optionsKind(f),
      help_en: f.helpEn,
      help_mr: f.helpMr,
      validation: publicValidation(f.validation),
    })),
    lists: Object.fromEntries(program.kinds().map((kind) => [kind, list(kind).map(choice)])),
    districts,
    centres,
    district_technologies: program.districtTechnologies(),
    document_types: program.documents().map(documentType),
    support,
    welcome,
    help,
    /* The same choices one list at a time, as the portal's type of this answer has them. */
    regions: list('REGION').map(ref),
    castes: list('CASTE').map(ref),
    educations: list('EDUCATION').map(ref),
    religions: codes('RELIGION'),
    tracks: technologies,
    technologies,
    genders: codes('GENDER'),
    marital_statuses: codes('MARITAL_STATUS'),
    educational_statuses: list('EDUCATIONAL_STATUS').map(coded),
    grading_types: list('GRADING_TYPE').map(coded),
    cgpa_scales: codes('CGPA_SCALE').map(Number),
    qualification_classes: codes('QUALIFICATION_CLASS'),
  };
}
