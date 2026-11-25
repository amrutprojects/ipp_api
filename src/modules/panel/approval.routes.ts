import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { approveSelectedBody, verifyDocumentBody } from './approval.schemas';
import { approve, approveSelected, verifyDocument } from './approval.service';
import { documentParams, STUDENT_NOT_FOUND, studentParams } from './common';

export const approvalApi = new Api('Panel: verification and approval');
const api = approvalApi;

api.post(
  '/manage/applicants/approve-selected',
  {
    auth: 'admin',
    summary: 'Approves the selected forms; one that cannot be approved is skipped',
    returns: '{ approved, skipped }',
    body: approveSelectedBody,
  },
  async ({ req, res, body }) => {
    const result = await approveSelected(req, panelOf(res), body.ids);
    ok(
      res,
      result,
      result.approved ? `${result.approved} form(s) approved` : 'None of the selected forms was waiting for approval',
    );
  },
);

api.post(
  '/manage/applicants/:id/approve',
  {
    auth: 'admin',
    summary: 'Approves one submitted form whose uploaded documents are all verified (409 says why not)',
    returns: '{ approved: 1 }',
    params: studentParams,
    notFound: STUDENT_NOT_FOUND,
  },
  async ({ req, res, params }) => ok(res, await approve(req, panelOf(res), params.id), 'Form approved'),
);

api.post(
  '/manage/applicants/:id/documents/:docType/verify',
  {
    auth: 'admin',
    summary: 'Marks an uploaded document as verified, or takes the mark back',
    returns: '{ verified, at, by, documents: { uploaded, verified } }',
    params: documentParams,
    notFound: STUDENT_NOT_FOUND,
    body: verifyDocumentBody,
  },
  async ({ req, res, params, body }) =>
    ok(
      res,
      await verifyDocument(req, panelOf(res), params.id, params.docType, body.verified),
      body.verified ? 'Document marked as verified' : 'Document marked as not verified',
    ),
);
