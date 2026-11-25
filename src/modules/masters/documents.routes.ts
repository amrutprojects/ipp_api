import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { idParams } from './common.schemas';
import { by } from './common.service';
import { newDocumentBody, updateDocumentBody } from './documents.schemas';
import { documentsService } from './documents.service';

/* Masters → Documents: what students upload in step 3. */
export const documentsApi = new Api('Masters: documents');
const DOCUMENT = 'MasterDocument { id, code, name_en, name_mr, required, is_active, is_system, kind, order, in_use }';
const NOT_FOUND = 'Document not found';

documentsApi.get(
  '/manage/documents',
  { auth: 'panel', summary: 'The documents of step 3, also the switched-off ones', returns: `${DOCUMENT}[]` },
  async ({ res }) => ok(res, await documentsService.list()),
);

documentsApi.post(
  '/manage/documents',
  { auth: 'admin', summary: 'Adds a document (code IPP_DOC_<n>)', returns: DOCUMENT, body: newDocumentBody, status: 201 },
  async (c) => created(c.res, await documentsService.create(by(c), c.body), 'Document added'),
);

documentsApi.patch(
  '/manage/documents/:id',
  {
    auth: 'admin',
    summary: 'Renames or orders a document, makes it optional, switches it on or off',
    returns: DOCUMENT,
    params: idParams,
    notFound: NOT_FOUND,
    body: updateDocumentBody,
  },
  async (c) => ok(c.res, await documentsService.update(by(c), c.params.id, c.body), 'Document saved'),
);

documentsApi.delete(
  '/manage/documents/:id',
  {
    auth: 'admin',
    summary: 'Deletes an added document; files already uploaded for it stay with their forms',
    returns: 'null',
    params: idParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await documentsService.remove(by(c), c.params.id);
    ok(c.res, null, 'Document deleted');
  },
);
