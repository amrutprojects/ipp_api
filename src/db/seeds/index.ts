import { env } from '../../config/env';
import { hashPassword } from '../../lib/passwords';
import { one, transaction, type Db } from '../pool';
import { DISTRICTS, DOCUMENTS, FIELDS, OPTIONS, STATE } from './data';
import { DEFAULT_CHECKS } from '../../program/rules';

/*
 * Fills the masters of an empty database; safe to run again: a row is added only when there is none with its code or key
 * (deleted ones count too, so what the Auditor deleted or renamed is never brought back). The first panel ADMIN is made from
 * PANEL_ADMIN_EMAIL and PANEL_ADMIN_PASSWORD while there is no panel user at all.
 */
const place = (i: number) => (i + 1) * 10;
/* Their choices are renamed or switched on and off, never added or deleted: the score is checked by these codes. */
const SYSTEM_KINDS: readonly string[] = ['GRADING_TYPE'];

const add = async (db: Db, sql: string, params: unknown[]) => (await db.query(sql, params)).rowCount ?? 0;

async function geography(db: Db): Promise<number> {
  let n = await add(
    db,
    `INSERT INTO states (name, code) SELECT $1, $2::varchar WHERE NOT EXISTS (SELECT 1 FROM states WHERE code = $2)`,
    [STATE.name, STATE.code],
  );
  const state = await one<{ id: string }>(
    `SELECT id FROM states WHERE code = $1 ORDER BY deleted_at NULLS FIRST LIMIT 1`,
    [STATE.code],
    db,
  );
  for (const [code, name] of DISTRICTS)
    n += await add(
      db,
      `INSERT INTO districts (state_id, name, code) SELECT $1::uuid, $2::varchar, $3::varchar
       WHERE NOT EXISTS (SELECT 1 FROM districts WHERE state_id = $1 AND (code = $3 OR lower(name) = lower($2)))`,
      [state!.id, name, code],
    );
  return n;
}

async function options(db: Db): Promise<number> {
  let n = 0;
  for (const [kind, list] of Object.entries(OPTIONS))
    for (const [i, [code, nameEn, nameMr]] of list.entries())
      n += await add(
        db,
        `INSERT INTO program_options (kind, code, name_en, name_mr, display_order, is_system)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5, $6
         WHERE NOT EXISTS (SELECT 1 FROM program_options WHERE kind = $1 AND (lower(code) = lower($2) OR lower(name_en) = lower($3)))`,
        [kind, code, nameEn, nameMr, place(i), SYSTEM_KINDS.includes(kind)],
      );
  return n;
}

async function documents(db: Db): Promise<number> {
  let n = 0;
  for (const [i, d] of DOCUMENTS.entries())
    n += await add(
      db,
      `INSERT INTO program_documents (code, name_en, name_mr, required, kind, display_order, is_system, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7) ON CONFLICT DO NOTHING`,
      [d.code, d.nameEn, d.nameMr, d.required, d.kind, place(i), d.active],
    );
  return n;
}

async function fields(db: Db): Promise<number> {
  let n = 0;
  for (const step of [1, 2] as const)
    for (const [i, f] of FIELDS[step].entries())
      n += await add(
        db,
        `INSERT INTO program_fields (key, step, type, label_en, label_mr, required, display_order, validation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT DO NOTHING`,
        [f.key, step, f.type, f.labelEn, f.labelMr, f.required, place(i), DEFAULT_CHECKS[f.key] ? JSON.stringify(DEFAULT_CHECKS[f.key]) : null],
      );
  return n;
}

async function panelAdmin(db: Db): Promise<number> {
  if (!env.PANEL_ADMIN_EMAIL || !env.PANEL_ADMIN_PASSWORD) return 0;
  return add(
    db,
    `INSERT INTO panel_users (name, email, password_hash, role)
     SELECT 'Auditor', $1, $2, 'ADMIN' WHERE NOT EXISTS (SELECT 1 FROM panel_users)`,
    [env.PANEL_ADMIN_EMAIL.toLowerCase(), await hashPassword(env.PANEL_ADMIN_PASSWORD)],
  );
}

/* How many rows were added, by part. */
export async function seed(): Promise<Record<string, number>> {
  return transaction(async (db) => ({
    states_and_districts: await geography(db),
    choices: await options(db),
    documents: await documents(db),
    fields: await fields(db),
    panel_admin: await panelAdmin(db),
  }));
}
