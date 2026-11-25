import { one, pool, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { contains, offset, pageMeta } from '../../lib/paging';
import {
  assertNotHeld,
  countsSql,
  heldText,
  inUseSql,
  knownParent,
  orConflict,
  record,
  usableParent,
  type By,
  type HeldCounts,
} from './common.service';
import type { NewTalukaBody, TalukaListQuery, UpdateTalukaBody } from './talukas.schemas';

/*
 * The talukas of the districts, for the Center Master (a student types the taluka). A name, and a code when there is one, is
 * unique in the district. One that a center uses is neither deleted nor moved to another district.
 */
interface TalukaRow {
  id: string;
  name: string;
  code: string | null;
  district_id: string;
  district: string;
  is_active: boolean;
  in_use: boolean;
}

const HELD_BY = { centres: 'FROM centres x WHERE x.taluka_id = t.id AND x.deleted_at IS NULL' };
const FROM = 'FROM talukas t JOIN districts d ON d.id = t.district_id WHERE t.deleted_at IS NULL';
const SELECT = `SELECT t.id, t.name, t.code, t.district_id, d.name AS district, t.is_active, ${inUseSql(HELD_BY)} AS in_use ${FROM}`;

const DUPLICATES = {
  uq_talukas_name: 'A taluka with this name already exists in the selected district',
  uq_talukas_code: 'A taluka with this code already exists in the selected district',
};

async function getTaluka(db: Db, id: string): Promise<TalukaRow> {
  const row = await one<TalukaRow>(`${SELECT} AND t.id = $1`, [id], db);
  if (!row) throw AppError.notFound('Taluka not found');
  return row;
}

type Stored = Pick<TalukaRow, 'name' | 'code' | 'district_id' | 'is_active'>;
/* Locked until the transaction ends. */
async function lockTaluka(db: Db, id: string): Promise<Stored> {
  const row = await one<Stored>(
    'SELECT name, code, district_id, is_active FROM talukas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [id],
    db,
  );
  if (!row) throw AppError.notFound('Taluka not found');
  return row;
}

const heldBy = async (db: Db, id: string) =>
  (await one<HeldCounts>(`SELECT ${countsSql(HELD_BY)} FROM talukas t WHERE t.id = $1`, [id], db))!;

export const talukasService = {
  async list(q: TalukaListQuery) {
    if (q.district_id) await knownParent(pool, 'district', q.district_id, 'district_id');
    const params: unknown[] = [];
    let where = '';
    if (q.district_id) where += ` AND t.district_id = $${params.push(q.district_id)}`;
    if (q.status) where += ` AND t.is_active = ${q.status === 'ACTIVE'}`;
    if (q.search) {
      const n = `$${params.push(contains(q.search))}`;
      where += ` AND (t.name ILIKE ${n} OR t.code ILIKE ${n} OR d.name ILIKE ${n})`;
    }
    const total = (await one<{ n: number }>(`SELECT count(*) AS n ${FROM}${where}`, params))!.n;
    const items = await rows<TalukaRow>(
      `${SELECT}${where} ORDER BY lower(d.name) ${q.sortOrder}, d.id, lower(t.name) ${q.sortOrder}, t.id
       LIMIT $${params.push(q.limit)} OFFSET $${params.push(offset(q))}`,
      params,
    );
    return { items, meta: pageMeta(q, total) };
  },

  create(who: By, body: NewTalukaBody) {
    return orConflict(DUPLICATES, () =>
      transaction(async (db) => {
        await usableParent(db, 'district', body.district_id, 'district_id');
        const row = await one<{ id: string }>(
          'INSERT INTO talukas (district_id, name, code, is_active) VALUES ($1, $2, $3, $4) RETURNING id',
          [body.district_id, body.name, body.code ?? null, body.is_active ?? true],
          db,
        );
        await record(db, who, 'edp.taluka.create', 'taluka', row!.id, { district_id: body.district_id });
        return getTaluka(db, row!.id);
      }),
    );
  },

  update(who: By, id: string, body: UpdateTalukaBody) {
    return orConflict(DUPLICATES, () =>
      transaction(async (db) => {
        const before = await lockTaluka(db, id);
        const districtId = body.district_id ?? before.district_id;
        if (districtId !== before.district_id) {
          await usableParent(db, 'district', districtId, 'district_id');
          /* A center is in a district and in this taluka: moving the taluka would put it in two districts. */
          const held = await heldBy(db, id);
          if (held.centres)
            throw AppError.conflict(
              `This taluka cannot move to another district while ${heldText(held)} it. Re-point those records first.`,
            );
        }
        await db.query('UPDATE talukas SET district_id = $2, name = $3, code = $4, is_active = $5 WHERE id = $1', [
          id,
          districtId,
          body.name ?? before.name,
          body.code === undefined ? before.code : body.code,
          body.is_active ?? before.is_active,
        ]);
        await record(db, who, 'edp.taluka.update', 'taluka', id, { fields: Object.keys(body) });
        return getTaluka(db, id);
      }),
    );
  },

  remove(who: By, id: string) {
    return transaction(async (db) => {
      await lockTaluka(db, id);
      assertNotHeld('taluka', await heldBy(db, id));
      await db.query('UPDATE talukas SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.taluka.delete', 'taluka', id);
    });
  },
};
