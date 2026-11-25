import { one, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { CUSTOM_KEY_PREFIX, CUSTOM_SLUG_MAX, fieldOptionKind, ORDER_MAX } from '../../program/constants';
import { hasChoices, typeIssue } from '../../program/field-types';
import { loadProgram, optionsKind, type ProgramField } from '../../program/masters';
import { validationIssue } from '../../program/validation';
import { lock, orConflict, record, type By } from './common.service';
import { NO_CHOICES, NO_CHOICES_HERE, type NewFieldBody, type TestValidationBody, type UpdateFieldBody } from './fields.schemas';
import { checkedValidation, keptFor, stored } from './validation.service';
import { addChoices } from './options.service';

/*
 * The form's fields. A core field is part of every form: only its labels, help texts and order change. The program's other
 * fields can also be made optional and switched off. The ones an ADMIN adds (key x_…) can be changed in everything and
 * deleted; the answers already given stay stored with their forms.
 */
const CORE_ONLY = 'This field is part of every form: only its labels, help text and order can be changed.';
const BUILT_IN_ONLY = 'Only the labels, help text, order, required and active of this field can be changed.';
const NOT_DELETABLE = 'This field is part of the form and cannot be deleted. Switch it off instead.';

const fieldDto = (f: ProgramField) => ({
  id: f.id,
  key: f.key,
  step: f.step,
  label_en: f.labelEn,
  label_mr: f.labelMr,
  required: f.required,
  is_active: f.isActive,
  order: f.displayOrder,
  core: f.isCore,
  custom: f.isCustom,
  type: f.type,
  options_kind: optionsKind(f),
  help_en: f.helpEn,
  help_mr: f.helpMr,
  validation: f.validation,
});

/* A field, locked until the transaction ends. */
async function getField(db: Db, id: string): Promise<ProgramField> {
  const row = await one<ProgramField>(
    `SELECT id, key, step, type, label_en AS "labelEn", label_mr AS "labelMr", required, is_active AS "isActive",
            display_order AS "displayOrder", is_core AS "isCore", is_custom AS "isCustom", help_en AS "helpEn", help_mr AS "helpMr", validation
     FROM program_fields WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
    db,
  );
  if (!row) throw AppError.notFound('Field not found');
  return row;
}

/* x_<label in a–z, 0–9 and _>, with a number when it was ever used (a deleted field's answers are stored under its key). */
async function newKey(db: Db, label: string): Promise<string> {
  const slug =
    label
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, CUSTOM_SLUG_MAX - 4)
      .replace(/_+$/, '') || 'field';
  for (let n = 1; ; n++) {
    const key = `${CUSTOM_KEY_PREFIX}${slug}${n > 1 ? `_${n}` : ''}`;
    if (!(await one('SELECT 1 FROM program_fields WHERE key = $1', [key], db))) return key;
  }
}

export const fieldsService = {
  list: async () => (await loadProgram()).fields.map(fieldDto),

  async create(who: By, body: NewFieldBody) {
    const validation = await checkedValidation(body.type, body.validation ?? null);
    return transaction(async (db) => {
      await lock(db, 'program-fields');
      const key = await newKey(db, body.label_en);
      const row = await one<{ id: string }>(
        `INSERT INTO program_fields (key, step, type, label_en, label_mr, help_en, help_mr, required, is_active, is_custom, display_order,
           validation)
         VALUES ($1, $2::smallint, $3, $4, $5, $6, $7, $8, $9, true, coalesce($10,
           (SELECT least(coalesce(max(display_order), 0) + 10, ${ORDER_MAX}) FROM program_fields
            WHERE step = $2::smallint AND deleted_at IS NULL)), $11::jsonb)
         RETURNING id`,
        [
          key,
          body.step,
          body.type,
          body.label_en,
          body.label_mr ?? null,
          body.help_en ?? null,
          body.help_mr ?? null,
          body.required ?? false,
          body.is_active ?? true,
          body.order ?? null,
          stored(validation),
        ],
        db,
      );
      await addChoices(db, key, body.options ?? []);
      await record(db, who, 'edp.field.create', 'program_fields', row!.id, {
        key,
        type: body.type,
        choices: body.options?.length ?? 0,
      });
      return fieldDto(await getField(db, row!.id));
    });
  },

  update(who: By, id: string, body: UpdateFieldBody) {
    return orConflict({ uq_program_options_name: 'A choice with this name is already in the list.' }, () =>
      transaction(async (db) => {
        const before = await getField(db, id);
        /* What else is sent may only repeat what is already there (a form that sends every value). */
        const differs = (key: 'required' | 'is_active' | 'step' | 'type') =>
          body[key] !== undefined &&
          body[key] !== { required: before.required, is_active: before.isActive, step: before.step, type: before.type }[key];
        const ownOnly = differs('step') || differs('type') || !!body.options || body.validation !== undefined;
        if (before.isCore && (differs('required') || differs('is_active') || ownOnly)) throw AppError.conflict(CORE_ONLY);
        if (!before.isCustom && ownOnly) throw AppError.conflict(BUILT_IN_ONLY);

        const type = body.type ?? before.type;
        if (body.options?.length && !hasChoices(type))
          throw AppError.validation([{ field: 'body.options', message: NO_CHOICES_HERE }]);
        await db.query(
          `UPDATE program_fields SET label_en = $2, label_mr = $3, help_en = $4, help_mr = $5, display_order = $6, required = $7,
             is_active = $8, step = $9, type = $10, validation = $11::jsonb WHERE id = $1`,
          [
            id,
            body.label_en ?? before.labelEn,
            body.label_mr === undefined ? before.labelMr : body.label_mr,
            body.help_en === undefined ? before.helpEn : body.help_en,
            body.help_mr === undefined ? before.helpMr : body.help_mr,
            body.order ?? before.displayOrder,
            body.required ?? before.required,
            body.is_active ?? before.isActive,
            body.step ?? before.step,
            type,
            stored(
              body.validation === undefined ? keptFor(type, before.validation) : await checkedValidation(type, body.validation),
            ),
          ],
        );
        if (body.options?.length) await addChoices(db, before.key, body.options);
        /* It becomes a field with choices: with the ones sent, or the ones it had before. */
        if (differs('type') && hasChoices(type)) {
          const choice = await one(
            'SELECT 1 FROM program_options WHERE kind = $1 AND deleted_at IS NULL LIMIT 1',
            [fieldOptionKind(before.key)],
            db,
          );
          if (!choice) throw AppError.validation([{ field: 'body.options', message: NO_CHOICES }]);
        }
        await record(db, who, 'edp.field.update', 'program_fields', id, { key: before.key, fields: Object.keys(body) });
        return fieldDto(await getField(db, id));
      }),
    );
  },

  /* What the checks say of a value, before they are saved. */
  async testValidation(body: TestValidationBody) {
    const validation = await checkedValidation(body.type, body.validation);
    const value = body.value.trim();
    const field = { key: 'x_test', labelEn: body.label_en, type: body.type, validation };
    const message = typeIssue(field, value) ?? (await validationIssue(field, value, { x_test: value }));
    return { valid: !message, messages: message ? [message] : [] };
  },

  /* Own fields only; the values forms already hold stay stored. */
  remove(who: By, id: string) {
    return transaction(async (db) => {
      const field = await getField(db, id);
      if (!field.isCustom) throw AppError.conflict(field.isCore ? CORE_ONLY : NOT_DELETABLE);
      await db.query('UPDATE program_fields SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.field.delete', 'program_fields', id, { key: field.key });
    });
  },
};
