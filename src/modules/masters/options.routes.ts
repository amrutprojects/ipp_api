import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { by } from './common.service';
import { kindParams, newOptionBody, optionListQuery, optionParams, updateOptionBody } from './options.schemas';
import { optionsService } from './options.service';

/* Masters → Dropdown lists (and Technologies, and the choices of an own dropdown field). */
export const optionsApi = new Api('Masters: dropdown lists');
const OPTION = 'MasterOption { id, value, code, name_en, name_mr, order, is_active, is_system, in_use }';
const NOT_FOUND = 'Entry not found in this list';

optionsApi.get(
  '/manage/masters',
  {
    auth: 'panel',
    summary: 'The dropdown lists of the form, with how many entries each has',
    returns: 'MasterKind[] { kind, name, count, active, can_add, can_delete, stored_as }',
  },
  async ({ res }) => ok(res, await optionsService.kinds()),
);

optionsApi.get(
  '/manage/masters/:kind',
  {
    auth: 'panel',
    summary: 'The choices of a list (CASTE, GENDER, …, or FIELD:<key> of an own dropdown field)',
    returns: `${OPTION}[], with paging`,
    params: kindParams,
    notFound: 'List not found',
    query: optionListQuery,
  },
  async ({ res, params, query }) => {
    const { items, meta } = await optionsService.list(params.kind, query);
    ok(res, items, undefined, meta);
  },
);

optionsApi.post(
  '/manage/masters/:kind',
  {
    auth: 'admin',
    summary: 'Adds a choice to a list',
    returns: OPTION,
    params: kindParams,
    notFound: 'List not found',
    body: newOptionBody,
    status: 201,
  },
  async (c) => created(c.res, await optionsService.create(by(c), c.params.kind, c.body), 'Added'),
);

optionsApi.patch(
  '/manage/masters/:kind/:id',
  {
    auth: 'admin',
    summary: 'Renames, orders or switches a choice on or off; what forms store stays the same',
    returns: OPTION,
    params: optionParams,
    notFound: NOT_FOUND,
    body: updateOptionBody,
  },
  async (c) => ok(c.res, await optionsService.update(by(c), c.params.kind, c.params.id, c.body), 'Saved'),
);

optionsApi.delete(
  '/manage/masters/:kind/:id',
  {
    auth: 'admin',
    summary: 'Deletes a choice; forms that hold it still show its name',
    returns: 'null',
    params: optionParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await optionsService.remove(by(c), c.params.kind, c.params.id);
    ok(c.res, null, 'Deleted');
  },
);
