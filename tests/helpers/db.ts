import { pool, rows } from '../../src/db/pool';
import { seed } from '../../src/db/seeds';

/* Empties the test database and fills in the starting masters (call in beforeAll, or beforeEach where a test needs it). */
export async function resetDatabase(): Promise<void> {
  const tables = await rows<{ t: string }>(
    `SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  await pool.query(`TRUNCATE ${tables.map((x) => x.t).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`ALTER SEQUENCE registration_seq RESTART; ALTER SEQUENCE batch_code_seq RESTART`);
  await seed();
}

/* Call in afterAll of every test file. */
export const closeDatabase = () => pool.end();
