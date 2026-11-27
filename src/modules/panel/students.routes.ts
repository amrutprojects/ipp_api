import type { Request } from 'express';
import { Api } from '../../http/api';
import { one, transaction } from '../../db/pool';
import { AppError } from '../../http/errors';
import { audit } from '../../services/audit';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { STUDENT_NOT_FOUND, studentParams } from './common';
import { AUDITOR_APPROVED } from './students.repository';
import { studentListQuery } from './students.schemas';
import { filters, listStudents, student, summary } from './students.service';

export const studentsApi = new Api('Panel: students');
const api = studentsApi;

api.get(
  '/manage/summary',
  {
    auth: 'panel',
    summary: 'Students per stage, follow-up status and approval (never narrowed by filters)',
    returns: '{ total, counts, stages, follow_ups, approvals }',
  },
  async ({ res }) => ok(res, await summary()),
);

api.get(
  '/manage/filters',
  {
    auth: 'panel',
    summary: "The choices of the student list's filters",
    returns: '{ districts, categories, centres, stages }',
  },
  async ({ res }) => ok(res, await filters()),
);

api.get(
  '/manage/applicants',
  {
    auth: 'panel',
    summary: 'Every portal account, newest first, with its form, approval and latest follow-up',
    returns: 'Applicant[], with meta { page, limit, total, totalPages }',
    query: studentListQuery,
  },
  async ({ res, query }) => {
    const { items, meta } = await listStudents(query);
    ok(res, items, undefined, meta);
  },
);

api.get(
  '/manage/applicants/trash',
  { auth: 'panel', summary: 'Deleted management records', returns: 'Applicant[]', query: studentListQuery },
  async ({ res, query }) => {
    const { items, meta } = await listStudents(query, true);
    ok(res, items, undefined, meta);
  },
);

/* Approved by the Auditor once: the record stays, at every later stage and after the final approval too. */
export const APPROVED_NOT_DELETABLE =
  'This application has been approved by the Auditor, so it can no longer be deleted (also at the later approval stages).';

async function setTrashed(id: string, trash: boolean, req: Request, userId: string) {
  await transaction(async (db) => {
    if (trash) {
      const locked = await one<{ approved: boolean }>(
        `SELECT ${AUDITOR_APPROVED} AS approved FROM student_accounts a
         JOIN applications p ON p.account_id = a.id AND p.deleted_at IS NULL WHERE a.id = $1 FOR UPDATE OF a, p`,
        [id],
        db,
      );
      if (locked?.approved) throw AppError.conflict(APPROVED_NOT_DELETABLE, 'APPROVED_NOT_DELETABLE');
    }
    const row = await one<{ id: string }>(
      `UPDATE student_accounts SET manage_deleted_at = ${trash ? 'now()' : 'NULL'}
       WHERE id = $1 AND deleted_at IS NULL AND manage_deleted_at IS ${trash ? 'NULL' : 'NOT NULL'} RETURNING id`,
      [id], db,
    );
    if (!row) throw AppError.notFound(STUDENT_NOT_FOUND);
    await audit.inTx(db, req, { action: trash ? 'STUDENT_TRASHED' : 'STUDENT_RESTORED', resource: 'student_account', resourceId: id, actor: { kind: 'PANEL', id: userId } });
  });
}

api.delete(
  '/manage/applicants/:id',
  { auth: 'admin', summary: 'Move a record to trash (409 APPROVED_NOT_DELETABLE once the Auditor has approved its form)', returns: 'null', params: studentParams, notFound: STUDENT_NOT_FOUND },
  async ({ req, res, params }) => { await setTrashed(params.id, true, req, panelOf(res).id); ok(res, null, 'Record moved to trash'); },
);
api.post(
  '/manage/applicants/:id/restore',
  { auth: 'admin', summary: 'Restore a record from trash', returns: 'null', params: studentParams, notFound: STUDENT_NOT_FOUND },
  async ({ req, res, params }) => { await setTrashed(params.id, false, req, panelOf(res).id); ok(res, null, 'Record restored'); },
);

api.get(
  '/manage/applicants/:id',
  {
    auth: 'panel',
    summary: 'One student in full, at any stage',
    returns: 'ApplicantDetail',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
  },
  async ({ res, params }) => ok(res, await student(params.id, panelOf(res))),
);
