import { one, pool, rows } from '../../db/pool';
import { openReturn } from '../../program/returns';
import type { PanelUser } from '../../http/auth';
import { pageMeta } from '../../lib/paging';
import { APPROVAL_COLUMNS, APPROVAL_JOINS, approvalDto, approvalHistory, type ApprovalRow } from '../../program/approval';
import {
  APPLICATION_STAGES,
  APPROVAL_FILTERS,
  FOLLOW_UP_STATUS,
  STAGES,
  type ApprovalFilter,
  type FollowUpStatus,
  type Stage,
} from '../../program/constants';
import { allVerified, documentChecks, documentList, storedFiles } from '../../program/document-checks';
import { filterChoices, filterDto } from '../../program/filters';
import { referenceNames, viewFields } from '../../program/form';
import { loadProgram, shownName } from '../../program/masters';
import {
  aadhaarMasked,
  applicationOf,
  canEdit,
  formOf,
  lockedFields,
  studentAccount,
  type Application,
  type EditChange,
} from './common';
import { followUpDto } from './follow-ups.service';
import { countStudents, findStudents } from './students.repository';
import type { StudentListQuery } from './students.schemas';

/* What the Auditor sees of the students: the counts, the list with its filters, and one student in full. */

const zeros = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
const keysOf = <T extends string>(of: Record<T, string>) => Object.keys(of) as T[];

/* Students per stage, per current follow-up status (NONE = not followed up yet) and per approval; never narrowed by filters. */
export async function summary() {
  const counts = zeros<Stage>(keysOf(STAGES));
  const followUps = zeros<FollowUpStatus | 'NONE'>(['NONE', ...keysOf(FOLLOW_UP_STATUS)]);
  /* AWAITING = submitted, with the Auditor; RETURNED = of those, sent back. */
  const approvals = zeros<ApprovalFilter>(APPROVAL_FILTERS);
  let total = 0;
  for (const r of await countStudents()) {
    total += r.n;
    counts[r.stage] += r.n;
    followUps[r.follow_up] += r.n;
    if (r.approval) approvals[r.approval] += r.n;
    if (r.approval === 'RETURNED') approvals.AWAITING += r.n;
  }
  const stages = keysOf(STAGES).map((code) => ({ code, label: STAGES[code], count: counts[code] }));
  return { total, counts, stages, follow_ups: followUps, approvals };
}

/* The choices of the list's filters; a caste that is switched off is one too (forms may hold it). */
export async function filters() {
  const [choices, program] = await Promise.all([filterChoices(), loadProgram()]);
  return {
    ...choices,
    categories: program.allOf('CASTE').map((o) => ({ id: o.id, name: shownName(o) })),
    /* Also a switched-off one: forms that chose it can still be found. */
    technologies: program.allOf('TECHNOLOGY').map((o) => ({ id: o.id, name: shownName(o) })),
    stages: keysOf(APPLICATION_STAGES).map((code) => ({ code, label: APPLICATION_STAGES[code] })),
  };
}

export async function listStudents(q: StudentListQuery, trash = false) {
  const { items, total } = await findStudents(q, trash);
  return {
    items: items.map((r) => {
      const documents = { uploaded: r.uploaded, verified: r.verified };
      return {
        id: r.id,
        name: r.full_name,
        email: r.email,
        mobile_number: r.mobile,
        stage: r.stage,
        stage_label: STAGES[r.stage],
        account_created_at: r.created_at,
        otp_verified_at: r.verified_at,
        last_login_at: r.last_login_at,
        basic_completed_at: r.basic_completed_at,
        main_completed_at: r.main_completed_at,
        submitted_at: r.submitted_at,
        registration_id: r.registration_code,
        registration_number: r.registration_number,
        ...filterDto(r),
        centre_id: r.centre_id,
        documents,
        /* The student's own last activity; what the panel changes does not count. */
        last_activity_at: r.last_activity_at,
        follow_up: r.follow_up_status
          ? followUpDto({ status: r.follow_up_status, note: r.follow_up_note, created_at: r.follow_up_at!, by: r.follow_up_by })
          : null,
        /* Submitted, with the Auditor (not sent back to the candidate), every uploaded document verified. */
        can_approve: r.status === 'SUBMITTED' && !r.approval_stage && !r.returned_at && allVerified(documents),
        /* Sent back to the candidate to correct, not resubmitted yet (program/returns). */
        returned_at: r.returned_at,
        /* Not once the Auditor has approved the form (DELETE /manage/applicants/:id refuses it too). */
        can_delete: !r.auditor_approved,
        /* Approved and in no batch. */
        can_batch: r.approval_stage === 'BATCH' && !r.batch_id,
        approval: r.status === 'SUBMITTED' ? approvalDto(r) : null,
      };
    }),
    meta: pageMeta(q, total),
  };
}

/* What the Auditor changed on a form, newest first. */
const edits = (applicationId: string) =>
  rows<{ at: Date; by: string | null; changes: EditChange[] }>(
    `SELECT e.created_at AS at, coalesce(e.actor_name, u.name) AS by, e.changes
     FROM application_edits e LEFT JOIN panel_users u ON u.id = e.panel_user_id
     WHERE e.application_id = $1 ORDER BY e.seq DESC`,
    [applicationId],
  );

/* Where a form's approval is, its history, what was changed on it, and whether all its documents are verified. */
async function approvalOf(p: Application) {
  const [row, history, changes] = await Promise.all([
    one<ApprovalRow & { documents_verified_at: Date | null; documents_verified_by_name: string | null }>(
      `SELECT ${APPROVAL_COLUMNS}, p.documents_verified_at, dv.name AS documents_verified_by_name
       FROM applications p LEFT JOIN panel_users dv ON dv.id = p.documents_verified_by${APPROVAL_JOINS} WHERE p.id = $1`,
      [p.id],
    ),
    approvalHistory(p.id),
    edits(p.id),
  ]);
  return {
    documents_verified: {
      verified: !!row?.documents_verified_at,
      at: row?.documents_verified_at ?? null,
      by: row?.documents_verified_by_name ?? null,
    },
    approval: row && p.status === 'SUBMITTED' ? approvalDto(row) : null,
    history,
    edits: changes,
  };
}

/*
 * One student in full, at any stage: the form (the Aadhaar masked), its documents with their checks, where the approval is,
 * what the Auditor changed, and whether this account can change it. Without an application it reads as an empty draft.
 */
export async function student(accountId: string, user: PanelUser) {
  const account = await studentAccount(accountId);
  const [program, p] = await Promise.all([loadProgram(), applicationOf(accountId)]);
  const form = formOf(p, program);
  const masked = aadhaarMasked(p);
  if (program.field('email')?.isActive) form.email ||= account.email;
  const [names, files, check, rest, returned] = await Promise.all([
    referenceNames(program, form),
    p ? storedFiles(program, p.id) : [],
    p ? documentChecks(p.id) : () => ({ verified: false, at: null, by: null }),
    p ? approvalOf(p) : { documents_verified: { verified: false, at: null, by: null }, approval: null, history: [], edits: [] },
    p ? openReturn(pool, p.id) : null,
  ]);
  return {
    account: {
      id: account.id,
      name: account.full_name,
      email: account.email,
      mobile_number: account.mobile,
      created_at: account.created_at,
      email_verified_at: account.verified_at,
      last_login_at: account.last_login_at,
    },
    status: p?.status ?? 'DRAFT',
    steps: {
      basic_completed_at: p?.basic_completed_at ?? null,
      main_completed_at: p?.main_completed_at ?? null,
      submitted_at: p?.submitted_at ?? null,
    },
    registration: p?.registration_code
      ? { registration_id: p.registration_code, registration_number: p.registration_number }
      : null,
    aadhaar_masked: masked,
    form,
    display: names,
    view_fields: viewFields(program, form, names, masked),
    documents: documentList(program, files, check),
    ...rest,
    /* Not while the form is with the candidate to correct (program/returns): they change it then. */
    can_edit: user.role === 'ADMIN' && canEdit(p) && !returned,
    locked_fields: lockedFields(p),
    /* Sent back to the candidate, not resubmitted yet: { reason, by, at, email_status, … } (GET …/returns lists them all). */
    returned,
  };
}
