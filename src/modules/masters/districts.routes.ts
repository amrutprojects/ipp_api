import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { idParams } from './common.schemas';
import { by } from './common.service';
import { districtListQuery, newDistrictBody, updateDistrictBody } from './districts.schemas';
import { districtsService } from './districts.service';

/* Masters → Districts. */
export const districtsApi = new Api('Masters: districts');
const DISTRICT = 'District { id, name, code, state_id, state, talukas, is_active, in_use }';
const NOT_FOUND = 'District not found';

districtsApi.get(
  '/manage/districts',
  {
    auth: 'panel',
    summary: 'The districts A to Z, also the inactive ones (optional filters: status, state_id)',
    returns: `${DISTRICT}[]`,
    query: districtListQuery,
  },
  async ({ res, query }) => ok(res, await districtsService.list(query)),
);

districtsApi.post(
  '/manage/districts',
  {
    auth: 'admin',
    summary: 'Adds a district (without a code: made from the name; without a state: Maharashtra)',
    returns: DISTRICT,
    body: newDistrictBody,
    status: 201,
  },
  async (c) => created(c.res, await districtsService.create(by(c), c.body), 'District added'),
);

districtsApi.patch(
  '/manage/districts/:id',
  {
    auth: 'admin',
    summary: 'Renames a district, moves it to another state, switches it on or off',
    returns: DISTRICT,
    params: idParams,
    notFound: NOT_FOUND,
    body: updateDistrictBody,
  },
  async (c) => ok(c.res, await districtsService.update(by(c), c.params.id, c.body), 'District saved'),
);

districtsApi.delete(
  '/manage/districts/:id',
  {
    auth: 'admin',
    summary: "Deletes a district without talukas, centers, students' forms and batches (409 otherwise)",
    returns: 'null',
    params: idParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await districtsService.remove(by(c), c.params.id);
    ok(c.res, null, 'District deleted');
  },
);
