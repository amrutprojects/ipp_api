import { one, pool, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { contains, offset, pageMeta } from '../../lib/paging';
import {
  assertNotHeld,
  countsSql,
  knownParent,
  orConflict,
  record,
  usableParent,
  type By,
  type HeldCounts,
} from './common.service';
import type { CentreListQuery, NewCentreBody, UpdateCentreBody } from './centres.schemas';

/*
 * Center Master: the centers a student chooses from and a batch is placed at. A center belongs to one district (its state is
 * the district's) and, if given, to one of the district's talukas. Its name is unique in the district, its code overall. A
 * deactivated one is no longer offered; a student who had chosen it chooses again.
 */
interface CentreValues {
  name: string;
  code: string;
  address: string | null;
  pinCode: string | null;
  contactPerson: string | null;
  contactNumber: string | null;
  email: string | null;
}
interface Placed {
  districtId: string;
  talukaId: string | null;
}
interface CentreRow extends CentreValues, Placed {
  id: string;
  stateId: string;
  stateName: string;
  stateCode: string;
  stateIsActive: boolean;
  districtName: string;
  districtCode: string;
  districtIsActive: boolean;
  talukaName: string | null;
  talukaCode: string | null;
  talukaIsActive: boolean | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const VALUES = `c.name, c.code, c.address, c.pin_code AS "pinCode", c.contact_person AS "contactPerson",
  c.contact_number AS "contactNumber", c.email, c.district_id AS "districtId", c.taluka_id AS "talukaId"`;
const FROM = `FROM centres c JOIN districts d ON d.id = c.district_id JOIN states s ON s.id = d.state_id
  LEFT JOIN talukas t ON t.id = c.taluka_id WHERE c.deleted_at IS NULL`;
const SELECT = `SELECT c.id, ${VALUES}, c.is_active AS "isActive", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
  d.state_id AS "stateId", s.name AS "stateName", s.code AS "stateCode", s.is_active AS "stateIsActive",
  d.name AS "districtName", d.code AS "districtCode", d.is_active AS "districtIsActive",
  t.name AS "talukaName", t.code AS "talukaCode", t.is_active AS "talukaIsActive" ${FROM}`;
const SORT: Record<CentreListQuery['sortBy'], string> = {
  name: 'lower(c.name)',
  code: 'c.code',
  districtName: 'lower(d.name)',
  createdAt: 'c.created_at',
  updatedAt: 'c.updated_at',
};
const HELD_BY = {
  forms: 'FROM applications x WHERE x.centre_id = c.id AND x.deleted_at IS NULL',
  batches: 'FROM batches x WHERE x.centre_id = c.id AND x.deleted_at IS NULL',
};

const NAME_TAKEN = 'A center with this name already exists in the selected district';
const DUPLICATES = { uq_centres_name: NAME_TAKEN, uq_centres_code: 'A center with this code already exists' };

/* The technologies a student may choose depend on the district, not on the center. */
const centreDto = (c: CentreRow) => ({ ...c, technologies: [] });

async function getCentre(id: string, db: Db = pool) {
  const row = await one<CentreRow>(`${SELECT} AND c.id = $1`, [id], db);
  if (!row) throw AppError.notFound('Center not found');
  return centreDto(row);
}

/* Locked until the transaction ends. */
async function lockCentre(db: Db, id: string): Promise<CentreValues & Placed> {
  const row = await one<CentreValues & Placed>(
    `SELECT ${VALUES} FROM centres c WHERE c.id = $1 AND c.deleted_at IS NULL FOR UPDATE`,
    [id],
    db,
  );
  if (!row) throw AppError.notFound('Center not found');
  return row;
}

function assertInState(districtStateId: string | null, stateId: string | undefined): void {
  if (stateId && districtStateId !== stateId)
    throw AppError.badRequest('The selected district does not belong to the selected state', [
      { field: 'districtId', message: 'Choose a district of the selected state' },
    ]);
}

async function assertTalukaInDistrict(db: Db, talukaId: string, districtId: string): Promise<void> {
  const taluka = await usableParent(db, 'taluka', talukaId, 'talukaId');
  if (taluka.parent_id !== districtId)
    throw AppError.badRequest('The selected taluka does not belong to the selected district', [
      { field: 'talukaId', message: 'Choose a taluka of the selected district' },
    ]);
}

/* A center with the same name and code as another is told about the name first. */
async function assertNameFree(db: Db, districtId: string, name: string, exceptId: string | null): Promise<void> {
  const same = await one(
    `SELECT 1 FROM centres
     WHERE district_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND id IS DISTINCT FROM $3::uuid`,
    [districtId, name, exceptId],
    db,
  );
  if (same) throw AppError.conflict(NAME_TAKEN);
}

export const centresService = {
  async list(q: CentreListQuery) {
    if (q.stateId) await knownParent(pool, 'state', q.stateId, 'stateId');
    if (q.districtId) await knownParent(pool, 'district', q.districtId, 'districtId');
    const params: unknown[] = [];
    let where = '';
    if (q.stateId) where += ` AND d.state_id = $${params.push(q.stateId)}`;
    if (q.districtId) where += ` AND c.district_id = $${params.push(q.districtId)}`;
    if (q.isActive !== undefined) where += ` AND c.is_active = ${q.isActive}`;
    if (q.search) {
      const n = `$${params.push(contains(q.search))}`;
      where += ` AND (c.name ILIKE ${n} OR c.code ILIKE ${n} OR d.name ILIKE ${n})`;
    }
    const total = (await one<{ n: number }>(`SELECT count(*) AS n ${FROM}${where}`, params))!.n;
    const items = await rows<CentreRow>(
      `${SELECT}${where} ORDER BY ${SORT[q.sortBy]} ${q.sortOrder}, c.id
       LIMIT $${params.push(q.limit)} OFFSET $${params.push(offset(q))}`,
      params,
    );
    return { items: items.map(centreDto), meta: pageMeta(q, total) };
  },

  get: (id: string) => getCentre(id),

  create(who: By, body: NewCentreBody) {
    return orConflict(DUPLICATES, () =>
      transaction(async (db) => {
        const district = await usableParent(db, 'district', body.districtId, 'districtId');
        assertInState(district.parent_id, body.stateId);
        if (body.talukaId) await assertTalukaInDistrict(db, body.talukaId, body.districtId);
        await assertNameFree(db, body.districtId, body.name, null);
        const row = await one<{ id: string }>(
          `INSERT INTO centres (district_id, taluka_id, name, code, address, pin_code, contact_person, contact_number, email, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            body.districtId,
            body.talukaId ?? null,
            body.name,
            body.code,
            body.address ?? null,
            body.pinCode ?? null,
            body.contactPerson ?? null,
            body.contactNumber ?? null,
            body.email ?? null,
            body.isActive ?? true,
          ],
          db,
        );
        await record(db, who, 'cms.centre.create', 'centre', row!.id, {
          district_id: body.districtId,
          taluka_id: body.talukaId ?? null,
        });
        return getCentre(row!.id, db);
      }),
    );
  },

  update(who: By, id: string, body: UpdateCentreBody) {
    return orConflict(DUPLICATES, () =>
      transaction(async (db) => {
        const before = await lockCentre(db, id);
        const { stateId, ...changes } = body;
        const sent = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<
          CentreValues & Placed
        >;
        const after = { ...before, ...sent };
        const moved = after.districtId !== before.districtId;
        /* A district that stays is not checked again: it may have been switched off since. */
        const district = moved
          ? await usableParent(db, 'district', after.districtId, 'districtId')
          : await knownParent(db, 'district', after.districtId, 'districtId');
        assertInState(district.parent_id, stateId);
        if (moved && body.talukaId === undefined && before.talukaId)
          throw AppError.badRequest('Choose a taluka of the new district, or none, when moving the center', [
            { field: 'talukaId', message: 'Choose a taluka of the selected district, or none' },
          ]);
        if (after.talukaId && (moved || after.talukaId !== before.talukaId))
          await assertTalukaInDistrict(db, after.talukaId, after.districtId);
        await assertNameFree(db, after.districtId, after.name, id);
        await db.query(
          `UPDATE centres SET district_id = $2, taluka_id = $3, name = $4, code = $5, address = $6, pin_code = $7,
             contact_person = $8, contact_number = $9, email = $10 WHERE id = $1`,
          [
            id,
            after.districtId,
            after.talukaId,
            after.name,
            after.code,
            after.address,
            after.pinCode,
            after.contactPerson,
            after.contactNumber,
            after.email,
          ],
        );
        await record(db, who, 'cms.centre.update', 'centre', id, { fields: Object.keys(changes), moved });
        return getCentre(id, db);
      }),
    );
  },

  /* Never refused: a center that is used is deactivated, not deleted. */
  setStatus(who: By, id: string, isActive: boolean) {
    return transaction(async (db) => {
      await lockCentre(db, id);
      await db.query('UPDATE centres SET is_active = $2 WHERE id = $1', [id, isActive]);
      await record(db, who, 'cms.centre.status', 'centre', id, { is_active: isActive });
      return getCentre(id, db);
    });
  },

  remove(who: By, id: string) {
    return transaction(async (db) => {
      await lockCentre(db, id);
      const held = await one<HeldCounts>(`SELECT ${countsSql(HELD_BY)} FROM centres c WHERE c.id = $1`, [id], db);
      assertNotHeld('center', held!);
      await db.query('UPDATE centres SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'cms.centre.delete', 'centre', id);
    });
  },
};
