import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { idParams } from './common.schemas';
import { by } from './common.service';
import { newTalukaBody, talukaListQuery, updateTalukaBody } from './talukas.schemas';
import { talukasService } from './talukas.service';

/* Masters → Talukas. */
export const talukasApi = new Api('Masters: talukas');
const TALUKA = 'Taluka { id, name, code, district_id, district, is_active, in_use }';
const NOT_FOUND = 'Taluka not found';

talukasApi.get(
  '/manage/talukas',
  {
    auth: 'panel',
    summary: 'The talukas by district and name (search in name, code and district; filters: status, district_id)',
    returns: `${TALUKA}[], with paging`,
    query: talukaListQuery,
  },
  async ({ res, query }) => {
    const { items, meta } = await talukasService.list(query);
    ok(res, items, undefined, meta);
  },
);

talukasApi.post(
  '/manage/talukas',
  { auth: 'admin', summary: 'Adds a taluka to a district', returns: TALUKA, body: newTalukaBody, status: 201 },
  async (c) => created(c.res, await talukasService.create(by(c), c.body), 'Taluka added'),
);

talukasApi.patch(
  '/manage/talukas/:id',
  {
    auth: 'admin',
    summary: 'Renames a taluka, moves it to another district (not while centers use it), switches it on or off',
    returns: TALUKA,
    params: idParams,
    notFound: NOT_FOUND,
    body: updateTalukaBody,
  },
  async (c) => ok(c.res, await talukasService.update(by(c), c.params.id, c.body), 'Taluka saved'),
);

talukasApi.delete(
  '/manage/talukas/:id',
  {
    auth: 'admin',
    summary: 'Deletes a taluka no center uses (409 otherwise)',
    returns: 'null',
    params: idParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await talukasService.remove(by(c), c.params.id);
    ok(c.res, null, 'Taluka deleted');
  },
);
