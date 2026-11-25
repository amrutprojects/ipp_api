import { config } from '../config';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../http/errors';

const TIMEOUT_MS = 10_000;

const unavailable = () =>
  AppError.unavailable('The OTP SMS could not be sent right now. Please try again in a few minutes.', 'SMS_UNAVAILABLE');
const masked = (mobile: string) => `XXXXXX${mobile.slice(-4)}`;

/* The template with {otp}, {seconds} and {minutes} (whole minutes, at least 1) filled in. Exported for tests. */
export const otpSmsText = (otp: string, ttlSeconds: number) =>
  config.sms.otpMessage
    .replace(/\{otp\}/g, otp)
    .replace(/\{seconds\}/g, String(ttlSeconds))
    .replace(/\{minutes\}/g, String(Math.max(1, Math.round(ttlSeconds / 60))));

/*
 * Whether the gateway accepted the message. Gateways of this family answer 200 even on failure, with either JSON
 * ({"type":"success"|"error", ...}) or a plain-text reason, so the body decides. Exported for tests.
 */
export function smsAccepted(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  const text = body.trim();
  if (!text) return false;
  try {
    const json = JSON.parse(text) as { type?: unknown; status?: unknown };
    const verdict = String(json.type ?? json.status ?? '').toLowerCase();
    if (verdict) return verdict === 'success' || verdict === 'ok';
  } catch {
    /* not JSON: judged on the text below */
  }
  return !/error|fail|invalid|insufficient|denied|not\s+allowed|blocked|reject/i.test(text);
}

/*
 * Sends the one-time code to a 10-digit Indian mobile number through the SMS gateway (SMS_*). Without SMS_AUTH_KEY,
 * development and test runs write the code to the API log so the flow can be tried locally; any other environment
 * refuses (503). The request URL carries the gateway key, so it is never logged. With a fixed local code
 * (STATIC_OTP, static-otp.ts) nothing is sent.
 */
async function sendOtp(mobile: string, otp: string, ttlSeconds: number): Promise<void> {
  if (config.otp.fixed) {
    logger.info(
      { mobile: masked(mobile) },
      'Program OTP SMS not sent: the fixed local code is used (STATIC_OTP, development on localhost only)',
    );
    return;
  }
  const gateway = config.sms;
  if (!gateway.authKey || !gateway.sender || !gateway.templateId) {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      logger.error('Program OTP SMS NOT sent: SMS_AUTH_KEY, SMS_SENDER and SMS_DLT_TEMPLATE_ID must all be set');
      throw unavailable();
    }
    logger.warn(
      { mobile: masked(mobile), otp },
      'Program OTP SMS NOT sent: SMS gateway is not configured (development only, logged instead)',
    );
    return;
  }
  const url = new URL(gateway.url);
  url.search = new URLSearchParams({
    authkey: gateway.authKey,
    mobiles: mobile,
    message: otpSmsText(otp, ttlSeconds),
    sender: gateway.sender,
    route: gateway.route,
    country: gateway.country,
    DLT_TE_ID: gateway.templateId,
    response: 'json',
  }).toString();
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    if (!smsAccepted(res.status, body)) {
      logger.error(
        { mobile: masked(mobile), status: res.status, response: body.slice(0, 300) },
        'Program OTP SMS was rejected by the gateway',
      );
      throw unavailable();
    }
    /* Accepted is not delivered: a text that does not match the DLT template is dropped later by the operator. */
    logger.info(
      { mobile: masked(mobile), status: res.status, response: body.slice(0, 300) },
      'Program OTP SMS accepted by the gateway',
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(
      { mobile: masked(mobile), err: err instanceof Error ? err.message : String(err) },
      'Program OTP SMS could not be sent',
    );
    throw unavailable();
  }
}

export const sms = { sendOtp };
