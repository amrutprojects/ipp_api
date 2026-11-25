import { one, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { assertNotHeld, countsSql, inUseSql, orConflict, record, type By, type HeldCounts } from './common.service';
import type { NewStateBody, UpdateStateBody } from './states.schemas';

/*
 * The states. One that is switched off is no longer offered; its districts keep their own status. One with districts cannot
 * be deleted.
 */
interface StateRow {
  id: string;
  name: string;
  code: string;
  /* Not deleted ones, also inactive. */
  districts: number;
  is_active: boolean;
  in_use: boolean;
}

const HELD_BY = { districts: 'FROM districts x WHERE x.state_id = s.id AND x.deleted_at IS NULL' };
const SELECT = `SELECT s.id, s.name, s.code, ${countsSql(HELD_BY)}, s.is_active, ${inUseSql(HELD_BY)} AS in_use
  FROM states s WHERE s.deleted_at IS NULL`;

async function getState(db: Db, id: string): Promise<StateRow> {
  const row = await one<StateRow>(`${SELECT} AND s.id = $1`, [id], db);
  if (!row) throw AppError.notFound('State not found');
  return row;
}

/* Locked until the transaction ends. */
async function lockState(db: Db, id: string): Promise<{ name: string; code: string; is_active: boolean }> {
  const row = await one<{ name: string; code: string; is_active: boolean }>(
    'SELECT name, code, is_active FROM states WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [id],
    db,
  );
  if (!row) throw AppError.notFound('State not found');
  return row;
}

export const statesService = {
  list: () => rows<StateRow>(`${SELECT} ORDER BY lower(s.name), s.id`),

  create(who: By, body: NewStateBody) {
    return orConflict(
      { uq_states_name: 'A state with this name already exists', uq_states_code: 'A state with this code already exists' },
      () =>
        transaction(async (db) => {
          const row = await one<{ id: string }>(
            'INSERT INTO states (name, code, is_active) VALUES ($1, $2, $3) RETURNING id',
            [body.name, body.code, body.is_active ?? true],
            db,
          );
          await record(db, who, 'edp.state.create', 'state', row!.id);
          return getState(db, row!.id);
        }),
    );
  },

  update(who: By, id: string, body: UpdateStateBody) {
    return orConflict(
      { uq_states_name: 'Another state already uses this name', uq_states_code: 'Another state already uses this code' },
      () =>
        transaction(async (db) => {
          const before = await lockState(db, id);
          await db.query('UPDATE states SET name = $2, code = $3, is_active = $4 WHERE id = $1', [
            id,
            body.name ?? before.name,
            body.code ?? before.code,
            body.is_active ?? before.is_active,
          ]);
          await record(db, who, 'edp.state.update', 'state', id, { fields: Object.keys(body) });
          return getState(db, id);
        }),
    );
  },

  remove(who: By, id: string) {
    return transaction(async (db) => {
      await lockState(db, id);
      const held = await one<HeldCounts>(`SELECT ${countsSql(HELD_BY)} FROM states s WHERE s.id = $1`, [id], db);
      assertNotHeld('state', held!);
      await db.query('UPDATE states SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.state.delete', 'state', id);
    });
  },
};
