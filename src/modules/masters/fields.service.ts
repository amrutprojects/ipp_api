import { one, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { byType, typesOf } from '../../program/built-in';
import { CUSTOM_KEY_PREFIX, CUSTOM_SLUG_MAX, fieldOptionKind, ORDER_MAX } from '../../program/constants';
import { typeIssue } from '../../program/field-types';
import { optionsKind, type ProgramField } from '../../program/masters';
import { validationIssue } from '../../program/validation';
import { lock, orConflict, record, type By } from './common.service';
import { NO_CHOICES, NO_CHOICES_HERE, type NewFieldBody, type TestValidationBody, type UpdateFieldBody } from './fields.schemas';
import { checkedValidation, keptFor, stored, type FieldsAround } from './validation.service';
import { addChoices } from './options.service';

/*
 * The form's fields. Every one can be changed in everything: its labels, help texts, order, step, type, checks, and whether it
 * is required and asked at all. Only the types of some of the program's own are limited (built-in.ts: typesOf). Every field
 * can be deleted and brought back: the answers already given stay stored with their forms.
 */
const NOT_THIS_TYPE = 'This field cannot have this type';
const CHOICES_ELSEWHERE = 'The choices of this field are a list of their own: change them there.';

const fieldDto = (f: ListedField) => ({
  id: f.id,
  key: f.key,
  step: f.step,
  label_en: f.labelEn,
  label_mr: f.labelMr,
  required: f.required,
  is_active: f.isActive,
  order: f.displayOrder,
  custom: f.isCustom,
  by_type: byType(f),
  type: f.type,
  types: typesOf(f),
  options_kind: optionsKind(f),
  help_en: f.helpEn,
  help_mr: f.helpMr,
  validation: f.validation,
  created_at: f.createdAt,
  updated_at: f.updatedAt,
  deleted_at: f.deletedAt,
});

type ListedField = ProgramField & { createdAt: string; updatedAt: string; deletedAt: string | null };
const COLUMNS = `id, key, step, type, label_en AS "labelEn", label_mr AS "labelMr", required, is_active AS "isActive",
  display_order AS "displayOrder", is_custom AS "isCustom", help_en AS "helpEn", help_mr AS "helpMr", validation,
  (deleted_at IS NOT NULL) AS "isDeleted", created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"`;

/* The fields of Masters → Form fields (deleted = the ones that were deleted, to bring back), in the form's order. */
const fieldRows = (deleted: boolean, db?: Db) =>
  rows<ListedField>(
    `SELECT ${COLUMNS} FROM program_fields WHERE (deleted_at IS NOT NULL) = $1 ORDER BY step, display_order, created_at, key`,
    [deleted],
    db,
  );

/* The keys a check may name ("different from"): the fields that are not deleted. */
const aroundOf = async (db: Db, self: string | null): Promise<FieldsAround> => ({
  keys: (await fieldRows(false, db)).map((f) => f.key),
  self,
});

/* A field (a deleted one only when asked for), locked until the transaction ends. */
async function getField(db: Db, id: string, deleted = false): Promise<ListedField> {
  const row = await one<ListedField>(
    `SELECT ${COLUMNS} FROM program_fields WHERE id = $1 AND (deleted_at IS NOT NULL) = $2 FOR UPDATE`,
    [id, deleted],
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
  list: async () => (await fieldRows(false)).map(fieldDto),
  /* The deleted ones, to bring back. */
  deleted: async () => (await fieldRows(true)).map(fieldDto),

  async create(who: By, body: NewFieldBody) {
    return transaction(async (db) => {
      const validation = await checkedValidation(body.type, body.validation ?? null, await aroundOf(db, null));
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
        const type = body.type ?? before.type;
        if (type !== before.type && !typesOf(before).includes(type))
          throw AppError.validation([{ field: 'body.type', message: NOT_THIS_TYPE }]);
        /* Whose choices it will have: its own, a list of the Masters, or none. */
        const kind = optionsKind({ ...before, type });
        const ownChoices = kind === fieldOptionKind(before.key);
        if (body.options?.length && !ownChoices)
          throw AppError.validation([{ field: 'body.options', message: kind ? CHOICES_ELSEWHERE : NO_CHOICES_HERE }]);
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
              body.validation === undefined
                ? keptFor(type, before.validation)
                : await checkedValidation(type, body.validation, await aroundOf(db, before.key)),
            ),
          ],
        );
        if (body.options?.length) await addChoices(db, before.key, body.options);
        /* It becomes a field with choices: with the ones sent, or the ones it had before. */
        if (type !== before.type && ownChoices) {
          const choice = await one('SELECT 1 FROM program_options WHERE kind = $1 AND deleted_at IS NULL LIMIT 1', [kind], db);
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

  /*
   * Any field: it is no longer asked, and leaves the list for "Deleted fields", from where it can be brought back. The values
   * forms already hold stay stored (and shown, as of a switched-off field).
   */
  remove(who: By, id: string) {
    return transaction(async (db) => {
      const field = await getField(db, id);
      await db.query('UPDATE program_fields SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.field.delete', 'program_fields', id, { key: field.key });
    });
  },

  /* A deleted field back in the list, switched off: it is asked again once it is switched on. */
  restore(who: By, id: string) {
    return transaction(async (db) => {
      await lock(db, 'program-fields');
      const field = await getField(db, id, true);
      await db.query('UPDATE program_fields SET deleted_at = NULL, is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.field.restore', 'program_fields', id, { key: field.key });
      return fieldDto(await getField(db, id));
    });
  },
};
