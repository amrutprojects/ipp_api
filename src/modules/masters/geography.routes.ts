import { z } from 'zod';
import { Api } from '../../http/api';
import { ok } from '../../http/respond';
import { uuid } from '../../lib/text';
import { geographyService } from './geography.service';

/* The choices of the Center form and of Add district (the portal asks for them without a token). */
export const geographyApi = new Api('Geography');

geographyApi.get(
  '/geography/states',
  { auth: 'public', summary: 'The active states, A to Z', returns: '{ id, name, code }[]' },
  async ({ res }) => ok(res, await geographyService.states(), 'States retrieved successfully'),
);

geographyApi.get(
  '/geography/states/:stateId/districts',
  {
    auth: 'public',
    summary: 'The active districts of a state, A to Z',
    returns: '{ id, name, code, stateId }[]',
    params: z.object({ stateId: uuid() }),
    notFound: 'State not found',
  },
  async ({ res, params }) => ok(res, await geographyService.districts(params.stateId), 'Districts retrieved successfully'),
);

geographyApi.get(
  '/geography/districts/:districtId/talukas',
  {
    auth: 'public',
    summary: 'The active talukas of a district, A to Z',
    returns: '{ id, name, code (may be null), districtId }[]',
    params: z.object({ districtId: uuid() }),
    notFound: 'District not found',
  },
  async ({ res, params }) => ok(res, await geographyService.talukas(params.districtId), 'Talukas retrieved successfully'),
);
