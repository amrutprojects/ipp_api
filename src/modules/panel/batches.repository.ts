import { one, pool, rows, type Db } from '../../db/pool';
import { contains, offset } from '../../lib/paging';
import { APPROVAL_COLUMNS, APPROVAL_JOINS, type ApprovalRow } from '../../program/approval';
import type { ApprovalStage, DeliveryMode } from '../../program/constants';
import { DOCUMENT_COUNTS, type DocumentCounts } from '../../program/document-checks';
import { FILTER_COLUMNS, FILTER_JOINS, type FilterRow } from '../../program/filters';
import type { BatchListQuery } from './batches.schemas';

/* The SQL of the batches and their students. */

export interface BatchRow {
  id: string;
  code: string;
  name: string;
  centre_id: string;
  centre_name: string;
  centre_code: string;
  district_id: string;
  district_name: string;
  size: number;
  start_date: string | null;
  end_date: string | null;
  delivery_mode: DeliveryMode;
  technology_id: string | null;
  technology_code: string | null;
  technology_name: string | null;
  other_centre: number;
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  updated_by: string | null;
}

const FROM = `FROM batches b
  JOIN centres c ON c.id = b.centre_id
  JOIN districts d ON d.id = b.district_id
  LEFT JOIN program_options t ON t.id = b.technology_id
  LEFT JOIN panel_users cu ON cu.id = b.created_by
  LEFT JOIN panel_users uu ON uu.id = b.updated_by
  WHERE b.deleted_at IS NULL`;

const SELECT = `SELECT b.id, b.code, b.name, b.centre_id, c.name AS centre_name, c.code AS centre_code,
    b.district_id, d.name AS district_name, b.size, b.start_date, b.end_date, b.delivery_mode,
    b.technology_id, t.code AS technology_code, t.name_en AS technology_name,
    (SELECT count(*)::int FROM applications p
     WHERE p.batch_id = b.id AND p.deleted_at IS NULL AND p.centre_id <> b.centre_id) AS other_centre,
    b.created_at, cu.name AS created_by, b.updated_at, uu.name AS updated_by
  ${FROM}`;

export async function findBatches(q: BatchListQuery): Promise<{ items: BatchRow[]; total: number }> {
  const params: unknown[] = [];
  let where = '';
  if (q.search) {
    const n = `$${params.push(contains(q.search))}`;
    where = ` AND (b.name ILIKE ${n} OR b.code ILIKE ${n} OR c.name ILIKE ${n} OR c.code ILIKE ${n} OR d.name ILIKE ${n})`;
  }
  const order = `${q.sortBy === 'name' ? 'lower(b.name)' : 'b.created_at'} ${q.sortOrder === 'ASC' ? 'ASC' : 'DESC'}, b.id`;
  const pageParams = [...params];
  const limit = `LIMIT $${pageParams.push(q.limit)} OFFSET $${pageParams.push(offset(q))}`;
  const [count, items] = await Promise.all([
    one<{ total: number }>(`SELECT count(*)::int AS total ${FROM}${where}`, params),
    rows<BatchRow>(`${SELECT}${where} ORDER BY ${order} ${limit}`, pageParams),
  ]);
  return { items, total: count!.total };
}

export const findBatch = (id: string, db: Db = pool) => one<BatchRow>(`${SELECT} AND b.id = $1`, [id], db);

/* The batch, locked; null = there is none. */
export const lockBatch = (id: string, db: Db) =>
  one<{ id: string }>(`SELECT id FROM batches WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], db);

export interface MemberRow extends FilterRow, ApprovalRow {
  id: string;
  full_name: string;
  email: string;
  mobile: string;
  centre_id: string | null;
  technology: string | null;
}

/* The students of a batch, by name. */
export const findMembers = (batchId: string, db: Db = pool) =>
  rows<MemberRow>(
    `SELECT a.id, a.full_name, a.email, a.mobile, p.centre_id, p.data ->> 'technology' AS technology,
            ${FILTER_COLUMNS}, ${APPROVAL_COLUMNS}
     FROM applications p JOIN student_accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
     ${FILTER_JOINS}${APPROVAL_JOINS}
     WHERE p.batch_id = $1 AND p.deleted_at IS NULL ORDER BY a.first_name, a.last_name, a.id`,
    [batchId],
    db,
  );

export interface CandidateRow extends DocumentCounts {
  id: string;
  approval_stage: ApprovalStage | null;
  batch_id: string | null;
  /* null = the form has none. */
  district_id: string | null;
  district: string | null;
}

/* The forms of the students selected for a batch, locked in one order, then read as they are. */
export async function lockCandidates(accountIds: string[], db: Db): Promise<CandidateRow[]> {
  const locked = await rows<{ id: string }>(
    `SELECT p.id FROM applications p JOIN student_accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
     WHERE p.account_id = ANY($1::uuid[]) AND p.deleted_at IS NULL ORDER BY p.id FOR UPDATE OF p`,
    [accountIds],
    db,
  );
  return rows<CandidateRow>(
    `SELECT p.id, p.approval_stage, p.batch_id, dd.id AS district_id, dd.name AS district, dc.uploaded, dc.verified
     FROM applications p LEFT JOIN districts dd ON dd.id = p.district_id${DOCUMENT_COUNTS}
     WHERE p.id = ANY($1::uuid[])`,
    [locked.map((p) => p.id)],
    db,
  );
}
