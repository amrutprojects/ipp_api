import fs from 'node:fs/promises';
import { rows } from '../db/pool';
import { AppError, type FieldError } from '../http/errors';
import {
  detectFileType,
  detectVideoType,
  extensionMatches,
  fileRule,
  type DocumentFileType,
  type VideoFileType,
} from '../lib/file-type';
import { logger } from '../lib/logger';
import { hasControlChars } from '../lib/text';
import { safeSegment, storage } from '../services/storage';
import type { ProgramDocument } from './masters';

/* Uploaded documents, as the student's form and the Auditor's corrections take them, and the stored files behind them. */

const MB = 1024 * 1024;
/* Enough of a file to say what it is. */
const HEAD_BYTES = 32;

async function head(path: string): Promise<Buffer> {
  const file = await fs.open(path);
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export interface CheckedUpload {
  code: string;
  path: string;
  type: DocumentFileType | VideoFileType;
  /* The file's own name, without what cannot be saved. */
  name: string;
}

/*
 * The uploaded files, each in a field named after its document: one of the accepted ones, at most one file, of the size and
 * the type the document allows; the type by the content and by the name's extension. Every problem is reported (422).
 */
export async function checkUploads(files: Express.Multer.File[], accepted: ProgramDocument[]): Promise<CheckedUpload[]> {
  const byCode = new Map(accepted.map((d) => [d.code, d]));
  const errors: FieldError[] = [];
  const checked: CheckedUpload[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const issue = (message: string) => errors.push({ field: `files.${file.fieldname}`, message });
    const document = byCode.get(file.fieldname.toUpperCase());
    if (!document) {
      issue('Unknown or inactive document type');
      continue;
    }
    const { code, nameEn: name } = document;
    if (seen.has(code)) {
      issue(`Only one ${name} file may be uploaded`);
      continue;
    }
    seen.add(code);
    const video = document.kind === 'VIDEO';
    const { maxMb } = fileRule(video);
    if (file.size > maxMb * MB) {
      issue(`${name}: file is larger than ${maxMb} MB`);
      continue;
    }
    const start = await head(file.path);
    const type = video ? detectVideoType(start) : detectFileType(start);
    if (!type || !extensionMatches(file.originalname, type)) {
      issue(video ? `${name}: only MP4 videos are accepted` : `${name}: only PDF, JPG, JPEG or PNG files are accepted`);
      continue;
    }
    const original = [...file.originalname].filter((c) => !hasControlChars(c)).join('');
    checked.push({ code, path: file.path, type, name: original.slice(-255) });
  }
  if (errors.length) throw AppError.validation(errors);
  return checked;
}

/* A candidate's folder of documents: the registration ID and the name, e.g. IPP-000001_Asha_Testkar (A–Z, 0–9, . _ - only). */
export const candidateFolder = (code: string, firstName: string, lastName: string) =>
  safeSegment([code, firstName, lastName].join('_').replace(/\s+/g, '_')).replace(/_+/g, '_').replace(/_$/, '');

/* A storage error's kind; its text may hold a file's path, with the student's name. */
const kind = (err: unknown) => (err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : 'unknown');

/* Deletes stored files nothing points to any more. A failure leaves a file nobody sees; it is only logged. */
export async function discardFiles(keys: string[]): Promise<void> {
  for (const key of keys)
    await storage.remove(key).catch((err: unknown) => logger.error({ reason: kind(err) }, 'could not delete a stored file'));
}

/*
 * After a failed change: deletes the files written for it, except those the database does hold (the commit may have reached
 * it although its answer did not). When that cannot be told, the files stay.
 */
export async function discardUnusedFiles(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const used = await rows<{ storage_key: string }>(
      `SELECT storage_key FROM application_files WHERE storage_key = ANY($1::text[])`,
      [keys],
    );
    await discardFiles(keys.filter((k) => !used.some((u) => u.storage_key === k)));
  } catch (err) {
    logger.error({ reason: kind(err) }, 'could not tell which stored files are unused');
  }
}
