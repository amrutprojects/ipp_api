import { one, rows } from '../../db/pool';
import { offset } from '../../lib/paging';
import { APPROVAL_COLUMNS, APPROVAL_JOINS, type ApprovalRow } from '../../program/approval';
import { STAGES, type ApprovalFilter, type FollowUpStatus, type Stage } from '../../program/constants';
import { DOCUMENT_COUNTS } from '../../program/document-checks';
import { FILTER_COLUMNS, FILTER_JOINS, filterSql, type FilterRow } from '../../program/filters';
import type { StudentListQuery } from './students.schemas';

/* The SQL of the student list and its counts, over student_accounts `a` and its application `p` (may be missing). */

const APPLICATION = `LEFT JOIN applications p ON p.account_id = a.id AND p.deleted_at IS NULL`;
const PEOPLE = `student_accounts a ${APPLICATION}`;

/* How far each student got: the first that is true. */
const STAGE = `CASE
  WHEN a.verified_at IS NULL THEN 'OTP_PENDING'
  WHEN p.status = 'SUBMITTED' THEN 'SUBMITTED'
  WHEN p.main_completed_at IS NOT NULL THEN 'MAIN_DONE'
  WHEN p.basic_completed_at IS NOT NULL THEN 'BASIC_DONE'
  ELSE 'VERIFIED' END`;

/* With the Auditor; of those, sent back by the Divisional Officer (the latest event is a rejection). */
const AWAITING = `p.status = 'SUBMITTED' AND p.approval_stage IS NULL`;
const SENT_BACK = `(SELECT e.action FROM approval_events e WHERE e.application_id = p.id ORDER BY e.seq DESC LIMIT 1) = 'REJECT'`;

/* A follow-up status is the one of the latest follow-up. */
const FOLLOW_UP = `(SELECT f.status FROM follow_ups f WHERE f.account_id = a.id ORDER BY f.seq DESC LIMIT 1)`;

function approvalSql(filter: ApprovalFilter, add: (v: unknown) => string): string {
  if (filter === 'AWAITING') return ` AND ${AWAITING}`;
  if (filter === 'RETURNED') return ` AND ${AWAITING} AND ${SENT_BACK}`;
  return ` AND p.approval_stage = ${add(filter)}`;
}

const isStage = (v: string): v is Stage => v in STAGES;

function conditions(q: StudentListQuery, params: unknown[]): string {
  const add = (v: unknown) => `$${params.push(v)}`;
  let where = filterSql(q, params);
  const at = q.application_stage;
  if (at && isStage(at)) where += ` AND ${STAGE} = ${add(at)}`;
  else if (at) where += approvalSql(at === 'AUDITOR' ? 'AWAITING' : at, add);
  if (q.stage) where += ` AND ${STAGE} = ${add(q.stage)}`;
  if (q.approval) where += approvalSql(q.approval, add);
  if (q.follow_up === 'NONE') where += ` AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.account_id = a.id)`;
  else if (q.follow_up) where += ` AND ${FOLLOW_UP} = ${add(q.follow_up)}`;
  return where;
}

export interface StudentRow extends ApprovalRow, FilterRow {
  id: string;
  full_name: string;
  email: string;
  mobile: string;
  stage: Stage;
  created_at: Date;
  verified_at: Date | null;
  last_login_at: Date | null;
  status: 'DRAFT' | 'SUBMITTED' | null;
  basic_completed_at: Date | null;
  main_completed_at: Date | null;
  submitted_at: Date | null;
  centre_id: string | null;
  registration_number: string | null;
  last_activity_at: Date;
  uploaded: number;
  verified: number;
  follow_up_status: FollowUpStatus | null;
  follow_up_note: string | null;
  follow_up_at: Date | null;
  follow_up_by: string | null;
}

/*
 * One page of students, and how many there are. The page's accounts are chosen first; everything else is read for them alone,
 * so a page far down the list costs no more than the first.
 */
export async function findStudents(q: StudentListQuery): Promise<{ items: StudentRow[]; total: number }> {
  const params: unknown[] = [];
  const where = conditions(q, params);
  const order = `a.created_at ${q.sortOrder === 'ASC' ? 'ASC' : 'DESC'}, a.id`;
  const pageParams = [...params];
  const limit = `LIMIT $${pageParams.push(q.limit)} OFFSET $${pageParams.push(offset(q))}`;
  const [count, items] = await Promise.all([
    one<{ total: number }>(`SELECT count(*)::int AS total FROM ${PEOPLE} WHERE a.deleted_at IS NULL${where}`, params),
    rows<StudentRow>(
      `WITH page AS MATERIALIZED (
         SELECT a.id FROM ${PEOPLE} WHERE a.deleted_at IS NULL${where} ORDER BY ${order} ${limit}
       )
       SELECT a.id, a.full_name, a.email, a.mobile, ${STAGE} AS stage, a.created_at, a.verified_at, a.last_login_at,
              p.status, p.basic_completed_at, p.main_completed_at, p.submitted_at, p.centre_id, p.registration_number,
              greatest(a.created_at, a.verified_at, a.last_login_at, p.student_active_at) AS last_activity_at,
              dc.uploaded, dc.verified,
              fu.status AS follow_up_status, fu.note AS follow_up_note, fu.created_at AS follow_up_at, fu.by AS follow_up_by,
              ${FILTER_COLUMNS}, ${APPROVAL_COLUMNS}
       FROM page JOIN student_accounts a ON a.id = page.id ${APPLICATION}
       ${FILTER_JOINS}${APPROVAL_JOINS}${DOCUMENT_COUNTS}
       LEFT JOIN LATERAL (
         SELECT f.status, f.note, f.created_at, u.name AS by
         FROM follow_ups f LEFT JOIN panel_users u ON u.id = f.panel_user_id
         WHERE f.account_id = a.id ORDER BY f.seq DESC LIMIT 1
       ) fu ON true
       ORDER BY ${order}`,
      pageParams,
    ),
  ]);
  return { items, total: count!.total };
}

export interface SummaryRow {
  stage: Stage;
  follow_up: FollowUpStatus | 'NONE';
  /* null = not submitted. */
  approval: ApprovalFilter | null;
  n: number;
}

/* Every student, counted by stage, follow-up status and approval together. */
export const countStudents = () =>
  rows<SummaryRow>(
    `SELECT ${STAGE} AS stage, coalesce(fu.status, 'NONE') AS follow_up,
            CASE WHEN p.status = 'SUBMITTED' THEN
              coalesce(p.approval_stage, CASE WHEN ${SENT_BACK} THEN 'RETURNED' ELSE 'AWAITING' END) END AS approval,
            count(*)::int AS n
     FROM ${PEOPLE}
     LEFT JOIN (SELECT DISTINCT ON (account_id) account_id, status FROM follow_ups ORDER BY account_id, seq DESC) fu
       ON fu.account_id = a.id
     WHERE a.deleted_at IS NULL GROUP BY 1, 2, 3`,
  );
