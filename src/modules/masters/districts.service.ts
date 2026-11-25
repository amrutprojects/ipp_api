import { one, pool, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import {
  assertNotHeld,
  countsSql,
  inUseSql,
  knownParent,
  lock,
  orConflict,
  record,
  usableParent,
  type By,
  type HeldCounts,
} from './common.service';
import type { DistrictListQuery, NewDistrictBody, UpdateDistrictBody } from './districts.schemas';

/*
 * The districts the form offers. A name and a code are unique in the state. One that anything refers to cannot be deleted,
 * only switched off; its talukas and centers are kept.
 */
interface DistrictRow {
  id: string;
  name: string;
  code: string;
  state_id: string;
  state: string;
  /* Not deleted ones, also inactive. */
  talukas: number;
  is_active: boolean;
  in_use: boolean;
}

const TALUKAS = 'FROM talukas x WHERE x.district_id = d.id AND x.deleted_at IS NULL';
const HELD_BY = {
  talukas: TALUKAS,
  centres: 'FROM centres x WHERE x.district_id = d.id AND x.deleted_at IS NULL',
  forms: 'FROM applications x WHERE x.district_id = d.id AND x.deleted_at IS NULL',
  batches: 'FROM batches x WHERE x.district_id = d.id AND x.deleted_at IS NULL',
};
const SELECT = `SELECT d.id, d.name, d.code, d.state_id, s.name AS state, ${countsSql({ talukas: TALUKAS })}, d.is_active,
    ${inUseSql(HELD_BY)} AS in_use
  FROM districts d JOIN states s ON s.id = d.state_id WHERE d.deleted_at IS NULL`;

const DUPLICATES = {
  uq_districts_name: 'A district with this name already exists in the selected state',
  uq_districts_code: 'A district with this code already exists in the selected state',
};

async function getDistrict(db: Db, id: string): Promise<DistrictRow> {
  const row = await one<DistrictRow>(`${SELECT} AND d.id = $1`, [id], db);
  if (!row) throw AppError.notFound('District not found');
  return row;
}

type Stored = Pick<DistrictRow, 'name' | 'code' | 'state_id' | 'is_active'>;
/* Locked until the transaction ends. */
async function lockDistrict(db: Db, id: string): Promise<Stored> {
  const row = await one<Stored>(
    'SELECT name, code, state_id, is_active FROM districts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [id],
    db,
  );
  if (!row) throw AppError.notFound('District not found');
  return row;
}

/* The state of a new district when none is given: Maharashtra, else the one with the most districts. */
async function defaultState(db: Db): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT s.id FROM states s WHERE s.is_active
     ORDER BY (s.code = 'MH') DESC,
       (SELECT count(*) FROM districts d WHERE d.state_id = s.id AND d.deleted_at IS NULL) DESC, s.name LIMIT 1`,
    [],
    db,
  );
  if (!row) throw AppError.validation([{ field: 'body.state_id', message: 'Choose a state' }]);
  return row.id;
}

/* A code made from the name (PUNE, PUNE2, …), free in the state. */
async function newCode(db: Db, stateId: string, name: string): Promise<string> {
  const letters = name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 6);
  const base = letters.length >= 2 ? letters : 'DIST';
  const taken = await rows<{ code: string }>(
    'SELECT code FROM districts WHERE state_id = $1 AND deleted_at IS NULL AND code LIKE $2',
    [stateId, `${base}%`],
    db,
  );
  const used = new Set(taken.map((t) => t.code));
  for (let n = 1; ; n++) {
    const code = `${base}${n > 1 ? n : ''}`;
    if (!used.has(code)) return code;
  }
}

/* Generated codes are decided one by one. */
const lockDistricts = (db: Db) => lock(db, 'districts');

export const districtsService = {
  /* A to Z. */
  async list(q: DistrictListQuery) {
    if (q.state_id) await knownParent(pool, 'state', q.state_id, 'state_id');
    const params: unknown[] = [];
    let where = '';
    if (q.status) where += ` AND d.is_active = ${q.status === 'ACTIVE'}`;
    if (q.state_id) where += ` AND d.state_id = $${params.push(q.state_id)}`;
    return rows<DistrictRow>(`${SELECT}${where} ORDER BY lower(d.name), d.id`, params);
  },

  create(who: By, body: NewDistrictBody) {
    return orConflict(DUPLICATES, () =>
      transaction(async (db) => {
        await lockDistricts(db);
        const stateId = body.state_id ?? (await defaultState(db));
        await usableParent(db, 'state', stateId, 'stateId');
        const row = await one<{ id: string }>(
          'INSERT INTO districts (state_id, name, code, is_active) VALUES ($1, $2, $3, $4) RETURNING id',
          [stateId, body.name, body.code ?? (await newCode(db, stateId, body.name)), body.is_active ?? true],
          db,
        );
        await record(db, who, 'edp.district.create', 'district', row!.id, { state_id: stateId });
        return getDistrict(db, row!.id);
      }),
    );
  },

  update(who: By, id: string, body: UpdateDistrictBody) {
    return orConflict(DUPLICATES, () =>
      transaction(async (db) => {
        await lockDistricts(db);
        const before = await lockDistrict(db, id);
        const stateId = body.state_id ?? before.state_id;
        if (stateId !== before.state_id) await usableParent(db, 'state', stateId, 'stateId');
        await db.query('UPDATE districts SET state_id = $2, name = $3, code = $4, is_active = $5 WHERE id = $1', [
          id,
          stateId,
          body.name ?? before.name,
          body.code ?? before.code,
          body.is_active ?? before.is_active,
        ]);
        await record(db, who, 'edp.district.update', 'district', id, { fields: Object.keys(body) });
        return getDistrict(db, id);
      }),
    );
  },

  remove(who: By, id: string) {
    return transaction(async (db) => {
      await lockDistrict(db, id);
      const held = await one<HeldCounts>(`SELECT ${countsSql(HELD_BY)} FROM districts d WHERE d.id = $1`, [id], db);
      assertNotHeld('district', held!);
      await db.query('UPDATE districts SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.district.delete', 'district', id);
    });
  },
};
