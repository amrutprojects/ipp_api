import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { created, ok } from '../../http/respond';
import { loginBody, newUserBody, userParams, userStatusBody } from './users.schemas';
import { addUser, listUsers, login, setUserStatus } from './users.service';

export const usersApi = new Api('Panel: sign-in and users');
const api = usersApi;

api.post(
  '/manage/auth/login',
  {
    auth: 'public',
    limited: true,
    summary: 'Signs in to the panel',
    returns: '{ token, expires_at, admin: { id, name, email, role } }',
    body: loginBody,
  },
  async ({ res, body }) => ok(res, await login(body), 'Logged in'),
);

api.get('/manage/me', { auth: 'panel', summary: 'The signed-in panel user', returns: '{ id, name, email, role }' }, ({ res }) =>
  ok(res, panelOf(res)),
);

api.get('/manage/users', { auth: 'admin', summary: 'The panel users, newest first', returns: 'ManageUser[]' }, async ({ res }) =>
  ok(res, await listUsers()),
);

api.post(
  '/manage/users',
  {
    auth: 'admin',
    summary: 'Adds a panel user (409: the email is taken)',
    returns: 'ManageUser',
    body: newUserBody,
    status: 201,
  },
  async ({ req, res, body }) => created(res, await addUser(req, panelOf(res), body), 'User added'),
);

api.patch(
  '/manage/users/:id/status',
  {
    auth: 'admin',
    summary: 'Activates or deactivates a panel user (409: oneself, or the last active Admin)',
    returns: 'ManageUser',
    params: userParams,
    notFound: 'User not found',
    body: userStatusBody,
  },
  async ({ req, res, params, body }) =>
    ok(
      res,
      await setUserStatus(req, panelOf(res), params.id, body.is_active),
      body.is_active ? 'User activated' : 'User deactivated',
    ),
);
