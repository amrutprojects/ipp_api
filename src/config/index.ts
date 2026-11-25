import { env } from './env';
import { staticOtpFor } from './static-otp';

/* Settings derived from the environment, grouped by what they are for. Tests replace single values. */
export const config = {
  port: env.PORT,
  apiPrefix: '/api/v1',
  /* The portal's routes. '/edp' is the address today's portal calls; '/ipp' is the same API under the program's own name. */
  portalMounts: ['/ipp', '/edp'],
  apiDocs: env.API_DOCS ? env.API_DOCS === 'true' : !env.isProduction,
  portalUrl: env.PORTAL_URL.replace(/\/+$/, ''),
  sessionHours: env.SESSION_HOURS,
  bcryptRounds: env.BCRYPT_ROUNDS,
  rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX, authMax: env.AUTH_RATE_LIMIT_MAX },
  otp: {
    ttlSeconds: env.OTP_TTL_SECONDS,
    /* A new code only once the current one has expired, unless a shorter wait is set. */
    resendSeconds: Math.min(env.OTP_RESEND_SECONDS ?? env.OTP_TTL_SECONDS, env.OTP_TTL_SECONDS),
    /* The code on a developer's own machine (no SMS); null = a random code by SMS. */
    fixed: staticOtpFor(env.NODE_ENV, env.PORTAL_URL, env.STATIC_OTP),
  },
  sms: {
    url: env.SMS_API_URL,
    authKey: env.SMS_AUTH_KEY,
    sender: env.SMS_SENDER,
    templateId: env.SMS_DLT_TEMPLATE_ID,
    route: env.SMS_ROUTE,
    country: env.SMS_COUNTRY,
    otpMessage: env.SMS_OTP_MESSAGE,
  },
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM ?? env.SMTP_USER,
  },
  support: { email: env.SUPPORT_EMAIL ?? null, mobile: env.SUPPORT_MOBILE ?? null },
};
