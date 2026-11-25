import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { STUDENT_NOT_FOUND, studentParams } from './common';
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
