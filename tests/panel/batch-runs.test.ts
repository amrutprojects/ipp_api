import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { makeApplication, makeBatch, makeCentre, makePanelUser, PASSWORD, type TestPanelUser } from '../helpers/factory';
import { audits, detailsOf, get, post, setStage } from './helpers';

/* Starting and ending a batch (POST /manage/batches/:id/start and /end), confirmed with the e-mail and password. */
let admin: TestPanelUser;
let viewer: TestPanelUser;
let centre: string;
let batchId: string;
let pending: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  viewer = await makePanelUser('VIEWER');
  centre = await makeCentre({ name: 'Nashik Center', code: 'NC-1' });
  batchId = await makeBatch({ centre, by: admin, size: 30 });
  await makeApplication('APPROVED', { centre, by: admin, batch: batchId });
  pending = (await makeApplication('DIVISION', { centre, by: admin, batch: batchId })).student.id;
});
afterAll(closeDatabase);

/* Now: the batch was made a moment ago, and a batch cannot start before it was made. */
const justNow = () => new Date().toISOString();
const confirm = (over: object = {}, who: TestPanelUser = admin) => ({ email: who.email, password: PASSWORD, at: justNow(), ...over });
const start = (body: object = confirm(), token = admin.token) => post(`/manage/batches/${batchId}/start`, token, body);
const end = (body: object = confirm(), token = admin.token) => post(`/manage/batches/${batchId}/end`, token, body);
const runOf = async () => (await get(`/manage/batches/${batchId}`, admin.token)).body.data;
const messages = () =>
  rows<{ kind: string }>(`SELECT kind FROM link_outbox WHERE batch_id = $1 AND kind = 'BATCH_UPDATE' ORDER BY seq`, [batchId]);

describe('starting and ending a batch', () => {
  it('starts once every student is final approved, at the given time, and ends after it', async () => {
    let b = await runOf();
    expect(b.run).toEqual({ status: 'NOT_STARTED', ready: false, started_at: null, started_by: null, ended_at: null, ended_by: null });
    expect(b.runs).toEqual([]);
    /* One student is still with the Divisional Officer. */
    let res = await start();
    expect([res.status, res.body.message]).toEqual([409, 'A batch starts once every student of it is final approved: 1 of 2 are now.']);

    await setStage(pending, 'APPROVED');
    expect((await runOf()).run).toMatchObject({ status: 'NOT_STARTED', ready: true });
    const startedAt = justNow();
    res = await start(confirm({ at: startedAt }));
    expect(res.status).toBe(200);
    expect(res.body.data.run).toMatchObject({ status: 'ONGOING', started_by: 'Program Auditor', ended_at: null });
    expect(new Date(res.body.data.run.started_at).toISOString()).toBe(startedAt);
    /* Only once. */
    expect((await start()).status).toBe(409);
    /* The list shows it too. */
    const listed = (await get('/manage/batches', admin.token)).body.data.find((x: { id: string }) => x.id === batchId);
    expect(listed.run.status).toBe('ONGOING');

    /* Not before it started. */
    res = await end(confirm({ at: new Date(Date.parse(startedAt) - 60_000).toISOString() }));
    expect([res.status, detailsOf(res)]).toEqual([422, [{ field: 'body.at', message: 'The end cannot be before the batch started.' }]]);
    const endedAt = new Date().toISOString();
    res = await end(confirm({ at: endedAt }));
    expect(res.status).toBe(200);
    expect(res.body.data.run).toMatchObject({ status: 'ENDED', ended_by: 'Program Auditor' });
    expect((await end()).status).toBe(409);

    /* The history keeps both, oldest first. */
    b = await runOf();
    expect(b.runs.map((r: { action: string; by: string; at: string }) => [r.action, r.by, new Date(r.at).toISOString()])).toEqual([
      ['START', 'Program Auditor', startedAt],
      ['END', 'Program Auditor', endedAt],
    ]);
    /* Sarthi is told each time, and each is audited. */
    expect(await messages()).toHaveLength(2);
    expect((await audits('edp.batch.start')).map((a) => a.resource_id)).toEqual([batchId]);
    expect((await audits('edp.batch.end')).map((a) => a.resource_id)).toEqual([batchId]);
  });

  it('asks the e-mail and password of the signed-in user, and keeps them signed in when they are wrong', async () => {
    await setStage(pending, 'APPROVED');
    const other = await makePanelUser('ADMIN');
    for (const body of [confirm({ password: 'wrong-password' }), confirm({ email: other.email })]) {
      const res = await start(body);
      expect(res.status).toBe(422);
      expect(detailsOf(res)).toEqual([
        { field: 'body.password', message: 'The email or password is not right. Enter the ones you are signed in with.' },
      ]);
    }
    expect((await runOf()).run.status).toBe('NOT_STARTED');
    /* The e-mail in any case. */
    expect((await start(confirm({ email: admin.email.toUpperCase() }))).status).toBe(200);
  });

  it('refuses a time in the future or before the batch was made, missing fields, and a viewer', async () => {
    await setStage(pending, 'APPROVED');
    let res = await start(confirm({ at: new Date(Date.now() + 86_400_000).toISOString() }));
    expect(detailsOf(res)).toEqual([{ field: 'body.at', message: 'The start cannot be in the future.' }]);
    res = await start(confirm({ at: '2020-01-01T10:00:00.000Z' }));
    expect(detailsOf(res)).toEqual([{ field: 'body.at', message: 'The start cannot be before the batch was created.' }]);
    res = await start({ email: admin.email });
    expect(res.status).toBe(422);
    expect(detailsOf(res).map((d: { field: string }) => d.field).sort()).toEqual(['body.at', 'body.password']);
    expect((await start(confirm({}, viewer), viewer.token)).status).toBe(403);
    expect((await end()).status).toBe(409);
    expect((await runOf()).runs).toEqual([]);
  });

  it('keeps the history as it was written', async () => {
    await setStage(pending, 'APPROVED');
    await start();
    await expect(pool.query(`UPDATE batch_runs SET actor_name = 'Someone else'`)).rejects.toThrow(/append-only/);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM batch_runs`))!.n).toBe(1);
  });
});
