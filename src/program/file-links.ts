import crypto from 'node:crypto';
import { config } from '../config';
import { env } from '../config/env';

/*
 * A short-lived link to one uploaded document, so a browser tab opens it straight from the API and shows it as it arrives
 * (the PDF viewer, an image, a video) instead of a blank tab until the whole file has been fetched by the page. The link is
 * asked for by the signed-in student or panel user (…/documents/:docType/link), names the file by its row id only (no name,
 * mobile number or storage path in the address), is signed with the server's secret and works for LINK_SECONDS.
 */
export const LINK_SECONDS = 120;

/* Its own key, derived from the session secret: a file link is never a session token, nor the other way round. */
const linkKey = () => crypto.createHmac('sha256', env.SESSION_SECRET).update('ipp:file-link').digest();
const sign = (payload: string) => crypto.createHmac('sha256', linkKey()).update(payload).digest();

/* A link's token for the file `fileId` (application_files.id), and when it stops working. */
export function fileToken(fileId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + LINK_SECONDS;
  const payload = `${fileId}.${exp}`;
  return { token: `${Buffer.from(payload).toString('base64url')}.${sign(payload).toString('base64url')}`, expiresAt: new Date(exp * 1000) };
}

/* The file a token names, or null when it is not one of ours, was changed, or has expired. */
export function fileOfToken(token: string, now = Date.now()): string | null {
  const [encoded, signature, ...rest] = token.split('.');
  if (!encoded || !signature || rest.length) return null;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const want = sign(payload);
  const got = Buffer.from(signature, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})$/.exec(payload);
  if (!m || Number(m[2]) * 1000 < now) return null;
  return m[1]!;
}

/* The address of a file link, on the portal's own mount (the portal calls the API as /api/v1/edp/…). */
export const fileLinkUrl = (token: string) => `${config.apiPrefix}/edp/files/${token}`;

/* The answer of a …/link endpoint. */
export function fileLink(fileId: string) {
  const { token, expiresAt } = fileToken(fileId);
  return { url: fileLinkUrl(token), expires_at: expiresAt };
}
