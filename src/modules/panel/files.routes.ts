import { z } from 'zod';
import { Api } from '../../http/api';
import { documentParams, given, STUDENT_NOT_FOUND, studentParams } from './common';
import { sendDocument, sendDocumentsZip } from './files.service';

export const filesApi = new Api('Panel: documents');
const api = filesApi;

api.get(
  '/manage/applicants/:id/documents/:docType/file',
  {
    auth: 'panel',
    summary: 'An uploaded document; ?download=1 = as a download named after the candidate',
    file: 'application/octet-stream',
    params: documentParams,
    notFound: STUDENT_NOT_FOUND,
    query: z.object({ download: given(z.enum(['0', '1']).optional()) }),
  },
  ({ res, params, query }) => sendDocument(res, params.id, params.docType, query.download === '1'),
);

api.get(
  '/manage/applicants/:id/documents.zip',
  {
    auth: 'panel',
    summary: 'All uploaded documents of a student as a ZIP of one folder',
    file: 'application/zip',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
  },
  ({ res, params }) => sendDocumentsZip(res, params.id),
);
