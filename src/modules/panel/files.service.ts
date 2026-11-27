import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { ZipFile } from 'yazl';
import { one, rows } from '../../db/pool';
import { fileLink } from '../../program/file-links';
import { AppError } from '../../http/errors';
import { logger } from '../../lib/logger';
import { loadProgram, type Program } from '../../program/masters';
import { storage } from '../../services/storage';
import { applicationOf, folderOf, formOf, NO_FILE, studentAccount } from './common';

/* A candidate's documents as the panel opens and downloads them, at any stage. */

interface FileRow {
  id: string;
  document_code: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
}

const EXTENSION: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'video/mp4': '.mp4',
};
const extensionOf = (f: FileRow) => path.extname(f.storage_key) || (EXTENSION[f.mime_type] ?? '');

/* A document's name in a file name: letters and digits joined with _, e.g. Applicant_Video_with_Aadhaar. */
const fileLabel = (program: Program, code: string) =>
  program
    .documentName(code)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || code;

/* A name in Content-Disposition: an ASCII one for old clients, and the exact one (RFC 6266 / 5987). */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"; filename*=UTF-8''${exact}`;
}

/*
 * Sends a file: never cached, never sniffed, and, opened on its own, not allowed to run or load anything. A file that breaks
 * off while it is sent breaks the answer off too, so it is never taken for a whole one; a client that has gone closes it.
 */
async function send(res: Response, body: Readable, mime: string, contentDisposition: string): Promise<void> {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', contentDisposition);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  try {
    await pipeline(body, res);
  } catch (err) {
    /* Not the error itself: its text may hold a file's path, with the student's name. */
    const reason = (err as NodeJS.ErrnoException).code ?? 'unknown';
    logger.warn({ reason, requestId: res.locals.requestId as string | undefined }, 'a document was not sent to the end');
  }
}

async function candidateFiles(accountId: string) {
  const account = await studentAccount(accountId);
  const [program, p] = await Promise.all([loadProgram(), applicationOf(accountId)]);
  const files = p
    ? await rows<FileRow>(
        `SELECT id, document_code, storage_key, original_name, mime_type FROM application_files WHERE application_id = $1`,
        [p.id],
      )
    : [];
  return { program, folder: folderOf(p, formOf(p, program), account), files };
}

/* Whether a stored file is there; one that is not is a fault of the storage, and reported. */
async function isStored(f: FileRow): Promise<boolean> {
  const there = await storage.exists(f.storage_key);
  if (!there) logger.error({ file: f.id, document: f.document_code }, 'a stored document is missing');
  return there;
}

/* One document: opened inline under its own name, or downloaded under the candidate's, e.g. IPP-000001_Asha_Testkar_Photo.pdf. */
/* A short-lived link to an uploaded document of a student (program/file-links.ts); found by one query, not the whole program. */
export async function documentLink(accountId: string, code: string) {
  await studentAccount(accountId);
  const f = await one<{ id: string }>(
    `SELECT f.id FROM application_files f JOIN applications p ON p.id = f.application_id
     WHERE p.account_id = $1 AND p.deleted_at IS NULL AND f.document_code = $2`,
    [accountId, code],
  );
  if (!f) throw AppError.notFound(NO_FILE);
  return fileLink(f.id);
}

export async function sendDocument(res: Response, accountId: string, code: string, download: boolean): Promise<void> {
  const c = await candidateFiles(accountId);
  const f = c.files.find((x) => x.document_code === code);
  if (!f || !(await isStored(f))) throw AppError.notFound(NO_FILE);
  const name = download
    ? disposition('attachment', `${c.folder}_${fileLabel(c.program, code)}${extensionOf(f)}`)
    : disposition('inline', f.original_name);
  await send(res, await storage.read(f.storage_key), f.mime_type, name);
}

/* A file that is opened only when it is its turn to be read. */
const opened = (key: string) =>
  Readable.from(
    (async function* () {
      yield* await storage.read(key);
    })(),
    { objectMode: false },
  );

/*
 * All documents as a ZIP of one folder named like the candidate's, each file after its place in the form and its label, e.g.
 * 01_Photo.pdf. Streamed, one file after the other. A file the storage has lost is left out, and a note in its place says so.
 */
export async function sendDocumentsZip(res: Response, accountId: string): Promise<void> {
  const { program, folder, files } = await candidateFiles(accountId);
  if (!files.length) throw AppError.notFound('No documents have been uploaded yet');
  const order = program.documentOrder();
  const entries = await Promise.all(
    files
      .map((f) => ({ f, place: (order.get(f.document_code) ?? 0) + 1 }))
      .sort((a, b) => a.place - b.place)
      .map(async ({ f, place }) => ({
        key: f.storage_key,
        name: `${folder}/${String(place).padStart(2, '0')}_${fileLabel(program, f.document_code)}`,
        extension: extensionOf(f),
        stored: await isStored(f),
      })),
  );
  const zip = new ZipFile();
  const sources: Readable[] = [];
  for (const e of entries) {
    if (!e.stored) {
      zip.addBuffer(Buffer.from('This file could not be found in the storage.\n'), `${e.name}_MISSING.txt`);
      continue;
    }
    const source = opened(e.key);
    source.on('error', (err) => res.destroy(err));
    sources.push(source);
    zip.addReadStream(source, e.name + e.extension);
  }
  zip.end();
  await send(res, zip.outputStream as Readable, 'application/zip', disposition('attachment', `${folder}.zip`));
  /* Of an answer that broke off, the files still open. */
  for (const s of sources) s.destroy();
}
