import { config } from '../../config';
import { signedHeaders } from './signature';

/*
 * One call to Sarthi's API. What goes wrong is told without any value that was sent: whether it is worth trying again, and a
 * text for the panel.
 */
export type Fetch = typeof fetch;

export type Answer =
  /* 200 in the usual envelope. */
  | { kind: 'done'; data: Record<string, unknown> }
  /* Not reachable, not signed right, too busy, or broken: try again later. */
  | { kind: 'later'; error: string }
  /* Refused for what it says: trying again changes nothing until somebody does something. */
  | { kind: 'refused'; error: string };

const RETRY_STATUS = [401, 408, 429];
const ERROR_MAX = 300;

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const cut = (v: string) => (v.length > ERROR_MAX ? `${v.slice(0, ERROR_MAX - 1)}…` : v);

/* The link is on and its settings are there. */
export const linkReady = () => config.link.enabled && !!config.link.url && !!config.link.secret;

function refusal(status: number, body: Record<string, unknown> | null): string {
  const error = (body?.error ?? {}) as { code?: unknown };
  const what = [text(error.code), text(body?.message)].filter(Boolean).join(': ');
  return cut(what || `Sarthi answered ${status}`);
}

export async function callSarthi(doFetch: Fetch, method: 'GET' | 'POST', path: string, body: string, now: Date): Promise<Answer> {
  const { url, secret, timeoutMs } = config.link;
  if (!url || !secret) return { kind: 'later', error: 'The connection to Sarthi is not set up' };
  let status: number;
  let parsed: Record<string, unknown> | null = null;
  try {
    const res = await doFetch(url + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...signedHeaders(secret, { client: 'ipp', method, path, body }, now),
      },
      ...(body ? { body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch (err) {
    const slow = err instanceof Error && err.name === 'TimeoutError';
    return { kind: 'later', error: slow ? 'Sarthi did not answer in time' : 'Sarthi could not be reached' };
  }
  if (status === 200) {
    if (parsed?.success === true && parsed.data && typeof parsed.data === 'object')
      return { kind: 'done', data: parsed.data as Record<string, unknown> };
    return { kind: 'later', error: 'The answer is not from the Sarthi API (check SARTHI_API_URL)' };
  }
  if (status === 401)
    return { kind: 'later', error: 'Sarthi refused the signature (check the secret and the clocks of both servers)' };
  if (RETRY_STATUS.includes(status) || status >= 500 || status < 400)
    return { kind: 'later', error: cut(`Sarthi answered ${status}${parsed ? ` (${refusal(status, parsed)})` : ''}`) };
  return { kind: 'refused', error: refusal(status, parsed) };
}

export const MESSAGES_PATH = '/integration/v1/ipp/messages';
export const PING_PATH = '/integration/v1/ipp/ping';
