import { Api } from '../../http/api';
import { ok } from '../../http/respond';
import { by } from './common.service';
import { districtParams, districtTechnologiesBody } from './technologies.schemas';
import { technologiesService } from './technologies.service';

/* Masters → Technologies: which ones are offered in which district. */
export const technologiesApi = new Api('Masters: technologies');
const DISTRICT = 'DistrictTechnologies { district_id, district, all, codes }';

technologiesApi.get(
  '/manage/technologies/districts',
  {
    auth: 'panel',
    summary: 'The active districts, with the technologies selected for each (all = every active one)',
    returns: `${DISTRICT}[]`,
  },
  async ({ res }) => ok(res, await technologiesService.list()),
);

technologiesApi.put(
  '/manage/technologies/districts/:districtId',
  {
    auth: 'admin',
    summary: 'Replaces the technologies selected for a district (none = all)',
    returns: DISTRICT,
    params: districtParams,
    notFound: 'District not found',
    body: districtTechnologiesBody,
  },
  async (c) => ok(c.res, await technologiesService.save(by(c), c.params.districtId, c.body), 'Saved'),
);
