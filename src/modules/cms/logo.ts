import crypto from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { detectFileType } from '../../lib/file-type';
import { AppError } from '../../http/errors';

/*
 * The landing page's logo: one image in the field "logo", PNG, JPEG, WebP or SVG of at most 1 MB, kept in memory (it is
 * stored in the database). The type comes from the content, never from the name. An SVG with scripts or event handlers
 * is refused; it is also served with a sandboxing Content-Security-Policy, so it can only ever be drawn.
 */
export const LOGO_FIELD = 'logo';
export const LOGO_MAX_BYTES = 1024 * 1024;
const TOO_LARGE = 'The logo must be at most 1 MB';

const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 0 },
}).single(LOGO_FIELD);

export const receiveLogo: RequestHandler = (req, res, next) => {
  receive(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
      return next(AppError.validation([{ field: LOGO_FIELD, message: TOO_LARGE }]));
    if (err instanceof multer.MulterError && err.code === 'LIMIT_UNEXPECTED_FILE')
      return next(AppError.validation([{ field: LOGO_FIELD, message: `Send one image in the field "${LOGO_FIELD}"` }]));
    if (err instanceof multer.MulterError) return next(AppError.badRequest(err.message));
    next(err instanceof Error && !('code' in err) ? AppError.badRequest('Malformed upload') : err);
  });
};

export const uploadedLogo = (req: Request): Express.Multer.File | undefined => req.file;

export interface LogoImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  data: Buffer;
  version: string;
}

const isWebp = (b: Buffer) =>
  b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';

/* An SVG document: optional BOM, XML declaration, comments and doctype, then <svg. */
function svgProblem(b: Buffer): string | null | 'not-svg' {
  const head = b
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\u{FEFF}/u, '');
  const start = head.replace(/^(\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
  if (!/^<svg[\s>]/i.test(start)) return 'not-svg';
  const all = b.toString('utf8');
  if (/<script[\s>]/i.test(all) || /\son[a-z]+\s*=/i.test(all) || /javascript:/i.test(all) || /<foreignObject[\s>]/i.test(all))
    return 'The SVG contains scripts or event handlers; export it again as a plain image';
  return null;
}

/* The uploaded file as a logo, or a 422 that says why not. */
export function logoImage(file: Express.Multer.File | undefined): LogoImage {
  if (!file || !file.buffer?.length) throw AppError.validation([{ field: LOGO_FIELD, message: 'Choose an image' }]);
  const data = file.buffer;
  const known = detectFileType(data);
  let mime: LogoImage['mime'] | null =
    known?.mime === 'image/png' || known?.mime === 'image/jpeg' ? known.mime : isWebp(data) ? 'image/webp' : null;
  if (!mime) {
    const problem = svgProblem(data);
    if (problem && problem !== 'not-svg') throw AppError.validation([{ field: LOGO_FIELD, message: problem }]);
    if (problem === null) mime = 'image/svg+xml';
  }
  if (!mime) throw AppError.validation([{ field: LOGO_FIELD, message: 'The logo must be a PNG, JPG, WebP or SVG image' }]);
  return { mime, data, version: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16) };
}
