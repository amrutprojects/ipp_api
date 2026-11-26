import { Api } from '../../http/api';
import { studentOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { uploadedFiles } from '../../http/upload';
import { editFormBody } from '../panel/corrections.schemas';
import { applicationService } from './application.service';
import { correctDocuments, correctForm, resubmit } from './resubmission.service';

const APPLICATION = 'Application: the submitted form, with `returned` while it is with the candidate';

/* The candidate corrects a form the Auditor sent back to them, and resubmits it (program/returns). 409 NOT_RETURNED otherwise. */
export const resubmissionApi = new Api('Student form: correcting a form sent back');
const api = resubmissionApi;

api.put(
  '/application/correction',
  {
    auth: 'student',
    summary: 'Saves the changed values of a form sent back for correction (the e-mail ID cannot change; checked as now)',
    returns: APPLICATION,
    body: editFormBody,
  },
  async ({ req, res, body }) => {
    const account = studentOf(res);
    await correctForm(req, account, body.data);
    ok(res, await applicationService.get(account), 'Changes saved');
  },
);

api.post(
  '/application/correction/documents',
  {
    auth: 'student',
    summary: 'Replaces or adds documents of a form sent back for correction (each is verified again by the Auditor)',
    returns: APPLICATION,
    upload: true,
  },
  async ({ req, res }) => {
    const account = studentOf(res);
    await correctDocuments(req, account, uploadedFiles(req));
    ok(res, await applicationService.get(account), 'Document saved');
  },
);

api.post(
  '/application/resubmit',
  {
    auth: 'student',
    summary: 'Sends the corrected form back to the Auditor (the whole form and its required documents are checked)',
    returns: APPLICATION,
  },
  async ({ req, res }) => {
    const account = studentOf(res);
    await resubmit(req, account);
    ok(res, await applicationService.get(account), 'Your form has been sent back to the Auditor');
  },
);
