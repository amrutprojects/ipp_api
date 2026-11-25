import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../src/db/pool';
import { seed } from '../src/db/seeds';
import { aadhaarBlindIndex, decryptAadhaar, encryptAadhaar } from '../src/lib/aadhaar';
import { readSession, signSession } from '../src/lib/tokens';
import { loadProgram } from '../src/program/masters';
import { closeDatabase, resetDatabase } from './helpers/db';
import { app, FILES, makeApplication, makeBatch, makeCentre, makePanelUser, newAadhaar } from './helpers/factory';

beforeAll(resetDatabase);
afterAll(closeDatabase);

describe('foundation', () => {
  it('answers health checks and unknown routes in one shape, with a request id', async () => {
    const health = await supertest(app).get('/api/v1/health');
    expect(health.body).toMatchObject({ success: true, status: 200 });
    expect((await supertest(app).get('/api/v1/health/ready')).body.data).toEqual({ status: 'ok', database: 'ok' });
    const lost = await supertest(app).get('/api/v1/edp/nothing-here');
    expect(lost.status).toBe(404);
    expect(lost.body).toMatchObject({ success: false, status: 404, data: null, error: { code: 'ROUTE_NOT_FOUND' } });
    expect(lost.body.error.requestId).toBe(lost.headers['x-request-id']);
  });

  it('sends security headers, and allows only the portal as an origin', async () => {
    const own = await supertest(app).get('/api/v1/health').set('Origin', 'http://localhost:5176');
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['x-powered-by']).toBeUndefined();
    const portal = await supertest(app).get('/api/v1/edp/nothing').set('Origin', 'http://localhost:5176');
    expect(portal.headers['access-control-allow-origin']).toBe('http://localhost:5176');
    const other = await supertest(app).get('/api/v1/edp/nothing').set('Origin', 'http://evil.test');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('documents every endpoint', async () => {
    const doc = await supertest(app).get('/api/openapi.json');
    expect(doc.status).toBe(200);
    expect(doc.body.openapi).toBe('3.0.3');
  });

  it('keeps student and panel sessions apart', () => {
    const { token } = signSession('student', 'a', 0);
    expect(readSession('student', token)).toEqual({ id: 'a', pv: 0 });
    expect(() => readSession('panel', token)).toThrow(/session has expired/);
  });

  it('stores the Aadhaar number encrypted and finds it by its index', () => {
    const digits = newAadhaar();
    const a = encryptAadhaar(digits);
    expect(a.equals(encryptAadhaar(digits))).toBe(false);
    expect(a.toString('latin1')).not.toContain(digits);
    expect(decryptAadhaar(a)).toBe(digits);
    expect(aadhaarBlindIndex(digits)).toHaveLength(64);
  });

  it('seeds the masters once and never brings a deleted one back', async () => {
    const program = await loadProgram();
    expect(program.fields).toHaveLength(36);
    expect(program.documents()).toHaveLength(10);
    expect(program.options('TECHNOLOGY').map((o) => o.code)).toContain('T12');
    await pool.query(
      `UPDATE program_options SET is_active = false, deleted_at = now() WHERE kind = 'GENDER' AND code = 'Transgender'`,
    );
    expect(Object.values(await seed()).every((n) => n === 0)).toBe(true);
    expect((await loadProgram()).options('GENDER')).toHaveLength(2);
  });

  it('keeps approval events, edits and the audit log append-only', async () => {
    const by = await makePanelUser();
    const centre = await makeCentre();
    const { applicationId } = await makeApplication('BATCH', { centre, by });
    await expect(pool.query(`DELETE FROM approval_events WHERE application_id = $1`, [applicationId])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`UPDATE approval_events SET reason = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('refuses a form in a state that cannot be', async () => {
    const by = await makePanelUser();
    const centre = await makeCentre();
    const { applicationId } = await makeApplication('BATCH', { centre, by });
    /* Past the batch without a batch. */
    await expect(pool.query(`UPDATE applications SET approval_stage = 'COEP' WHERE id = $1`, [applicationId])).rejects.toThrow(
      /ck_applications_in_batch/,
    );
    const draft = await makeApplication('MAIN_DONE', { centre });
    await expect(pool.query(`UPDATE applications SET status = 'SUBMITTED' WHERE id = $1`, [draft.applicationId])).rejects.toThrow(
      /ck_applications_submitted/,
    );
    /* The Aadhaar number never goes into the form's values. */
    await expect(
      pool.query(`UPDATE applications SET data = data || '{"aadhaar_number":"1"}' WHERE id = $1`, [draft.applicationId]),
    ).rejects.toThrow(/check constraint/);
  });

  it('keeps the district, caste and center columns in step with the form', async () => {
    const by = await makePanelUser();
    const centre = await makeCentre();
    const batch = await makeBatch({ centre, by });
    const { applicationId } = await makeApplication('RETURNED', { centre, by, batch });
    const row = await one<{ centre_id: string; district_id: string; approval_stage: string | null }>(
      `SELECT centre_id, district_id, approval_stage FROM applications WHERE id = $1`,
      [applicationId],
    );
    expect(row).toMatchObject({ centre_id: centre, approval_stage: null });
    await pool.query(`UPDATE applications SET data = data || '{"district_id":"not an id"}' WHERE id = $1`, [applicationId]);
    expect(
      (await one<{ district_id: string | null }>(`SELECT district_id FROM applications WHERE id = $1`, [applicationId]))!
        .district_id,
    ).toBe(null);
    expect(FILES.pdf.length).toBeGreaterThan(10);
  });
});
