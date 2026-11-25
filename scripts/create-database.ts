/*
 * Local set-up, once: the role and the two databases (the program's and the tests') of .env and .env.test. The superuser's
 * password is read from PGPASSWORD (or PG_SUPERUSER_PASSWORD) and never stored. Existing ones are left as they are.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';

const root = path.resolve(__dirname, '..');
const read = (file: string) => dotenv.parse(fs.readFileSync(path.join(root, file)));
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function main(): Promise<void> {
  const env = read('.env');
  const test = fs.existsSync(path.join(root, '.env.test')) ? read('.env.test') : null;
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT ?? 5432),
    user: process.env.PG_SUPERUSER ?? 'postgres',
    password: process.env.PG_SUPERUSER_PASSWORD ?? process.env.PGPASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    const role = env.DB_USER!;
    const known = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const literal = `'${env.DB_PASSWORD!.replace(/'/g, "''")}'`;
    if (known.rowCount) console.log(`role ${role}: exists`);
    else {
      await client.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      console.log(`role ${role}: created`);
    }
    for (const name of [env.DB_NAME!, ...(test?.DB_NAME ? [test.DB_NAME] : [])]) {
      const there = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (there.rowCount) console.log(`database ${name}: exists`);
      else {
        await client.query(`CREATE DATABASE ${quote(name)} OWNER ${quote(role)} ENCODING 'UTF8' TEMPLATE template0`);
        await client.query(`REVOKE ALL ON DATABASE ${quote(name)} FROM PUBLIC`);
        console.log(`database ${name}: created`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
