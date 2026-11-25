import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/* bigint (count) as a number; a date (no time) as the text YYYY-MM-DD it is, never shifted by a time zone. */
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
types.setTypeParser(types.builtins.DATE, (v) => v);

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  max: env.DB_POOL_MAX,
  ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  application_name: 'ipp-backend',
});
pool.on('error', (err) => logger.error({ err }, 'idle database connection failed'));

/* Something that runs SQL: the pool, or the client of a transaction. */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/* Rows of a statement (parameters only through $1, $2, …). */
export async function rows<T extends QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function one<T extends QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  return (await rows<T>(sql, params, db))[0] ?? null;
}

/* Runs `work` in one transaction: committed when it returns, rolled back when it throws. */
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/*
 * One run at a time per key, across processes: a session lock on a connection of its own (freed if the process dies).
 * `busy` is what a second caller gets while the first is running.
 */
export async function exclusively<T>(key: string, work: () => Promise<T>, busy: () => Error): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows: r } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]);
    locked = r[0]!.ok;
    if (!locked) throw busy();
    return await work();
  } finally {
    if (locked)
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
        .catch((err) => logger.error({ err }, 'could not release a lock'));
    client.release();
  }
}
