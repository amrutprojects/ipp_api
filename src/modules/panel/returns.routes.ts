import { z } from 'zod';
import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { content } from '../../lib/text';
import { STUDENT_NOT_FOUND, studentParams } from './common';
import { returnsOfStudent, returnToCandidate } from './returns.service';

export const returnsApi = new Api('Panel: forms sent back to the candidate');
const api = returnsApi;

/* Why the form goes back: the candidate reads it in the e-mail and on the portal. */
const returnBody = z.object({ reason: content('Reason', 500, 3) }).strict();

api.post(
  '/manage/applicants/:id/return',
  {
    auth: 'admin',
    summary:
      'Sends a submitted form that is with the Auditor back to the candidate with the reason (3–500 characters), and e-mails them; only while "Enable Rejection Email Notification and Resubmission" is on (409 REJECTION_OFF)',
    returns: "{ email: 'SENT' | 'FAILED' | 'NOT_SENT' }",
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
    body: returnBody,
  },
  async ({ req, res, params, body }) => {
    const result = await returnToCandidate(req, panelOf(res), params.id, body.reason);
    ok(
      res,
      result,
      result.email === 'FAILED'
        ? 'Form sent back to the candidate, but the e-mail could not be sent'
        : 'Form sent back to the candidate',
    );
  },
);

api.get(
  '/manage/applicants/:id/returns',
  {
    auth: 'panel',
    summary: 'The times the form was sent back to the candidate (latest first), the open one, and whether it can be sent back now',
    returns: '{ enabled, open, can_return, returns: { seq, reason, by, at, email_status, email_at, resubmitted_at }[] }',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
  },
  async ({ res, params }) => ok(res, await returnsOfStudent(params.id)),
);
