import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { uploadedFiles } from '../../http/upload';
import { STUDENT_NOT_FOUND, studentParams } from './common';
import { editFormBody } from './corrections.schemas';
import { asPanel, editForm, uploadDocuments } from './corrections.service';
import { student } from './students.service';

export const correctionsApi = new Api('Panel: corrections');
const api = correctionsApi;

api.put(
  '/manage/applicants/:id/form',
  {
    auth: 'admin',
    summary: 'Corrects a submitted form (only the changed fields are sent) until its final approval',
    returns: 'ApplicantDetail',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
    body: editFormBody,
  },
  async ({ req, res, params, body }) => {
    const user = panelOf(res);
    await editForm(req, asPanel(user), params.id, body.data);
    ok(res, await student(params.id, user), 'Form saved');
  },
);

api.post(
  '/manage/applicants/:id/documents',
  {
    auth: 'admin',
    summary: 'Replaces or adds documents of a submitted form; a replaced one has to be verified again',
    returns: 'ApplicantDetail',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
    upload: true,
  },
  async ({ req, res, params }) => {
    const user = panelOf(res);
    await uploadDocuments(req, asPanel(user), params.id, uploadedFiles(req));
    ok(res, await student(params.id, user), 'Documents saved');
  },
);
