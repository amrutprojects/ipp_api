import { pending } from '../db/migrate';
import { pool } from '../db/pool';
import { organiseAll } from './folders';

/*
 * Moves the documents stored before the students' folders existed (applications/<id>/…, candidates/<ID>_<name>/…) into each
 * student's folder, "candidates/Asha Patil 9876501234/". Without --yes it only counts.
 *   npm run storage:organise            counts what would move
 *   npm run storage:organise -- --yes   moves
 */
async function main(args: string[]): Promise<void> {
  if ((await pending()).length) throw new Error('Pending migrations: run "npm run db:migrate" first');
  const apply = args.includes('--yes');
  const { applications, files } = await organiseAll(apply);
  console.log(
    apply
      ? `Moved ${files} document(s) of ${applications} student(s) into their folders.`
      : `${applications} student(s) with ${files} document(s) outside their folders. Run again with --yes to move them.`,
  );
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
