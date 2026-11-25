import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { retryBody } from './link.schemas';
import { linkStatus, retry, testLink } from './link.service';

export const linkPanelApi = new Api('Panel: connection to Sarthi');
const api = linkPanelApi;

api.get(
  '/manage/link',
  {
    auth: 'panel',
    summary: 'The connection to Sarthi: whether it is on, and the messages that are not sent, oldest first (at most 100)',
    returns:
      '{ enabled, configured, host, pending, failed, last_sent_at, last_received_at, items: { id, kind, batch, student, status, attempts, next_attempt_at, error, created_at }[] }',
  },
  async ({ res }) => ok(res, await linkStatus()),
);

api.post(
  '/manage/link/retry',
  {
    auth: 'admin',
    summary: 'Tries the given messages again now, those of a batch, or all that are not sent',
    returns: '{ retried }',
    body: retryBody,
  },
  async ({ req, res, body }) => {
    const result = await retry(req, panelOf(res), body);
    ok(res, result, result.retried ? `${result.retried} message(s) will be sent again` : 'Nothing is waiting to be sent');
  },
);

api.post(
  '/manage/link/test',
  { auth: 'admin', summary: 'Asks Sarthi whether the connection works', returns: '{ ok, message }' },
  async ({ res }) => ok(res, await testLink()),
);
