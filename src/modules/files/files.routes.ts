import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { one } from '../../db/pool';
import { Api } from '../../http/api';
import { AppError } from '../../http/errors';
import { logger } from '../../lib/logger';
import { fileOfToken, LINK_SECONDS } from '../../program/file-links';
import { storage } from '../../services/storage';

/*
 * GET /files/:token — a document by its short-lived link (program/file-links.ts), streamed so the browser shows it as it
 * arrives. No session: the signed, expiring token is the permission, asked for by a signed-in student or panel user. The
 * types served are the ones the uploads were checked to be (PDF, JPEG, PNG, MP4), never sniffed; the address and its answer
 * are kept out of shared caches, referrers and search engines.
 */
export const filesApi = new Api('Documents by link');

const LINK_GONE = 'This link has expired or the document is no longer there. Open it again from the page.';

const inline = (name: string) => {
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"; filename*=UTF-8''${exact}`;
};

filesApi.get(
  '/files/:token',
  {
    auth: 'public',
    summary: `A document by the link its …/documents/:docType/link gave (works for ${LINK_SECONDS} seconds)`,
    file: 'application/octet-stream',
    params: z.object({ token: z.string().max(300).regex(/^[\w-]+\.[\w-]+$/, 'Not a document link') }),
    notFound: LINK_GONE,
  },
  async ({ res, params }) => {
    const id = fileOfToken(params.token);
    const f = id
      ? await one<{ storage_key: string; mime_type: string; original_name: string; size_bytes: number }>(
          `SELECT f.storage_key, f.mime_type, f.original_name, f.size_bytes
           FROM application_files f JOIN applications p ON p.id = f.application_id
           WHERE f.id = $1 AND p.deleted_at IS NULL`,
          [id],
        )
      : null;
    if (!f) throw AppError.notFound(LINK_GONE);
    const body = await storage.read(f.storage_key);
    res.setHeader('Content-Type', f.mime_type);
    res.setHeader('Content-Length', String(f.size_bytes));
    res.setHeader('Content-Disposition', inline(f.original_name));
    res.setHeader('Cache-Control', `private, max-age=${LINK_SECONDS}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      await pipeline(body, res);
    } catch (err) {
      /* Not the error itself: its text may hold a file's path, with the student's name. */
      logger.warn({ reason: (err as NodeJS.ErrnoException).code ?? 'unknown' }, 'a document was not sent to the end');
    }
  },
);
