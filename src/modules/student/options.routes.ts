import { Api } from '../../http/api';
import { ok } from '../../http/respond';
import { options } from './options.service';

export const optionsApi = new Api('Student form');

optionsApi.get(
  '/options',
  {
    auth: 'public',
    summary: 'What the form is made of: fields, choices, districts, centers, technologies, documents and the portal texts',
    returns: 'Options',
  },
  async ({ res }) => ok(res, await options()),
);
