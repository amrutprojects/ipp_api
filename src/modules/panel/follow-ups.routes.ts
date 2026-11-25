import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { created, ok } from '../../http/respond';
import { STUDENT_NOT_FOUND, studentParams } from './common';
import { followUpBody } from './follow-ups.schemas';
import { addFollowUp, followUps } from './follow-ups.service';

export const followUpsApi = new Api('Panel: follow-ups');
const api = followUpsApi;

api.get(
  '/manage/applicants/:id/follow-ups',
  {
    auth: 'panel',
    summary: "A student's follow-ups, newest first",
    returns: 'FollowUp[]',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
  },
  async ({ res, params }) => ok(res, await followUps(params.id)),
);

api.post(
  '/manage/applicants/:id/follow-ups',
  {
    auth: 'admin',
    summary: 'Records a follow-up',
    returns: 'FollowUp[]: the whole history, newest first',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
    body: followUpBody,
    status: 201,
  },
  async ({ req, res, params, body }) => created(res, await addFollowUp(req, panelOf(res), params.id, body), 'Follow-up saved'),
);
