import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Client, type QueryResultRow } from 'pg';
import { z } from 'zod';

/*
 * The system the data comes from (LEGACY_*): its database, read-only, in one consistent snapshot; the key its Aadhaar numbers
 * are encrypted with; and its file storage.
 */
const blank = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);
const settings = z
  .object({
    LEGACY_DB_HOST: z.string().min(1),
    LEGACY_DB_PORT: z.coerce.number().int().positive().default(5432),
    LEGACY_DB_USER: z.string().min(1),
    LEGACY_DB_PASSWORD: z.string(),
    LEGACY_DB_NAME: z.string().min(1),
    LEGACY_DB_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default('public'),
    LEGACY_DB_SSL: blank(z.enum(['true', 'false']).default('false')),
    LEGACY_DATA_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'LEGACY_DATA_KEY must be 32 bytes, base64 (STUDENT_DATA_KEY)'),
    LEGACY_STORAGE_DRIVER: blank(z.enum(['local', 's3']).default('local')),
    LEGACY_STORAGE_DIR: blank(z.string().optional()),
    LEGACY_AWS_REGION: blank(z.string().optional()),
    LEGACY_AWS_BUCKET_NAME: blank(z.string().optional()),
    LEGACY_AWS_KEY_PREFIX: z.string().default(''),
  })
  .refine((v) => v.LEGACY_STORAGE_DRIVER === 's3' || v.LEGACY_STORAGE_DIR, {
    message: 'LEGACY_STORAGE_DIR is needed for local files',
    path: ['LEGACY_STORAGE_DIR'],
  })
  .refine((v) => v.LEGACY_STORAGE_DRIVER === 'local' || (v.LEGACY_AWS_REGION && v.LEGACY_AWS_BUCKET_NAME), {
    message: 'LEGACY_AWS_REGION and LEGACY_AWS_BUCKET_NAME are needed for files in S3',
    path: ['LEGACY_AWS_BUCKET_NAME'],
  });

export interface Source {
  rows<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  decryptAadhaar(blob: Buffer): string;
  /* The content of a stored file; null = it is not there. */
  file(key: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

/* A key never leaves the storage folder. */
const validKey = (key: string) => !!key && key.split('/').every((s) => s && s !== '.' && s !== '..');

export async function openSource(vars: NodeJS.ProcessEnv): Promise<Source> {
  const parsed = settings.safeParse(vars);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  const s = parsed.data;
  const client = new Client({
    host: s.LEGACY_DB_HOST,
    port: s.LEGACY_DB_PORT,
    user: s.LEGACY_DB_USER,
    password: s.LEGACY_DB_PASSWORD,
    database: s.LEGACY_DB_NAME,
    ssl: s.LEGACY_DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    options: `-c search_path=${s.LEGACY_DB_SCHEMA} -c default_transaction_read_only=on`,
  });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const key = Buffer.from(s.LEGACY_DATA_KEY, 'base64');
  const s3 = s.LEGACY_STORAGE_DRIVER === 's3' ? new S3Client({ region: s.LEGACY_AWS_REGION }) : null;
  const prefix = s.LEGACY_AWS_KEY_PREFIX.replace(/^\/+|\/+$/g, '');

  return {
    async rows<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
      return (await client.query<T>(sql, params)).rows;
    },
    decryptAadhaar(blob) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
    },
    async file(name) {
      if (!validKey(name)) return null;
      try {
        if (!s3) return await fs.readFile(path.join(s.LEGACY_STORAGE_DIR!, ...name.split('/')));
        const out = await s3.send(
          new GetObjectCommand({ Bucket: s.LEGACY_AWS_BUCKET_NAME, Key: prefix ? `${prefix}/${name}` : name }),
        );
        return Buffer.from(await out.Body!.transformToByteArray());
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
        if (code === 'ENOENT' || code === 'NoSuchKey' || code === 'NotFound') return null;
        throw err;
      }
    },
    async close() {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    },
  };
}
