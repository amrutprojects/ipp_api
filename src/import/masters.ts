import { one, type Db } from '../db/pool';
import { isLinkedKind } from '../program/constants';
import type { Source } from './source';

/*
 * The masters of the earlier system, put over the seeded ones: a row with the same code (or name) here is that row and takes
 * over its current names, order and state; any other is added with its id. The maps translate the ids forms store.
 */
type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v));
const orNull = (v: unknown) => text(v) || null;

export interface Maps {
  district: Map<string, string>;
  centre: Map<string, string>;
  batch: Map<string, string>;
  /* Forms past the batch stage without a batch → the batch made for them. */
  looseBatch: Map<string, string>;
  /* A form's stored id as it is here; null = not known. */
  reference(key: 'district_id' | 'centre_id' | 'caste_id' | 'region_id' | 'education_id', value: string): string | null;
}

const LINKED_TABLE = { CASTE: 'castes', EDUCATION: 'educations', REGION: 'regions' } as const;
type Count = (what: string, n?: number) => unknown;

/* Finds a row here by `sql` (its id), or adds one with `insert`; returns the id. */
async function findOrAdd(db: Db, find: [sql: string, params: unknown[]], insert: [sql: string, params: unknown[]]) {
  const known = await one<{ id: string }>(find[0], find[1], db);
  if (known) return { id: known.id, added: false };
  return { id: (await one<{ id: string }>(insert[0], insert[1], db))!.id, added: true };
}

export async function importMasters(src: Source, db: Db, count: Count, warn: (m: string) => unknown): Promise<Maps> {
  const state = new Map<string, string>();
  const district = new Map<string, string>();
  const taluka = new Map<string, string>();
  const centre = new Map<string, string>();
  const option = new Map<string, string>();

  for (const s of await src.rows<Row>(`SELECT * FROM states WHERE NOT "isDelete" ORDER BY "createdAt"`)) {
    const r = await findOrAdd(
      db,
      [`SELECT id FROM states WHERE deleted_at IS NULL AND (code = $1 OR lower(name) = lower($2))`, [s.code, s.name]],
      [`INSERT INTO states (id, name, code, is_active) VALUES ($1, $2, $3, $4) RETURNING id`, [s.id, s.name, s.code, s.isActive]],
    );
    state.set(text(s.id), r.id);
    if (r.added) count('states');
  }
  for (const d of await src.rows<Row>(`SELECT * FROM districts WHERE NOT "isDelete" ORDER BY "createdAt"`)) {
    const of = state.get(text(d.stateId));
    if (!of) {
      warn(`district ${text(d.id)}: its state was left out, so it is too`);
      continue;
    }
    const r = await findOrAdd(
      db,
      [
        `SELECT id FROM districts WHERE deleted_at IS NULL AND state_id = $1 AND (code = $2 OR lower(name) = lower($3)) ORDER BY (code = $2) DESC LIMIT 1`,
        [of, d.code, d.name],
      ],
      [
        `INSERT INTO districts (id, state_id, name, code, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [d.id, of, d.name, d.code, d.isActive],
      ],
    );
    district.set(text(d.id), r.id);
    if (r.added) count('districts');
    else await db.query(`UPDATE districts SET is_active = $2 WHERE id = $1`, [r.id, d.isActive]);
  }
  for (const t of await src.rows<Row>(`SELECT * FROM talukas WHERE NOT "isDelete" ORDER BY "createdAt"`)) {
    const of = district.get(text(t.districtId));
    if (!of) continue;
    const r = await findOrAdd(
      db,
      [`SELECT id FROM talukas WHERE deleted_at IS NULL AND district_id = $1 AND lower(name) = lower($2)`, [of, t.name]],
      [
        `INSERT INTO talukas (id, district_id, name, code, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [t.id, of, t.name, orNull(t.code), t.isActive],
      ],
    );
    taluka.set(text(t.id), r.id);
    if (r.added) count('talukas');
  }
  /* Deleted centers too: a form may hold one. */
  for (const c of await src.rows<Row>(`SELECT * FROM edp_centres ORDER BY "isDelete", "createdAt"`)) {
    const of = district.get(text(c.districtId));
    if (!of) {
      warn(`center ${text(c.id)}: its district was left out, so it is too`);
      continue;
    }
    const r = await findOrAdd(
      db,
      [`SELECT id FROM centres WHERE deleted_at IS NULL AND NOT $2 AND upper(code) = upper($1)`, [c.code, c.isDelete]],
      [
        `INSERT INTO centres (id, district_id, taluka_id, name, code, address, pin_code, contact_person, contact_number, email, is_active, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 THEN now() END) RETURNING id`,
        [
          c.id,
          of,
          taluka.get(text(c.talukaId)) ?? null,
          c.name,
          c.code,
          orNull(c.address),
          orNull(c.pinCode),
          orNull(c.contactPerson),
          orNull(c.contactNumber),
          orNull(c.email),
          c.isActive && !c.isDelete,
          c.isDelete,
        ],
      ],
    );
    centre.set(text(c.id), r.id);
    if (r.added) count('centers');
  }

  for (const o of await src.rows<Row>(`SELECT * FROM program_options ORDER BY "isDelete", "displayOrder", "createdAt"`)) {
    const kind = text(o.kind);
    const r = await findOrAdd(
      db,
      [
        `SELECT id FROM program_options WHERE kind = $1 AND deleted_at IS NULL AND NOT $4
           AND (lower(code) = lower($2) OR lower(name_en) = lower($3)) ORDER BY (lower(code) = lower($2)) DESC LIMIT 1`,
        [kind, o.code, o.nameEn, o.isDelete],
      ],
      [
        `INSERT INTO program_options (id, kind, code, name_en, name_mr, display_order, is_active, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END) RETURNING id`,
        [o.id, kind, o.code, o.nameEn, orNull(o.nameMr), o.displayOrder, o.isActive && !o.isDelete, o.isDelete],
      ],
    );
    if (!r.added)
      await db.query(`UPDATE program_options SET name_en = $2, name_mr = $3, display_order = $4, is_active = $5 WHERE id = $1`, [
        r.id,
        o.nameEn,
        orNull(o.nameMr),
        o.displayOrder,
        o.isActive,
      ]);
    else count('choices');
    option.set(text(o.id), r.id);
    if (isLinkedKind(kind) && o.masterId && !option.has(`${kind}:${text(o.masterId)}`))
      option.set(`${kind}:${text(o.masterId)}`, r.id);
  }
  /* A choice a form holds that was never a choice of the program: kept, switched off, under its own name. */
  for (const [kind, key] of [
    ['CASTE', 'caste_id'],
    ['EDUCATION', 'education_id'],
    ['REGION', 'region_id'],
  ] as const)
    for (const m of await src.rows<Row>(
      `SELECT m.id, m.code, m.name FROM ${LINKED_TABLE[kind]} m
       WHERE m.id::text IN (SELECT p.data->>'${key}' FROM edp_applications p WHERE NOT p."isDelete")
          OR m.id IN (SELECT s."${key === 'caste_id' ? 'casteId' : key === 'education_id' ? 'educationId' : 'regionId'}"
                      FROM edp_applications p JOIN students s ON s.id = p."studentId" WHERE NOT p."isDelete")`,
    )) {
      if (option.has(`${kind}:${text(m.id)}`)) continue;
      const r = await findOrAdd(
        db,
        [
          `SELECT id FROM program_options WHERE kind = $1 AND deleted_at IS NULL AND (lower(code) = lower($2) OR lower(name_en) = lower($3)) LIMIT 1`,
          [kind, m.code, text(m.name)],
        ],
        [
          `INSERT INTO program_options (id, kind, code, name_en, name_mr, display_order, is_active) VALUES ($1, $2, $3, $4, $5, 9999, false) RETURNING id`,
          [m.id, kind, m.code, text(m.name).slice(0, 150), kind === 'CASTE' ? text(m.name).slice(0, 150) : null],
        ],
      );
      option.set(`${kind}:${text(m.id)}`, r.id);
      if (r.added) count('choices of forms, switched off');
    }
  for (const t of await src.rows<Row>(`SELECT * FROM program_district_technologies`)) {
    const d = district.get(text(t.districtId));
    const o = option.get(text(t.optionId));
    if (d && o)
      await db.query(`INSERT INTO district_technologies (district_id, option_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [d, o]);
  }

  for (const d of await src.rows<Row>(`SELECT * FROM program_documents ORDER BY "isDelete", "displayOrder"`)) {
    const { rowCount } = await db.query(
      `UPDATE program_documents SET name_en = $2, name_mr = $3, required = $4, display_order = $5, is_active = $6 WHERE code = $1`,
      [d.code, d.nameEn, orNull(d.nameMr), d.required, d.displayOrder, d.isActive && !d.isDelete],
    );
    if (rowCount) continue;
    await db.query(
      `INSERT INTO program_documents (id, code, name_en, name_mr, required, kind, display_order, is_active, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)`,
      [d.id, d.code, d.nameEn, orNull(d.nameMr), d.required, d.kind, d.displayOrder, d.isActive && !d.isDelete, d.isDelete],
    );
    count('documents');
  }
  for (const f of await src.rows<Row>(`SELECT * FROM program_fields ORDER BY "isDelete", step, "displayOrder"`)) {
    const { rowCount } = await db.query(
      `UPDATE program_fields SET label_en = $2, label_mr = $3, required = is_core OR $4, display_order = $5, is_active = is_core OR $6,
         help_en = $7, help_mr = $8 WHERE key = $1`,
      [
        f.key,
        f.labelEn,
        orNull(f.labelMr),
        f.required,
        f.displayOrder,
        f.isActive && !f.isDelete,
        orNull(f.helpEn),
        orNull(f.helpMr),
      ],
    );
    if (rowCount) continue;
    await db.query(
      `INSERT INTO program_fields (id, key, step, type, label_en, label_mr, help_en, help_mr, required, display_order, is_custom, is_active, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, CASE WHEN $12 THEN now() END)`,
      [
        f.id,
        f.key,
        f.step,
        f.type,
        f.labelEn,
        orNull(f.labelMr),
        orNull(f.helpEn),
        orNull(f.helpMr),
        f.required,
        f.displayOrder,
        f.isActive && !f.isDelete,
        f.isDelete,
      ],
    );
    count('own fields');
  }

  return {
    district,
    centre,
    batch: new Map(),
    looseBatch: new Map(),
    reference(key, value) {
      if (key === 'district_id') return district.get(value) ?? null;
      if (key === 'centre_id') return centre.get(value) ?? null;
      const kind = key === 'caste_id' ? 'CASTE' : key === 'education_id' ? 'EDUCATION' : 'REGION';
      return option.get(`${kind}:${value}`) ?? null;
    },
  };
}
