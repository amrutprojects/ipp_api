import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env, projectRoot } from '../config/env';

/*
 * Private file storage of the students' documents: never served directly, only through the API.
 *   applications/<application id>/<CODE>.<ext>          while the form is a draft
 *   candidates/<registration ID>_<name>/<CODE>.<ext>    once it is submitted
 * STORAGE_DRIVER=local keeps files under STORAGE_DIR (every key is resolved and checked to stay inside it);
 * STORAGE_DRIVER=s3 keeps them in the private bucket AWS_BUCKET_NAME, under AWS_KEY_PREFIX, encrypted at rest (SSE-S3).
 */
export const storageRoot = () => path.resolve(projectRoot, env.STORAGE_DIR);

/* Folder and file names: letters, digits, '.', '_' and '-' only (source IDs are sanitised the same way). */
export const safeSegment = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100) || '_';

export function resolveKey(key: string): string {
  const root = storageRoot();
  const full = path.resolve(root, ...key.split('/'));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Storage key escapes the storage root: ${key}`);
  return full;
}

interface StorageDriver {
  write(key: string, data: Buffer): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<Readable>;
}

const localDriver: StorageDriver = {
  async write(key, data) {
    const full = resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data, { mode: 0o600 });
  },
  async copy(fromKey, toKey) {
    const to = resolveKey(toKey);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(resolveKey(fromKey), to);
  },
  async remove(key) {
    await fs.rm(resolveKey(key), { force: true });
  },
  exists: (key) =>
    fs.access(resolveKey(key)).then(
      () => true,
      () => false,
    ),
  read: async (key) => createReadStream(resolveKey(key)),
};

/* Keys are validated the same way as on disk (no "..", no absolute paths) before they reach the bucket. */
function s3Key(key: string): string {
  const segs = key.split('/');
  if (!key || segs.some((s) => !s || s === '.' || s === '..')) throw new Error(`Invalid storage key: ${key}`);
  const prefix = env.AWS_KEY_PREFIX.replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${key}` : key;
}

function s3Driver(): StorageDriver {
  const client = new S3Client({
    region: env.AWS_REGION,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
  const Bucket = env.AWS_BUCKET_NAME!;
  const copy = (fromKey: string, toKey: string) =>
    client.send(
      new CopyObjectCommand({
        Bucket,
        CopySource: `${Bucket}/${s3Key(fromKey).split('/').map(encodeURIComponent).join('/')}`,
        Key: s3Key(toKey),
        ServerSideEncryption: 'AES256',
      }),
    );
  return {
    async write(key, data) {
      await client.send(new PutObjectCommand({ Bucket, Key: s3Key(key), Body: data, ServerSideEncryption: 'AES256' }));
    },
    async copy(fromKey, toKey) {
      await copy(fromKey, toKey);
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: s3Key(key) }));
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: s3Key(key) }));
        return true;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as Error).name === 'NotFound') return false;
        throw err;
      }
    },
    async read(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: s3Key(key) }));
      return out.Body as Readable;
    },
  };
}

let driver: StorageDriver | null = null;
const active = (): StorageDriver => (driver ??= env.STORAGE_DRIVER === 's3' ? s3Driver() : localDriver);

export const storage = {
  /* A draft's uploads, until the form is submitted. */
  draftKey: (applicationId: string, fileName: string) =>
    ['applications', safeSegment(applicationId), safeSegment(fileName)].join('/'),
  /* A submitted candidate's documents: one folder per candidate, named with the registration ID and name. */
  candidateKey: (folder: string, fileName: string) => ['candidates', safeSegment(folder), safeSegment(fileName)].join('/'),
  /* Unique per call: a replacement never overwrites the file it replaces before its database change commits. */
  versionedKey: (folder: string, fileName: string) =>
    ['candidates', safeSegment(folder), `${Date.now()}-${randomBytes(4).toString('hex')}-${safeSegment(fileName)}`].join('/'),

  write: (key: string, data: Buffer) => active().write(key, data),
  copy: (fromKey: string, toKey: string) => active().copy(fromKey, toKey),
  remove: (key: string) => active().remove(key),
  exists: (key: string) => active().exists(key),
  read: (key: string) => active().read(key),
};
