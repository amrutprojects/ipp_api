import type { Request, Response } from 'express';
import { DatabaseError } from 'pg';
import { one, type Db } from '../../db/pool';
import { panelOf, type PanelUser } from '../../http/auth';
import { AppError } from '../../http/errors';
import { audit } from '../../services/audit';

/* Who makes a change. */
export interface By {
  req: Request;
  user: PanelUser;
}
export const by = (c: { req: Request; res: Response }): By => ({ req: c.req, user: panelOf(c.res) });

/* The audit record of a change, in its transaction: ids, counts and field names only. */
export const record = (
  db: Db,
  who: By,
  action: string,
  resource: string,
  resourceId: string,
  details?: Record<string, unknown>,
): Promise<void> => audit.inTx(db, who.req, { action, resource, resourceId, actor: { kind: 'PANEL', id: who.user.id }, details });

/* One change of a list at a time, until the transaction ends: codes, places and duplicates are decided one by one. */
export const lock = (db: Db, key: string) => db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);

/* The unique indexes decide between two changes at once; what one refuses is answered with its message. */
export async function orConflict<T>(messages: Record<string, string>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof DatabaseError && err.code === '23505' ? messages[err.constraint ?? ''] : undefined;
    throw message ? AppError.conflict(message) : err;
  }
}

/* ------------------------------------------------------------------------------------------------- parents and children */

/*
 * A parent that is being deleted is locked FOR UPDATE before its children are counted, and a child is only attached to a
 * parent read FOR SHARE. Whichever comes first wins: the child is counted (409), or finds its parent deleted (400).
 */
const PARENTS = {
  state: 'SELECT is_active, NULL::uuid AS parent_id FROM states WHERE id = $1 AND deleted_at IS NULL',
  district: 'SELECT is_active, state_id AS parent_id FROM districts WHERE id = $1 AND deleted_at IS NULL',
  taluka: 'SELECT is_active, district_id AS parent_id FROM talukas WHERE id = $1 AND deleted_at IS NULL',
} as const;
type ParentKind = keyof typeof PARENTS;
interface Parent {
  is_active: boolean;
  /* The state of a district, the district of a taluka. */
  parent_id: string | null;
}

/* The record a new child may be attached to: it exists and is active. `field` = the request's key for it. */
export async function usableParent(db: Db, kind: ParentKind, id: string, field: string): Promise<Parent> {
  const parent = await knownParent(db, kind, id, field, 'FOR SHARE');
  if (!parent.is_active)
    throw AppError.badRequest(`The selected ${kind} is inactive`, [{ field, message: `Choose an active ${kind}` }]);
  return parent;
}

/* A record that exists, active or not: a list filtered by an unknown one is an error, not an empty list. */
export async function knownParent(db: Db, kind: ParentKind, id: string, field: string, locked: 'FOR SHARE' | '' = '') {
  const parent = await one<Parent>(`${PARENTS[kind]} ${locked}`, [id], db);
  if (!parent) throw AppError.badRequest(`The selected ${kind} does not exist`, [{ field, message: `Unknown ${kind}` }]);
  return parent;
}

/* What keeps a record from being deleted, by its name: one, many. */
const HOLDERS = {
  districts: ['district', 'districts'],
  talukas: ['taluka', 'talukas'],
  centres: ['center', 'centers'],
  forms: ["student's form", "students' forms"],
  batches: ['batch', 'batches'],
} as const;
type Holder = keyof typeof HOLDERS;
/* "FROM … WHERE …" of the rows that hold a record, from constants only. */
type HeldBy = Partial<Record<Holder, string>>;
export type HeldCounts = Partial<Record<Holder, number>>;

/* Columns: whether anything holds the record (the same as the guard of its deletion), and how many of each do. */
export const inUseSql = (heldBy: HeldBy) =>
  `(${Object.values(heldBy)
    .map((from) => `EXISTS (SELECT 1 ${from})`)
    .join(' OR ')})`;
export const countsSql = (heldBy: HeldBy) =>
  Object.entries(heldBy)
    .map(([name, from]) => `(SELECT count(*) ${from}) AS ${name}`)
    .join(', ');

const remedy = (held: Holder[]) => {
  /* Students' forms and batches stay: deactivating is the only way. */
  if (held.includes('forms') || held.includes('batches')) return '';
  const children = held.length === 1 && (held[0] === 'districts' || held[0] === 'talukas') ? held[0] : null;
  return children ? `, or move or delete the ${children} first` : ', or remove those records first';
};

/* "1 center and 2 batches reference" */
export function heldText(counts: HeldCounts): string {
  const held = heldOf(counts);
  const parts = held.map((h) => `${counts[h]} ${HOLDERS[h][counts[h] === 1 ? 0 : 1]}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list} ${held.length === 1 && counts[held[0]!] === 1 ? 'references' : 'reference'}`;
}
const heldOf = (counts: HeldCounts) => (Object.keys(counts) as Holder[]).filter((h) => counts[h]);

/* A record that is still referenced is not deleted: 409, naming what holds it. */
export function assertNotHeld(label: string, counts: HeldCounts): void {
  const held = heldOf(counts);
  if (held.length)
    throw AppError.conflict(
      `This ${label} cannot be deleted while ${heldText(counts)} it. Deactivate it instead${remedy(held)}.`,
    );
}
