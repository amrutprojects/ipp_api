import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { storage as Storage } from '../src/services/storage';

/* The S3 storage: what is asked of the bucket. Nothing is sent: the client is replaced by one that takes notes. */
const sent = vi.hoisted(() => [] as { command: string; input: Record<string, unknown> }[]);
const answers = vi.hoisted(() => ({ next: null as null | (() => unknown) }));
vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      name = name;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      async send(c: { name: string; input: Record<string, unknown> }) {
        sent.push({ command: c.name, input: c.input });
        return answers.next?.() ?? {};
      }
    },
    CopyObjectCommand: command('copy'),
    DeleteObjectCommand: command('delete'),
    GetObjectCommand: command('get'),
    HeadObjectCommand: command('head'),
    PutObjectCommand: command('put'),
  };
});

let storage: typeof Storage;
beforeAll(async () => {
  process.env.STORAGE_DRIVER = 's3';
  process.env.AWS_REGION = 'test-region';
  process.env.AWS_BUCKET_NAME = 'test-bucket';
  process.env.AWS_KEY_PREFIX = '/program/';
  ({ storage } = await import('../src/services/storage'));
});
const last = () => sent[sent.length - 1]!;

describe('S3 storage', () => {
  it("copies within a student's folder named after them, the source fully encoded", async () => {
    await storage.copy("candidates/Ravi D'Souza 9876543210/PHOTO-1.pdf", "candidates/Ravi D'Souza 9876543210/PHOTO.pdf");
    expect(last()).toMatchObject({
      command: 'copy',
      input: {
        CopySource: 'test-bucket/program/candidates/Ravi%20D%27Souza%209876543210/PHOTO-1.pdf',
        Key: "program/candidates/Ravi D'Souza 9876543210/PHOTO.pdf",
      },
    });
    await storage.write(storage.studentKey('आशा जोशी 9876543210', 'PHOTO.pdf'), Buffer.from('x'));
    expect(last().input.Key).toBe('program/candidates/आशा जोशी 9876543210/PHOTO.pdf');
    expect(() => storage.studentKey('../x', 'PHOTO.pdf')).toThrow('Invalid storage folder');
    expect(() => storage.studentKey('..', 'PHOTO.pdf')).toThrow('Invalid storage folder');
  });

  it('writes encrypted, under the prefix', async () => {
    await storage.write('candidates/IPP-000001_A/PHOTO.png', Buffer.from('x'));
    expect(last()).toMatchObject({
      command: 'put',
      input: { Bucket: 'test-bucket', Key: 'program/candidates/IPP-000001_A/PHOTO.png', ServerSideEncryption: 'AES256' },
    });
  });

  it('copies inside the bucket, with the name encoded', async () => {
    await storage.copy('applications/a b/PHOTO.png', 'candidates/c/PHOTO.png');
    expect(last()).toMatchObject({
      command: 'copy',
      input: { CopySource: 'test-bucket/program/applications/a%20b/PHOTO.png', Key: 'program/candidates/c/PHOTO.png' },
    });
  });

  it('reads and deletes by key', async () => {
    answers.next = () => ({ Body: Readable.from(['hello']) });
    let text = '';
    for await (const chunk of await storage.read('candidates/c/PHOTO.png')) text += String(chunk);
    expect(text).toBe('hello');
    answers.next = null;
    await storage.remove('candidates/c/PHOTO.png');
    expect(last()).toMatchObject({ command: 'delete', input: { Key: 'program/candidates/c/PHOTO.png' } });
  });

  it('tells a missing file from a failure', async () => {
    answers.next = () => {
      throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    };
    expect(await storage.exists('x/y')).toBe(false);
    answers.next = () => {
      throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    };
    await expect(storage.exists('x/y')).rejects.toThrow('denied');
    answers.next = null;
  });

  it('never leaves its place', async () => {
    const before = sent.length;
    for (const key of ['', '../x', 'a/../b', '/x', 'a//b', './x'])
      await expect(storage.write(key, Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
    expect(sent).toHaveLength(before);
    expect(storage.draftKey('../../etc', '../passwd')).not.toContain('..' + '/');
    expect(storage.versionedKey('f', 'PHOTO.png')).not.toBe(storage.versionedKey('f', 'PHOTO.png'));
  });
});
