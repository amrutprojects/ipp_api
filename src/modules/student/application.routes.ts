import { once } from 'node:events';
import { pipeline } from 'node:stream';
import { Api } from '../../http/api';
import { studentOf } from '../../http/auth';
import { AppError } from '../../http/errors';
import { created, ok } from '../../http/respond';
import { uploadedFiles } from '../../http/upload';
import { docTypeParams, saveStepBody, stepParams, submitBody } from './application.schemas';
import { applicationService } from './application.service';
import { documentsService } from './documents.service';
import { submit } from './submission.service';

const APPLICATION = 'Application: the draft, or the submitted form';
const NO_FILE = 'No file has been uploaded for this document';

export const applicationApi = new Api('Student form');

applicationApi.get(
  '/application',
  { auth: 'student', summary: 'The student’s form (made on first use)', returns: APPLICATION },
  async ({ res }) => ok(res, await applicationService.get(studentOf(res))),
);

applicationApi.put(
  '/application/steps/:step',
  {
    auth: 'student',
    summary: 'Save step 1 or 2 as typed (autosave), or complete it (checked)',
    returns: APPLICATION,
    params: stepParams,
    body: saveStepBody,
  },
  async ({ res, params, body }) => {
    const step = params.step === '1' ? 1 : params.step === '2' ? 2 : null;
    if (!step) throw AppError.validation([{ field: 'params.step', message: 'The step must be 1 or 2' }]);
    ok(res, await applicationService.saveStep(studentOf(res), step, body), 'Saved');
  },
);

applicationApi.post(
  '/application/documents',
  {
    auth: 'student',
    summary: 'Upload documents of step 3 (each replaces the earlier file of its document)',
    returns: APPLICATION,
    upload: true,
  },
  async ({ req, res }) => ok(res, await documentsService.upload(studentOf(res), uploadedFiles(req)), 'Uploaded'),
);

applicationApi.delete(
  '/application/documents/:docType',
  {
    auth: 'student',
    summary: 'Remove an uploaded document from the draft',
    returns: APPLICATION,
    params: docTypeParams,
    notFound: NO_FILE,
  },
  async ({ res, params }) => ok(res, await documentsService.remove(studentOf(res), params.docType), 'Removed'),
);

applicationApi.get(
  '/application/documents/:docType/link',
  {
    auth: 'student',
    summary: 'A short-lived link to the student’s own file of a document, for a tab to open it straight away',
    returns: '{ url, expires_at }',
    params: docTypeParams,
    notFound: NO_FILE,
  },
  async ({ res, params }) => ok(res, await documentsService.link(studentOf(res), params.docType)),
);

applicationApi.get(
  '/application/documents/:docType/file',
  {
    auth: 'student',
    summary: 'The student’s own file of a document',
    params: docTypeParams,
    notFound: NO_FILE,
    file: 'application/octet-stream',
  },
  async ({ res, params }) => {
    const { stream, mimeType, name } = await documentsService.file(studentOf(res), params.docType);
    /* A file that cannot be read is an error answer, not a connection that breaks off. */
    await once(stream, 'readable');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    pipeline(stream, res, () => undefined);
  },
);

applicationApi.post(
  '/application/submit',
  {
    auth: 'student',
    status: 201,
    summary: 'Submit the form: final, once',
    returns: 'registration_id, registration_number and status',
    body: submitBody,
  },
  async ({ req, res }) => created(res, await submit(req, studentOf(res)), 'Your form has been submitted successfully'),
);
