import { Api } from '../../http/api';
import { created, ok } from '../../http/respond';
import { centreListQuery, centreStatusBody, newCentreBody, updateCentreBody } from './centres.schemas';
import { centresService } from './centres.service';
import { idParams } from './common.schemas';
import { by } from './common.service';

/* Center Master. Its keys are camelCase, as the portal's Center pages read them. */
export const centresApi = new Api('Center Master');
const CENTRE =
  'Centre { id, name, code, stateId, stateName, stateCode, stateIsActive, districtId, districtName, districtCode, districtIsActive, ' +
  'talukaId, talukaName, talukaCode, talukaIsActive, address, pinCode, contactPerson, contactNumber, email, technologies (empty), ' +
  'isActive, createdAt, updatedAt }';
const NOT_FOUND = 'Center not found';

centresApi.get(
  '/manage/centres',
  {
    auth: 'panel',
    summary: 'The centers (search in name, code and district; filters: isActive, stateId, districtId)',
    returns: `${CENTRE}[], with paging`,
    query: centreListQuery,
  },
  async ({ res, query }) => {
    const { items, meta } = await centresService.list(query);
    ok(res, items, 'Centers retrieved successfully', meta);
  },
);

centresApi.post(
  '/manage/centres',
  { auth: 'admin', summary: 'Adds a center', returns: CENTRE, body: newCentreBody, status: 201 },
  async (c) => created(c.res, await centresService.create(by(c), c.body), 'Center created successfully'),
);

centresApi.get(
  '/manage/centres/:id',
  { auth: 'panel', summary: 'One center', returns: CENTRE, params: idParams, notFound: NOT_FOUND },
  async ({ res, params }) => ok(res, await centresService.get(params.id)),
);

centresApi.patch(
  '/manage/centres/:id',
  {
    auth: 'admin',
    summary: 'Changes a center (null clears an optional value)',
    returns: CENTRE,
    params: idParams,
    notFound: NOT_FOUND,
    body: updateCentreBody,
  },
  async (c) => ok(c.res, await centresService.update(by(c), c.params.id, c.body), 'Center updated successfully'),
);

centresApi.patch(
  '/manage/centres/:id/status',
  {
    auth: 'admin',
    summary: 'Activates or deactivates a center (only active ones are offered to students and for batches)',
    returns: CENTRE,
    params: idParams,
    notFound: NOT_FOUND,
    body: centreStatusBody,
  },
  async (c) => {
    const centre = await centresService.setStatus(by(c), c.params.id, c.body.isActive);
    ok(c.res, centre, c.body.isActive ? 'Center activated' : 'Center deactivated');
  },
);

centresApi.delete(
  '/manage/centres/:id',
  {
    auth: 'admin',
    summary: "Deletes a center no student's form and no batch uses (409 otherwise)",
    returns: 'null',
    params: idParams,
    notFound: NOT_FOUND,
  },
  async (c) => {
    await centresService.remove(by(c), c.params.id);
    ok(c.res, null, 'Center deleted');
  },
);
