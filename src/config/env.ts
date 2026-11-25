import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { linkProblems } from './link';

/* The project folder (src/config or dist/config is two levels below it). */
export const projectRoot = path.resolve(__dirname, '..', '..');

const NODE_ENV = process.env.NODE_ENV ?? 'development';
/* .env.test for the test run, .env for everything else; variables already set in the process win. */
dotenv.config({ path: path.join(projectRoot, NODE_ENV === 'test' ? '.env.test' : '.env') });

/* An empty value (`SMTP_HOST=`) counts as not set. */
const blank = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);
const flag = (fallback: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? fallback : v === true || v === 'true' || v === '1'), z.boolean());
const key32 = (name: string) =>
  z.string().refine((v) => Buffer.from(v, 'base64').length === 32, `${name} must be 32 random bytes, base64-encoded`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5101),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /* Origins of the portal, comma-separated. */
  CORS_ORIGINS: z.string().default('http://localhost:5176'),
  /* The portal's address, for links in e-mails. */
  PORTAL_URL: z.string().url().default('http://localhost:5176'),
  /* Reverse proxies in front of the server (for the client's IP address). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  API_DOCS: blank(z.enum(['true', 'false']).optional()),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_SSL: flag(false),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  /* Signs the sessions (students and panel users, with separate keys derived from it). */
  SESSION_SECRET: z.string().min(48, 'SESSION_SECRET must be at least 48 characters'),
  SESSION_HOURS: z.coerce.number().positive().default(12),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  /* Aadhaar numbers: encryption key and blind-index key. They must never change once students exist. */
  AADHAAR_DATA_KEY: key32('AADHAAR_DATA_KEY'),
  AADHAAR_INDEX_KEY: key32('AADHAAR_INDEX_KEY'),

  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /* Sign-up, OTP, sign-in and password requests per IP per window. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

  OTP_TTL_SECONDS: z.coerce.number().int().min(10).max(1800).default(300),
  OTP_RESEND_SECONDS: blank(z.coerce.number().int().min(10).max(1800).optional()),
  /* A fixed code for a developer's own machine (no SMS); ignored anywhere else (static-otp.ts). */
  STATIC_OTP: blank(
    z
      .string()
      .regex(/^[0-9]{6}$/, 'STATIC_OTP must be 6 digits')
      .optional(),
  ),

  SMS_API_URL: z.string().url().default('http://sms.happysms.in/api/sendhttp.php'),
  SMS_AUTH_KEY: blank(z.string().optional()),
  SMS_SENDER: blank(z.string().optional()),
  SMS_DLT_TEMPLATE_ID: blank(z.string().optional()),
  SMS_ROUTE: z.string().default('4'),
  SMS_COUNTRY: z.string().default('91'),
  /* Must be the DLT-registered template's text, with {otp}, {seconds} or {minutes} in place of its variables. */
  SMS_OTP_MESSAGE: z
    .string()
    .default(
      'Your OTP for Entrepreneurship Development Program registration is {otp}. Valid for {seconds} seconds. - Sumago Infotech',
    )
    .refine((v) => v.includes('{otp}'), 'SMS_OTP_MESSAGE must contain {otp}'),

  SMTP_HOST: blank(z.string().optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: flag(false),
  SMTP_USER: blank(z.string().optional()),
  SMTP_PASS: blank(z.string().optional()),
  SMTP_FROM: blank(z.string().optional()),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().min(1).default('storage'),
  AWS_REGION: blank(z.string().optional()),
  AWS_BUCKET_NAME: blank(z.string().optional()),
  /* Optional: without them the SDK uses the instance role. */
  AWS_ACCESS_KEY_ID: blank(z.string().optional()),
  AWS_SECRET_ACCESS_KEY: blank(z.string().optional()),
  AWS_KEY_PREFIX: z.string().default(''),

  /* The link to Sarthi, where the officers decide (docs/SARTHI_LINK.md). The secret is the same on both servers. */
  SARTHI_LINK_ENABLED: flag(false),
  SARTHI_API_URL: blank(z.string().url().optional()),
  SARTHI_LINK_SECRET: blank(z.string().min(32, 'SARTHI_LINK_SECRET must be at least 32 characters').optional()),
  SARTHI_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

  /* First contact details shown to students until the panel sets its own. */
  SUPPORT_EMAIL: blank(z.string().email().optional()),
  SUPPORT_MOBILE: blank(z.string().optional()),
  /* The first Auditor account, created by the seed when both are set. */
  PANEL_ADMIN_EMAIL: blank(z.string().email().optional()),
  PANEL_ADMIN_PASSWORD: blank(z.string().min(10).optional()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const raw = parsed.data;
const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};
if (raw.STORAGE_DRIVER === 's3' && (!raw.AWS_REGION || !raw.AWS_BUCKET_NAME))
  stop('STORAGE_DRIVER=s3 needs AWS_REGION and AWS_BUCKET_NAME');
for (const problem of linkProblems(raw)) stop(problem);
if (['staging', 'production'].includes(raw.NODE_ENV) && /CHANGE_ME/i.test(raw.SESSION_SECRET + raw.DB_PASSWORD))
  stop('Refusing to start with placeholder secrets from .env.example');

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  isLocal: raw.NODE_ENV === 'development' || raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
} as const;
