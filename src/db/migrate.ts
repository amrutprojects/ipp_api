import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from './pool';

/*
 * Migrations: the numbered .sql files of db/migrations, each run once, in order, in a transaction of its own. A file that
 * has been run must not be edited (its checksum is kept): add a new file instead. One runner at a time (advisory lock).
 */
const DIR = path.join(__dirname, 'migrations');
const LOCK = 7_341_105;

interface File {
  name: string;
  sql: string;
  checksum: string;
}

const files = (): File[] =>
  fs
    .readdirSync(DIR)
    .filter((f) => /^[0-9]{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      /* Line endings do not count: a checkout on Windows is the same migration. */
      const sql = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });

async function state() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, run_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await pool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

export async function pending(): Promise<string[]> {
  const done = await state();
  return files()
    .filter((f) => !done.has(f.name))
    .map((f) => f.name);
}

/* Runs what is pending; returns the names. */
export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    const done = await state();
    const ran: string[] = [];
    for (const f of files()) {
      const known = done.get(f.name);
      if (known) {
        if (known !== f.checksum)
          throw new Error(`Migration ${f.name} was changed after it was run. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f.name, f.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      ran.push(f.name);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    client.release();
  }
}
