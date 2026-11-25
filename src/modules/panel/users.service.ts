import type { Request } from 'express';
import { DatabaseError } from 'pg';
import { one, pool, rows, transaction } from '../../db/pool';
import type { PanelRole, PanelUser } from '../../http/auth';
import { AppError } from '../../http/errors';
import { hashPassword, passwordMatches } from '../../lib/passwords';
import { passwordVersion, signSession } from '../../lib/tokens';
import { audit } from '../../services/audit';
import { actor } from './common';
import type { LoginBody, NewUserBody } from './users.schemas';

/* The panel's own sign-in and its users: ADMIN (the Auditor) and VIEWER. */

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: PanelRole;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}
const USER_COLUMNS = 'id, name, email, role, is_active, last_login_at, created_at';
const userDto = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  is_active: u.is_active,
  last_login_at: u.last_login_at,
  created_at: u.created_at,
});

/* -------------------------------------------------------------------------------------------------------------- sign-in */

const TRIES = 10;
const WINDOW = `interval '15 minutes'`;

/*
 * A try is counted before the password is compared, in one statement: requests sent at the same time cannot get more tries
 * than the limit. False = the account has none left until the window (15 minutes from the first wrong password) is over.
 */
async function countTry(userId: string): Promise<boolean> {
  const row = await one(
    `UPDATE panel_users SET
       failed_logins = CASE WHEN failed_window_start > now() - ${WINDOW} THEN failed_logins + 1 ELSE 1 END,
       failed_window_start = CASE WHEN failed_window_start > now() - ${WINDOW} THEN failed_window_start ELSE now() END
     WHERE id = $1 AND NOT (failed_logins >= $2 AND coalesce(failed_window_start > now() - ${WINDOW}, false))
     RETURNING id`,
    [userId, TRIES],
  );
  return row !== null;
}

export async function login(body: LoginBody) {
  const user = await one<UserRow & { password_hash: string; password_changed_at: Date | null }>(
    `SELECT ${USER_COLUMNS}, password_hash, password_changed_at FROM panel_users WHERE email = $1 AND deleted_at IS NULL`,
    [body.email],
  );
  if (user && !(await countTry(user.id))) throw AppError.tooMany('Too many attempts. Please try again later.');
  /* Compared for an unknown account too, so the answer takes as long as for a known one. */
  const matches = await passwordMatches(body.password, user?.password_hash);
  if (!user || !matches || !user.is_active) throw AppError.unauthorized('Incorrect email or password');
  await pool.query(`UPDATE panel_users SET last_login_at = now(), failed_logins = 0, failed_window_start = NULL WHERE id = $1`, [
    user.id,
  ]);
  const { token, expiresAt } = signSession('panel', user.id, passwordVersion(user.password_changed_at));
  return { token, expires_at: expiresAt, admin: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

/* ---------------------------------------------------------------------------------------------------------------- users */

/* Newest first. */
export const listUsers = async () =>
  (await rows<UserRow>(`SELECT ${USER_COLUMNS} FROM panel_users WHERE deleted_at IS NULL ORDER BY created_at DESC, id`)).map(
    userDto,
  );

export async function addUser(req: Request, by: PanelUser, body: NewUserBody) {
  const hash = await hashPassword(body.password);
  try {
    return await transaction(async (db) => {
      const user = (await one<UserRow>(
        `INSERT INTO panel_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
        [body.name, body.email, hash, body.role],
        db,
      ))!;
      await audit.inTx(db, req, {
        action: 'edp.user.create',
        resource: 'panel_user',
        resourceId: user.id,
        actor: actor(by),
        details: { role: user.role },
      });
      return userDto(user);
    });
  } catch (err) {
    if (err instanceof DatabaseError && err.constraint === 'uq_panel_users_email')
      throw AppError.conflict('A user with this email already exists');
    throw err;
  }
}

/*
 * Switches a user on or off. The active ADMIN accounts are locked first, so of two ADMINs who deactivate each other at the
 * same time one is refused: an active ADMIN always remains, and one deactivated meanwhile changes nothing any more.
 */
export async function setUserStatus(req: Request, by: PanelUser, id: string, isActive: boolean) {
  return transaction(async (db) => {
    const admins = await rows<{ id: string }>(
      `SELECT id FROM panel_users WHERE role = 'ADMIN' AND is_active AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
      [],
      db,
    );
    const user = await one<UserRow>(
      `SELECT ${USER_COLUMNS} FROM panel_users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
      db,
    );
    if (!user) throw AppError.notFound('User not found');
    if (!isActive && user.id === by.id) throw AppError.conflict('You cannot deactivate your own account');
    if (!isActive && user.role === 'ADMIN' && admins.every((a) => a.id === user.id))
      throw AppError.conflict('At least one active Admin must remain.');
    if (!admins.some((a) => a.id === by.id)) throw AppError.unauthorized('Please log in to continue.');
    if (user.is_active === isActive) return userDto(user);
    await db.query(`UPDATE panel_users SET is_active = $2 WHERE id = $1`, [id, isActive]);
    await audit.inTx(db, req, {
      action: 'edp.user.status',
      resource: 'panel_user',
      resourceId: id,
      actor: actor(by),
      details: { isActive },
    });
    return userDto({ ...user, is_active: isActive });
  });
}
