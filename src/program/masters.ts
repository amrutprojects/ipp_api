import { pool, rows, type Db } from '../db/pool';
import { byType } from './built-in';
import {
  FIELD_KIND,
  fieldOptionKind,
  isLinkedKind,
  MARATHI_KINDS,
  type DocumentKind,
  type FieldType,
  type Step,
} from './constants';
import { hasChoices } from './field-types';
import type { FieldValidation } from './validation';

/*
 * The program's masters as they are now: the choices of every dropdown, the form's fields and its documents, loaded once
 * per request. Switched-off and deleted choices are loaded too, so a value a form already holds still shows its name; so are
 * the program's own fields that were deleted (as switched off), whose answers forms keep. A deleted own field is left out.
 */
export interface ProgramOption {
  id: string;
  kind: string;
  code: string;
  nameEn: string;
  nameMr: string | null;
  displayOrder: number;
  isActive: boolean;
  isDeleted: boolean;
  isSystem: boolean;
}

export interface ProgramField {
  id: string;
  key: string;
  step: Step;
  labelEn: string;
  labelMr: string | null;
  required: boolean;
  isActive: boolean;
  displayOrder: number;
  isCustom: boolean;
  type: FieldType;
  helpEn: string | null;
  helpMr: string | null;
  /* The checks an ADMIN gave it; null = none. */
  validation: FieldValidation | null;
  /* Deleted in Masters → Form fields: one of the program's own is kept here as a switched-off field (its answers still show). */
  isDeleted: boolean;
}

export interface ProgramDocument {
  id: string;
  code: string;
  nameEn: string;
  nameMr: string | null;
  required: boolean;
  isActive: boolean;
  isDeleted: boolean;
  isSystem: boolean;
  displayOrder: number;
  kind: DocumentKind;
}

/* What a form stores for a choice, and how people read it. */
export const optionValue = (o: Pick<ProgramOption, 'kind' | 'id' | 'code'>) => (isLinkedKind(o.kind) ? o.id : o.code);
export const shownName = (o: Pick<ProgramOption, 'kind' | 'nameEn' | 'nameMr'>) =>
  MARATHI_KINDS.includes(o.kind) ? (o.nameMr ?? o.nameEn) : o.nameEn;

/* The kind of a field's choices; null = it has none (or a list of its own: District, Center Name, Yes / No). */
export const optionsKind = (f: Pick<ProgramField, 'key' | 'type' | 'isCustom'>): string | null => {
  if (byType(f)) return hasChoices(f.type) ? fieldOptionKind(f.key) : null;
  return FIELD_KIND[f.key] ?? null;
};

export class Program {
  private readonly byKey: Map<string, ProgramField>;
  private readonly byCode: Map<string, ProgramDocument>;

  constructor(
    /* In the form's order, deleted ones left out. */
    readonly fields: ProgramField[],
    private readonly allOptions: ProgramOption[],
    private readonly allDocuments: ProgramDocument[],
    /* The technologies chosen per district (active choices only). */
    private readonly districtCodes: Map<string, string[]>,
  ) {
    this.byKey = new Map(fields.map((f) => [f.key, f]));
    this.byCode = new Map(allDocuments.map((d) => [d.code, d]));
  }

  field(key: string): ProgramField | null {
    return this.byKey.get(key) ?? null;
  }
  activeFields(step?: Step): ProgramField[] {
    return this.fields.filter((f) => f.isActive && !f.isDeleted && (!step || f.step === step));
  }
  /* The fields of Masters → Form fields: every one that is not deleted. */
  listedFields(): ProgramField[] {
    return this.fields.filter((f) => !f.isDeleted);
  }
  /* Whether no form can be without a value of it now. */
  requires(key: string): boolean {
    const f = this.byKey.get(key);
    return !!f?.isActive && !f.isDeleted && f.required;
  }
  /* A field's current label. */
  label(key: string): string {
    return this.byKey.get(key)?.labelEn ?? key;
  }

  /* The choices offered now, in order. */
  options(kind: string): ProgramOption[] {
    return this.allOptions.filter((o) => o.kind === kind && o.isActive);
  }
  /* Every choice of a kind that is not deleted (also switched-off ones). */
  allOf(kind: string): ProgramOption[] {
    return this.allOptions.filter((o) => o.kind === kind && !o.isDeleted);
  }
  /* The choice a stored value stands for, also when it is switched off or deleted. */
  option(kind: string, value: string): ProgramOption | null {
    const same = this.allOptions.filter((o) => o.kind === kind && optionValue(o) === value);
    return same.find((o) => !o.isDeleted) ?? same[0] ?? null;
  }
  /* A stored value as people read it (null = no choice of this kind has it). */
  optionName(kind: string, value: string): string | null {
    const o = this.option(kind, value);
    return o ? shownName(o) : null;
  }
  /* Every kind with choices to offer: the fixed ones and those of the active fields with choices of their own. */
  kinds(): string[] {
    return [...new Set([...Object.values(FIELD_KIND), ...this.activeFields().flatMap((f) => optionsKind(f) ?? [])])];
  }

  /*
   * The technologies offered to a student of a district: the ones chosen for it, else every active one (also when none of
   * the chosen ones is active any more).
   */
  technologies(districtId: string | null | undefined): ProgramOption[] {
    const all = this.options('TECHNOLOGY');
    const chosen = districtId ? this.districtCodes.get(districtId) : undefined;
    return chosen?.length ? all.filter((o) => chosen.includes(o.code)) : all;
  }
  /* Districts with a choice of technologies: their codes, in order. */
  districtTechnologies(): Record<string, string[]> {
    const order = this.options('TECHNOLOGY').map((o) => o.code);
    return Object.fromEntries([...this.districtCodes].map(([id, codes]) => [id, order.filter((c) => codes.includes(c))]));
  }

  /* The documents asked for now, in order. */
  documents(): ProgramDocument[] {
    return this.allDocuments.filter((d) => d.isActive);
  }
  /* Any document of the program by its code, also one switched off or deleted (null = not a document of the program). */
  document(code: string): ProgramDocument | null {
    return this.byCode.get(code.toUpperCase()) ?? null;
  }
  documentName(code: string): string {
    return this.document(code)?.nameEn ?? code;
  }
  /* The place of each document in a list: the ones asked for now, then the others. */
  documentOrder(): Map<string, number> {
    const active = this.documents();
    return new Map([...active, ...this.allDocuments.filter((d) => !active.includes(d))].map((d, i) => [d.code, i]));
  }
}

export async function loadProgram(db: Db = pool): Promise<Program> {
  const fields = () =>
    rows<ProgramField>(
      `SELECT id, key, step, type, label_en AS "labelEn", label_mr AS "labelMr", required, is_active AS "isActive",
              display_order AS "displayOrder", is_custom AS "isCustom", help_en AS "helpEn", help_mr AS "helpMr", validation,
              (deleted_at IS NOT NULL) AS "isDeleted"
       FROM program_fields WHERE deleted_at IS NULL OR NOT is_custom ORDER BY step, display_order, created_at, key`,
      [],
      db,
    );
  const options = () =>
    rows<ProgramOption>(
      `SELECT id, kind, code, name_en AS "nameEn", name_mr AS "nameMr", display_order AS "displayOrder", is_active AS "isActive",
              (deleted_at IS NOT NULL) AS "isDeleted", is_system AS "isSystem"
       FROM program_options ORDER BY display_order, (deleted_at IS NOT NULL), updated_at DESC, code`,
      [],
      db,
    );
  const documents = () =>
    rows<ProgramDocument>(
      `SELECT id, code, name_en AS "nameEn", name_mr AS "nameMr", required, kind, is_active AS "isActive",
              (deleted_at IS NOT NULL) AS "isDeleted", is_system AS "isSystem", display_order AS "displayOrder"
       FROM program_documents ORDER BY display_order, created_at, code`,
      [],
      db,
    );
  const chosen = () =>
    rows<{ district_id: string; code: string }>(
      `SELECT t.district_id, o.code FROM district_technologies t
       JOIN program_options o ON o.id = t.option_id AND o.is_active AND o.kind = 'TECHNOLOGY'`,
      [],
      db,
    );
  /* In a transaction one after the other (one connection), otherwise together. */
  const [f, o, d, c] =
    db === pool
      ? await Promise.all([fields(), options(), documents(), chosen()])
      : [await fields(), await options(), await documents(), await chosen()];
  const districtCodes = new Map<string, string[]>();
  for (const row of c) districtCodes.set(row.district_id, [...(districtCodes.get(row.district_id) ?? []), row.code]);
  return new Program(f, o, d, districtCodes);
}
