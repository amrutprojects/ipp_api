import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { idParams } from './common.schemas';
import { by } from './common.service';
import { newFieldBody, testValidationBody, updateFieldBody } from './fields.schemas';
import { fieldsService } from './fields.service';

/* Masters → Form fields: what steps 1 and 2 ask, and under which names. */
export const fieldsApi = new Api('Masters: form fields');
const FIELD =
  'MasterField { id, key, step, label_en, label_mr, required, is_active, order, custom, by_type, type, types, options_kind, help_en, help_mr, validation }';
const NOT_FOUND = 'Field not found';

fieldsApi.get(
  '/manage/fields',
  { auth: 'panel', summary: 'The fields of steps 1 and 2, also the switched-off ones', returns: `${FIELD}[]` },
  async ({ res }) => ok(res, await fieldsService.list()),
);

fieldsApi.post(
  '/manage/fields',
  {
    auth: 'admin',
    summary: 'Adds an own field (key x_…), a dropdown with its choices',
    returns: FIELD,
    body: newFieldBody,
    status: 201,
  },
  async (c) => created(c.res, await fieldsService.create(by(c), c.body), 'Field added'),
);

fieldsApi.post(
  '/manage/fields/test-validation',
  {
    auth: 'admin',
    summary: 'Tries the checks of a field on a value, before they are saved',
    returns: '{ valid, messages }',
    body: testValidationBody,
  },
  async (c) => ok(c.res, await fieldsService.testValidation(c.body), 'Checked'),
);

fieldsApi.patch(
  '/manage/fields/:id',
  {
    auth: 'admin',
    summary:
      'Changes a field, also one of the program: labels, help texts, order, step, type (one of types), checks, required, active',
    returns: FIELD,
    params: idParams,
    notFound: NOT_FOUND,
    body: updateFieldBody,
  },
  async (c) => ok(c.res, await fieldsService.update(by(c), c.params.id, c.body), 'Field saved'),
);

fieldsApi.delete(
  '/manage/fields/:id',
  {
    auth: 'admin',
    summary: 'Deletes an own field; answers already given stay stored with their forms',
    returns: 'null',
    params: idParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await fieldsService.remove(by(c), c.params.id);
    ok(c.res, null, 'Field deleted');
  },
);
