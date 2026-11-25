import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { idParams } from './common.schemas';
import { by } from './common.service';
import { newStateBody, updateStateBody } from './states.schemas';
import { statesService } from './states.service';

/* Masters → States. */
export const statesApi = new Api('Masters: states');
const STATE = 'State { id, name, code, districts, is_active, in_use }';
const NOT_FOUND = 'State not found';

statesApi.get(
  '/manage/states',
  { auth: 'panel', summary: 'Every state, also the inactive ones, A to Z', returns: `${STATE}[]` },
  async ({ res }) => ok(res, await statesService.list()),
);

statesApi.post(
  '/manage/states',
  { auth: 'admin', summary: 'Adds a state', returns: STATE, body: newStateBody, status: 201 },
  async (c) => created(c.res, await statesService.create(by(c), c.body), 'State added'),
);

statesApi.patch(
  '/manage/states/:id',
  {
    auth: 'admin',
    summary: 'Renames a state, switches it on or off',
    returns: STATE,
    params: idParams,
    notFound: NOT_FOUND,
    body: updateStateBody,
  },
  async (c) => ok(c.res, await statesService.update(by(c), c.params.id, c.body), 'State saved'),
);

statesApi.delete(
  '/manage/states/:id',
  {
    auth: 'admin',
    summary: 'Deletes a state without districts (409 otherwise)',
    returns: 'null',
    params: idParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await statesService.remove(by(c), c.params.id);
    ok(c.res, null, 'State deleted');
  },
);
