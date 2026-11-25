/*
 * Makes a panel ADMIN, or gives an existing one a new password (its sessions end):
 *   npm run panel:admin -- <email> "<name>"        the password is read from PANEL_PASSWORD
 */
import { pool, transaction } from '../src/db/pool';
import { hashPassword } from '../src/lib/passwords';
import { email, password } from '../src/lib/text';
import { audit } from '../src/services/audit';

async function main(): Promise<void> {
  const [address, name = 'Auditor'] = process.argv.slice(2);
  const login = email.parse(address ?? '');
  const hash = await hashPassword(password.parse(process.env.PANEL_PASSWORD ?? ''));
  await transaction(async (db) => {
    const { rows } = await db.query<{ id: string; created: boolean }>(
      `INSERT INTO panel_users (name, email, password_hash, role) VALUES ($1, $2, $3, 'ADMIN')
       ON CONFLICT (email) WHERE deleted_at IS NULL
       DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now(), role = 'ADMIN', is_active = true
       RETURNING id, (xmax = 0) AS created`,
      [name, login, hash],
    );
    await audit.inTx(db, null, {
      action: rows[0]!.created ? 'panel.user.create' : 'panel.user.password',
      resource: 'panel_user',
      resourceId: rows[0]!.id,
      actor: { kind: 'SYSTEM', id: null },
    });
    console.log(rows[0]!.created ? 'Panel ADMIN created.' : 'Password changed.');
  });
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
