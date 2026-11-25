import type { Response } from 'supertest';
import { expect } from 'vitest';
import { one, rows } from '../../src/db/pool';
import { request, type TestPanelUser } from '../helpers/factory';

/* Calls of the panel: get(user, '/masters'), post(user, '/districts', { … }), … */
type By = Pick<TestPanelUser, 'token'>;
export const get = (by: By, path: string, query: Record<string, string | number> = {}) =>
  request('get', `/manage${path}`, by.token).query(query);
export const post = (by: By, path: string, body: object) => request('post', `/manage${path}`, by.token).send(body);
export const patch = (by: By, path: string, body: object) => request('patch', `/manage${path}`, by.token).send(body);
export const put = (by: By, path: string, body: object) => request('put', `/manage${path}`, by.token).send(body);
export const del = (by: By, path: string) => request('delete', `/manage${path}`, by.token);

/* A well-formed id nothing has. */
export const NOBODY = '00000000-0000-4000-8000-000000000000';

/* What a 422 says: field → message (the first of each field). */
export function issues(res: Response): Record<string, string> {
  expect(res.status).toBe(422);
  expect(res.body).toMatchObject({
    success: false,
    message: 'Validation failed',
    data: null,
    error: { code: 'VALIDATION_ERROR' },
  });
  const out: Record<string, string> = {};
  for (const d of res.body.error.details as { field: string; message: string }[]) out[d.field] ??= d.message;
  return out;
}

export function refused(res: Response, status: 400 | 404 | 409, message: string): void {
  expect({ status: res.status, message: res.body.message, data: res.body.data }).toEqual({ status, message, data: null });
  expect(res.body.error.code).toBe({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' }[status]);
}

/* Of two requests at the same time one is done; the other one is answered with the message. */
export function oneOf(done: number, results: Response[], status: 400 | 404 | 409, message: string): Response {
  const [won, lost] = [...results].sort((a, b) => a.status - b.status) as [Response, Response];
  expect([won.status, lost.status]).toEqual([done, status]);
  refused(lost, status, message);
  return won;
}

/* The audit log of some actions, oldest first. */
export const audits = (like: string) =>
  rows<{ action: string; resource: string; resource_id: string; actor_kind: string; actor_id: string; details: unknown }>(
    'SELECT action, resource, resource_id, actor_kind, actor_id, details FROM audit_logs WHERE action LIKE $1 ORDER BY id',
    [like],
  );

/* A row of a master as it is stored, whether it is deleted or not. */
export const stored = async (
  table: 'program_options' | 'program_documents' | 'program_fields' | 'states' | 'districts' | 'talukas' | 'centres',
  id: string,
) =>
  (await one<{ is_active: boolean; deleted: boolean }>(
    `SELECT is_active, (deleted_at IS NOT NULL) AS deleted FROM ${table} WHERE id = $1`,
    [id],
  ))!;
