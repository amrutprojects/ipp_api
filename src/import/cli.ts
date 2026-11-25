import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { projectRoot } from '../config/env';
import { pending } from '../db/migrate';
import { pool } from '../db/pool';
import { importLegacy } from './legacy';
import { openSource } from './source';

/*
 * Copies the earlier system's data (see legacy.ts). Settings: LEGACY_* variables, or a file .env.legacy (never committed).
 *   npm run import:legacy -- --dry-run     nothing is kept; shows what would be copied
 *   npm run import:legacy -- --yes         copies
 */
async function main(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  if (!dryRun && !args.includes('--yes')) throw new Error('Use --dry-run to see what would be copied, or --yes to copy.');
  const file = path.join(projectRoot, '.env.legacy');
  if (fs.existsSync(file)) dotenv.config({ path: file });
  if ((await pending()).length) throw new Error('Pending migrations: run "npm run db:migrate" first');
  const source = await openSource(process.env);
  try {
    const { counts, warnings } = await importLegacy(source, { dryRun });
    console.log(dryRun ? 'Would be copied:' : 'Copied:', counts);
    for (const w of warnings) console.log(`  ! ${w}`);
  } finally {
    await source.close();
  }
}

main(process.argv.slice(2))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
