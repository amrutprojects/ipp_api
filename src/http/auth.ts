import type { RequestHandler, Response } from 'express';
import { one } from '../db/pool';
import { passwordVersion, readSession } from '../lib/tokens';
import { AppError } from './errors';

/* The signed-in student (a verified portal account). */
export interface StudentAccount {
  id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  email: string;
  mobile: string;
  verified_at: Date | null;
  password_changed_at: Date | null;
}

/* The signed-in panel user: an ADMIN (Auditor) may do everything, a VIEWER only views and downloads. */
export type PanelRole = 'ADMIN' | 'VIEWER';
export interface PanelUser {
  id: string;
  name: string;
  email: string;
  role: PanelRole;
}

export const PASSWORD_CHANGED = 'Your password was changed. Please log in again.';
export const VIEW_ONLY = 'Your account can only view. Ask an administrator to make this change.';
const LOG_IN = 'Please log in to continue.';

const bearer = (header: string | undefined) => {
  const [scheme, value] = (header ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
};

const guard =
  (check: (token: string, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    const token = bearer(req.header('authorization'));
    if (!token) return next(AppError.unauthorized(LOG_IN));
    check(token, res).then(() => next(), next);
  };

/*
 * A signed-in student: active and verified. A session from before the password was last changed is refused, so a password
 * reset also signs out every other device.
 */
export const requireStudent = guard(async (token, res) => {
  const { id, pv } = readSession('student', token);
  const account = await one<StudentAccount>(
    `SELECT id, first_name, middle_name, last_name, email, mobile, verified_at, password_changed_at
     FROM student_accounts WHERE id = $1 AND is_active AND deleted_at IS NULL`,
    [id],
  );
  if (!account?.verified_at) throw AppError.unauthorized(LOG_IN);
  if (pv !== passwordVersion(account.password_changed_at)) throw AppError.unauthorized(PASSWORD_CHANGED);
  res.locals.student = account;
});

/* A signed-in panel user. */
export const requirePanel = guard(async (token, res) => {
  const { id, pv } = readSession('panel', token);
  const user = await one<PanelUser & { password_changed_at: Date | null }>(
    `SELECT id, name, email, role, password_changed_at FROM panel_users WHERE id = $1 AND is_active AND deleted_at IS NULL`,
    [id],
  );
  if (!user) throw AppError.unauthorized(LOG_IN);
  if (pv !== passwordVersion(user.password_changed_at)) throw AppError.unauthorized(PASSWORD_CHANGED);
  res.locals.panel = { id: user.id, name: user.name, email: user.email, role: user.role } satisfies PanelUser;
});

/* A panel ADMIN; a VIEWER gets 403. After requirePanel. */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  const user = res.locals.panel as PanelUser | undefined;
  if (!user) return next(AppError.unauthorized(LOG_IN));
  next(user.role === 'ADMIN' ? undefined : AppError.forbidden(VIEW_ONLY));
};

export const studentOf = (res: Response) => res.locals.student as StudentAccount;
export const panelOf = (res: Response) => res.locals.panel as PanelUser;
