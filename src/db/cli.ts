import { migrate, pending } from './migrate';
import { pool } from './pool';
import { seed } from './seeds';

/* Database commands: `migrate` (run what is pending), `status`, `seed` (fill the masters; safe to run again). */
async function main(command: string | undefined): Promise<void> {
  if (command === 'migrate') {
    const ran = await migrate();
    console.log(ran.length ? `Migrations run: ${ran.join(', ')}` : 'The database is up to date.');
  } else if (command === 'status') {
    const missing = await pending();
    console.log(missing.length ? `Pending: ${missing.join(', ')}` : 'The database is up to date.');
  } else if (command === 'seed') {
    if ((await pending()).length) throw new Error('Pending migrations: run "npm run db:migrate" first');
    console.log('Seeded:', await seed());
  } else throw new Error('Use: migrate | status | seed');
}

main(process.argv[2])
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
