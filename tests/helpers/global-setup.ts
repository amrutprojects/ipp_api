import fs from 'node:fs';
import path from 'node:path';

/* Before all tests: the test database is brought up to date. It must be a database of its own, whose name says so. */
export default async function setup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  const { env, projectRoot } = await import('../../src/config/env');
  if (!/test/.test(env.DB_NAME)) throw new Error(`Refusing to run the tests on the database "${env.DB_NAME}"`);
  if (!/test/.test(env.STORAGE_DIR)) throw new Error(`Refusing to run the tests on the storage "${env.STORAGE_DIR}"`);
  fs.rmSync(path.resolve(projectRoot, env.STORAGE_DIR), { recursive: true, force: true });
  const { migrate } = await import('../../src/db/migrate');
  const { pool } = await import('../../src/db/pool');
  await migrate();
  await pool.end();
}
