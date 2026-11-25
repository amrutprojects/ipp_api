import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { one } from '../db/pool';
import { fileRule, UPLOAD_FILE_MAX_MB } from '../lib/file-type';
import { AppError } from './errors';

const MB = 1024 * 1024;
const tmpDir = path.join(os.tmpdir(), 'ipp-uploads');
fs.mkdirSync(tmpDir, { recursive: true });

/*
 * Document uploads: up to 20 files, each in a field named after its document code. Files go to temporary files that are
 * deleted when the answer has been sent. The multipart limit is the largest any document allows; each document's own limit
 * and its content are checked by the application module.
 */
const receive = multer({
  storage: multer.diskStorage({ destination: tmpDir }),
  limits: { fileSize: UPLOAD_FILE_MAX_MB * MB, files: 20, fields: 2, fieldSize: 64 * 1024 },
  /* Browsers send file names as UTF-8: a Marathi name stays readable. */
  defParamCharset: 'utf8',
}).any();

/* A file over the multipart limit, refused with the limit of its own document. */
async function tooLarge(field: string | undefined): Promise<AppError> {
  const document = await one<{ kind: string }>(`SELECT kind FROM program_documents WHERE code = upper($1)`, [field ?? '']);
  const { maxMb } = fileRule(document?.kind === 'VIDEO');
  return AppError.validation([{ field: `files.${field}`, message: `File is larger than ${maxMb} MB` }]);
}

export const receiveDocuments: RequestHandler = (req, res, next) => {
  receive(req, res, (err: unknown) => {
    const files = uploadedFiles(req);
    /* A file of a broken request may have no path yet. */
    res.on('close', () => files.forEach((f) => f.path && fs.rm(f.path, { force: true }, () => undefined)));
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return void tooLarge(err.field).then(next, next);
    if (err instanceof multer.MulterError) return next(AppError.badRequest(err.message));
    /* The parser's own errors: the request is not the multipart form it says it is (a failing disk has an error code). */
    next(err instanceof Error && !('code' in err) ? AppError.badRequest('Malformed upload') : err);
  });
};

export const uploadedFiles = (req: Request): Express.Multer.File[] => (Array.isArray(req.files) ? req.files : []);
