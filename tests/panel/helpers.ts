import type { Response } from 'supertest';
import yauzl from 'yauzl';
import { one, pool, rows } from '../../src/db/pool';
import { request } from '../helpers/factory';

/* Requests to the panel: get('/manage/me', token). */
export const get = (path: string, token?: string) => request('get', path, token);
export const post = (path: string, token?: string, body?: object) => request('post', path, token).send(body);
export const put = (path: string, token?: string, body?: object) => request('put', path, token).send(body);
export const patch = (path: string, token?: string, body?: object) => request('patch', path, token).send(body);

export const UNKNOWN_ID = '7b1f2c3e-1111-4222-8333-444455556666';

/* The wrong fields of an answer, and the answer's error details. */
export const fieldsOf = (res: Response): string[] =>
  ((res.body.error?.details ?? []) as { field: string }[]).map((d) => d.field).sort();
export const detailsOf = (res: Response): unknown[] => res.body.error?.details ?? [];

/* A whole answer read as bytes (a file). */
export const bytes = (path: string, token: string) =>
  get(path, token)
    .buffer(true)
    .parse((res, done) => {
      const parts: Buffer[] = [];
      res.on('data', (x: Buffer) => parts.push(x));
      res.on('end', () => done(null, Buffer.concat(parts)));
    });

/* The entries of a ZIP: their names and contents, in order. */
export const unzip = (data: Buffer) =>
  new Promise<{ name: string; content: Buffer }[]>((resolve, reject) =>
    yauzl.fromBuffer(data, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const entries: { name: string; content: Buffer }[] = [];
      zip.on('entry', (e) =>
        zip.openReadStream(e, (failure, stream) => {
          if (failure || !stream) return reject(failure);
          const parts: Buffer[] = [];
          stream.on('data', (x: Buffer) => parts.push(x));
          stream.on('end', () => {
            entries.push({ name: e.fileName, content: Buffer.concat(parts) });
            zip.readEntry();
          });
        }),
      );
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    }),
  );

export interface AuditRow {
  action: string;
  resource: string;
  resource_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  request_id: string | null;
}
/* The audit log of an action, oldest first. */
export const audits = (action: string) =>
  rows<AuditRow>(
    `SELECT action, resource, resource_id, actor_kind, actor_id, details, request_id FROM audit_logs WHERE action = $1 ORDER BY id`,
    [action],
  );

export interface ApplicationRow {
  id: string;
  status: string;
  data: Record<string, string>;
  approval_stage: string | null;
  batch_id: string | null;
  stage_updated_at: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
  documents_verified_at: Date | null;
  documents_verified_by: string | null;
  aadhaar_index: string | null;
  aadhaar_last4: string | null;
  district_id: string | null;
}
export const applicationRow = async (accountId: string) =>
  (await one<ApplicationRow>(`SELECT * FROM applications WHERE account_id = $1`, [accountId]))!;

export const eventsOf = async (accountId: string) =>
  rows<{ action: string; from_stage: string; to_stage: string; actor_kind: string; panel_user_id: string | null }>(
    `SELECT e.action, e.from_stage, e.to_stage, e.actor_kind, e.panel_user_id FROM approval_events e
     JOIN applications p ON p.id = e.application_id WHERE p.account_id = $1 ORDER BY e.seq`,
    [accountId],
  );

/* Puts a batched form at a later stage (the officers' part is not in this portal). */
export const setStage = (accountId: string, stage: string) =>
  pool.query(`UPDATE applications SET approval_stage = $2 WHERE account_id = $1`, [accountId, stage]);

export const setBatchSize = (size: number) =>
  pool.query(`INSERT INTO settings (key, value) VALUES ('batch', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
    JSON.stringify({ size }),
  ]);
