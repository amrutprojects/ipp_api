import path from 'node:path';
import { one, rows, transaction, type Db } from '../db/pool';
import { logger } from '../lib/logger';
import { normaliseMobile } from '../lib/text';
import { storage } from '../services/storage';
import { discardFiles } from './uploads';

/*
 * Each student's documents live in one folder of their own, named after them: candidates/Asha Patil 9876501234/ (first name,
 * last name and mobile number). The draft's uploads, the submitted documents and the Auditor's replacements all go there; when
 * the name or the mobile number is corrected, the files move to the folder of the new name. The name of a student's folder is
 * kept on the application (storage_folder): two students of the same name and number get "… (2)", "… (3)".
 */

const FOLDER_MAX = 150;

/*
 * "asha" or "ASHA" → "Asha", "patil-patil" → "Patil-Shinde", "d'souza" → "D'Souza"; a name written with capitals of its
 * own ("McDonald") stays as it is written.
 */
function nameCase(word: string): string {
  const hasLower = word !== word.toLocaleUpperCase('en-IN');
  const hasUpper = word !== word.toLocaleLowerCase('en-IN');
  if (hasLower && hasUpper) return word;
  return word
    .toLocaleLowerCase('en-IN')
    .split(/(?<=['-])/)
    .map((part) => part.charAt(0).toLocaleUpperCase('en-IN') + part.slice(1))
    .join('');
}

/* Letters (of any script), digits, spaces and . ' - only: nothing that means something to S3 or to a disk. */
const words = (s: string) =>
  s
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} .'-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(nameCase);

/* "Asha Patil 9876501234". Never empty, never "." or "..", never ends in a dot or a space. */
export function studentFolder(firstName: string, lastName: string, mobile: string): string {
  const digits = normaliseMobile(mobile ?? '').replace(/\D/g, '');
  const name = [...words(firstName ?? ''), ...words(lastName ?? '')].join(' ');
  const folder = [name, digits]
    .filter(Boolean)
    .join(' ')
    .slice(0, FOLDER_MAX)
    .replace(/^[.\s'-]+|[.\s]+$/g, '');
  return folder || 'Student';
}

/* Whether `folder` is `base`, or `base` with a number: "… (2)". */
const isFolderOf = (folder: string, base: string) =>
  folder.toLowerCase() === base.toLowerCase() ||
  new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)$`, 'i').test(folder);

/*
 * The folder of an application for this name (inside the caller's transaction): the one it has when that one is of this name,
 * else the first of "name", "name (2)", … that no other application has. One choice of a name at a time.
 */
export async function assignFolder(db: Db, applicationId: string, base: string): Promise<string> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`storage-folder:${base.toLowerCase()}`]);
  const now = await one<{ storage_folder: string | null }>(
    `SELECT storage_folder FROM applications WHERE id = $1`,
    [applicationId],
    db,
  );
  if (now?.storage_folder && isFolderOf(now.storage_folder, base)) return now.storage_folder;
  for (let n = 1; ; n++) {
    const folder = n === 1 ? base : `${base.slice(0, FOLDER_MAX - 8)} (${n})`;
    const taken = await one(
      `SELECT 1 FROM applications WHERE lower(storage_folder) = lower($1) AND id <> $2`,
      [folder, applicationId],
      db,
    );
    if (taken) continue;
    await db.query(`UPDATE applications SET storage_folder = $2 WHERE id = $1`, [applicationId, folder]);
    return folder;
  }
}

/* Where a file of this folder is stored. */
export const keyIn = (folder: string, fileName: string) => storage.studentKey(folder, fileName);

/*
 * Moves the files of an application that are not in its folder (stored before, or before the name was corrected) into it. The
 * copies are made first; the database then points to them, but only where it still points to the file that was copied; the
 * files nothing points to any more are deleted afterwards. When anything fails the files stay where they were, still in use.
 */
export async function relocateFiles(applicationId: string): Promise<number> {
  const app = await one<{ storage_folder: string | null }>(`SELECT storage_folder FROM applications WHERE id = $1`, [
    applicationId,
  ]);
  if (!app?.storage_folder) return 0;
  const folder = app.storage_folder;
  const inFolder = keyIn(folder, 'x').slice(0, -1);
  const files = (
    await rows<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM application_files WHERE application_id = $1`, [
      applicationId,
    ])
  ).filter((f) => !f.storage_key.startsWith(inFolder));
  if (!files.length) return 0;

  const copies: { id: string; from: string; to: string }[] = [];
  try {
    for (const f of files) {
      const to = keyIn(folder, path.posix.basename(f.storage_key));
      await storage.copy(f.storage_key, to);
      copies.push({ id: f.id, from: f.storage_key, to });
    }
  } catch (err) {
    logger.error(
      { reason: (err as NodeJS.ErrnoException).code ?? (err as Error).name },
      'documents could not be moved to their folder',
    );
    await discardFiles(copies.map((c) => c.to));
    return 0;
  }
  const moved = await transaction(async (db) => {
    const done: typeof copies = [];
    for (const c of copies) {
      const { rowCount } = await db.query(`UPDATE application_files SET storage_key = $3 WHERE id = $1 AND storage_key = $2`, [
        c.id,
        c.from,
        c.to,
      ]);
      if (rowCount) done.push(c);
    }
    return done;
  }).catch((err: unknown) => {
    logger.error({ err }, 'documents could not be moved to their folder');
    return [] as typeof copies;
  });
  /* The old files of those moved; the copies of those that changed meanwhile. */
  await discardFiles([...moved.map((c) => c.from), ...copies.filter((c) => !moved.includes(c)).map((c) => c.to)]);
  return moved.length;
}

/* The folder an application's documents belong in now, named after the student as the form (else the account) says. */
export async function folderFor(
  db: Db,
  applicationId: string,
  who: { first_name?: string | null; last_name?: string | null; mobile?: string | null },
  account: { first_name: string; last_name: string; mobile: string },
): Promise<string> {
  const base = studentFolder(
    who.first_name || account.first_name,
    who.last_name || account.last_name,
    who.mobile || account.mobile,
  );
  return assignFolder(db, applicationId, base);
}

/* Every application with documents outside its folder: their folder is chosen and the files moved (npm run storage:organise). */
export async function organiseAll(apply: boolean): Promise<{ applications: number; files: number }> {
  const list = await rows<{ id: string; data: Record<string, unknown>; first_name: string; last_name: string; mobile: string }>(
    `SELECT p.id, p.data, a.first_name, a.last_name, a.mobile FROM applications p JOIN student_accounts a ON a.id = p.account_id
     WHERE EXISTS (SELECT 1 FROM application_files f WHERE f.application_id = p.id
                   AND (p.storage_folder IS NULL OR f.storage_key NOT LIKE 'candidates/' || replace(replace(p.storage_folder, '%', '\\%'), '_', '\\_') || '/%'))
     ORDER BY p.created_at, p.id`,
  );
  let files = 0;
  for (const p of list) {
    const text = (k: string) => (typeof p.data[k] === 'string' ? (p.data[k] as string) : '');
    if (!apply) {
      files += (await one<{ n: number }>(`SELECT count(*)::int AS n FROM application_files WHERE application_id = $1`, [p.id]))!
        .n;
      continue;
    }
    await transaction((db) =>
      folderFor(db, p.id, { first_name: text('first_name'), last_name: text('last_name'), mobile: text('mobile_number') }, p),
    );
    files += await relocateFiles(p.id);
  }
  return { applications: list.length, files };
}
