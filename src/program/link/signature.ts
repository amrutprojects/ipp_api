import crypto from 'node:crypto';

/*
 * The signature of every call between IPP and Sarthi (docs/SARTHI_LINK.md, section 1). The caller is part of the signed text,
 * so a message cannot be sent back to the one who sent it.
 */
export type LinkClient = 'ipp' | 'sarthi';
/* How far the caller's clock may be from this one. */
export const MAX_AGE_SECONDS = 300;

const sha256 = (body: string | Buffer) => crypto.createHash('sha256').update(body).digest('hex');

export interface SignedCall {
  client: LinkClient;
  method: string;
  /* With the query, as sent. */
  path: string;
  /* Unix time in seconds, as sent. */
  timestamp: string;
  body: string | Buffer;
}

export const signature = (secret: string, c: SignedCall): string =>
  crypto
    .createHmac('sha256', secret)
    .update([c.client, c.method.toUpperCase(), c.path, c.timestamp, sha256(c.body)].join('\n'))
    .digest('hex');

/* The headers of a call. */
export function signedHeaders(secret: string, c: Omit<SignedCall, 'timestamp'>, now: Date) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    Authorization: `IPP-SARTHI ${c.client}:${signature(secret, { ...c, timestamp })}`,
    'X-Timestamp': timestamp,
  };
}

/* Whether a received call is signed by `expected`, with this secret, now. The signatures are compared in constant time. */
export function isSigned(
  secret: string,
  expected: LinkClient,
  headers: { authorization: string | undefined; timestamp: string | undefined },
  call: Pick<SignedCall, 'method' | 'path' | 'body'>,
  now: Date,
): boolean {
  const given = /^IPP-SARTHI ([a-z]{1,20}):([0-9a-f]{64})$/.exec(headers.authorization ?? '');
  const timestamp = headers.timestamp ?? '';
  if (!given || given[1] !== expected || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const right = signature(secret, { client: expected, ...call, timestamp });
  return crypto.timingSafeEqual(Buffer.from(given[2]!, 'hex'), Buffer.from(right, 'hex'));
}
