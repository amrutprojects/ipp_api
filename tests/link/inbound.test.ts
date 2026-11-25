import crypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { one, pool, rows } from '../../src/db/pool';
import { storage } from '../../src/services/storage';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  addFile,
  FILES,
  makeApplication,
  makeBatch,
  makeCentre,
  makePanelUser,
  request,
  type TestPanelUser,
} from '../helpers/factory';
import { linkOff, linkOn, linkStop, sarthiCalls } from '../helpers/sarthi';
import { applicationRow, audits, setStage } from '../panel/helpers';

/* What Sarthi's server calls: the officers' decisions, and the documents its officers open. */
let admin: TestPanelUser;
let centre: string;
let batch: string;
beforeEach(async () => {
  await resetDatabase();
  admin = await makePanelUser('ADMIN', { name: 'Program Auditor' });
  centre = await makeCentre();
  batch = await makeBatch({ centre, by: admin });
  linkOn();
});
afterEach(linkStop);
afterAll(closeDatabase);

const inBatch = () => makeApplication('DIVISION', { centre, by: admin, batch });
interface Over {
  id?: string;
  reason?: string | null;
  by?: { name: string; role: string };
  at?: string;
}
const decision = (application_id: string, action: string, from: string, to: string, over: Over = {}) => ({
  id: crypto.randomUUID(),
  application_id,
  action,
  from,
  to,
  reason: action === 'REJECT' ? 'The photo is not clear' : null,
  by: { name: 'Officer One', role: 'Divisional Officer' },
  at: new Date().toISOString(),
  ...over,
});
const send = (...decisions: object[]) => sarthiCalls('post', '/decisions', { decisions });
const results = async (...decisions: object[]) => {
  const res = await send(...decisions);
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return res.body.data.results as { id: string; ok: boolean; duplicate?: boolean; code?: string; stage?: string | null }[];
};
const events = (id: string) =>
  rows<{
    action: string;
    from_stage: string;
    to_stage: string;
    reason: string | null;
    actor_kind: string;
    actor_name: string;
    actor_role: string | null;
  }>(
    `SELECT action, from_stage, to_stage, reason, actor_kind, actor_name, actor_role FROM approval_events
     WHERE application_id = $1 ORDER BY seq`,
    [id],
  );
const stageOf = async (id: string) =>
  (await one<{ s: string | null }>(`SELECT approval_stage AS s FROM applications WHERE id = $1`, [id]))!.s;

describe('the signature', () => {
  const ping = (over: Parameters<typeof sarthiCalls>[3] = {}) => sarthiCalls('get', '/ping', undefined, over);

  it('a signed call is answered', async () => {
    const res = await ping();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, time: expect.any(String) });
  });

  it.each([
    ['another secret', { secret: 'x'.repeat(40) }],
    ['the own call sent back', { client: 'ipp' as const }],
    ['a call of more than five minutes ago', { now: new Date(Date.now() - 400_000) }],
    ['a call of more than five minutes from now', { now: new Date(Date.now() + 400_000) }],
    ['another path', { signedPath: '/api/v1/link/decisions' }],
    ['another body', { signedBody: 'x' }],
  ])('%s: 401', async (_what, over) => {
    const res = await ping(over);
    expect([res.status, res.body.error.code]).toEqual([401, 'LINK_UNAUTHORIZED']);
  });

  it('almost five minutes are accepted, a few seconds more are not', async () => {
    for (const [seconds, status] of [
      [-295, 200],
      [295, 200],
      [-305, 401],
      [305, 401],
    ] as const)
      expect([seconds, (await ping({ now: new Date(Date.now() + seconds * 1000) })).status]).toEqual([seconds, status]);
  });

  it('no signature, or something else in its place: 401, before the body is understood', async () => {
    for (const headers of [
      {},
      { Authorization: `Bearer ${admin.token}` },
      { Authorization: 'IPP-SARTHI sarthi:abc', 'X-Timestamp': '1' },
      { Authorization: `IPP-SARTHI sarthi:${'a'.repeat(64)}`, 'X-Timestamp': 'now' },
    ])
      for (const body of ['{', '{"decisions":[]}']) {
        const res = await request('post', '/manage/me')
          .set('Content-Type', 'application/json')
          .set(headers as Record<string, string>)
          .send('{}');
        expect(res.status).toBe(404);
        const link = await sarthiCalls('post', '/decisions', body).unset('Authorization').unset('X-Timestamp').set(headers);
        expect([link.status, link.body.error.code]).toEqual([401, 'LINK_UNAUTHORIZED']);
      }
  });

  it('a signed body that is no JSON: 400', async () => {
    const res = await sarthiCalls('post', '/decisions', '{"decisions":');
    expect([res.status, res.body.message]).toEqual([400, 'Malformed JSON body']);
  });

  it('switched off, or without a secret: 503', async () => {
    linkOff();
    const off = await ping();
    expect([off.status, off.body.error.code]).toEqual([503, 'LINK_NOT_CONFIGURED']);
  });

  it('is not part of the portal: not under its address, and its sessions do not count', async () => {
    expect((await request('get', '/link/ping', admin.token)).status).toBe(404);
    expect((await request('get', '/ping', admin.token)).status).toBe(404);
  });
});

describe('POST /link/decisions', () => {
  it('follows a form through every stage to the final approval, with the officers’ names', async () => {
    const { applicationId: id, student } = await inBatch();
    const at = '2026-11-20T10:30:00.000Z';
    expect(
      await results(
        decision(id, 'APPROVE', 'DIVISION', 'COEP', { at }),
        decision(id, 'APPROVE', 'COEP', 'HEAD_OFFICE', { by: { name: 'Coep One', role: 'COEP' } }),
        decision(id, 'APPROVE', 'HEAD_OFFICE', 'APPROVED', { by: { name: 'Head One', role: 'Head Officer' } }),
      ),
    ).toEqual([
      { id: expect.any(String), ok: true, duplicate: false },
      { id: expect.any(String), ok: true, duplicate: false },
      { id: expect.any(String), ok: true, duplicate: false },
    ]);
    const detail = (await request('get', `/manage/applicants/${student.id}`, admin.token)).body.data;
    expect(detail.approval).toMatchObject({
      stage: 'APPROVED',
      stage_label: 'Final approved',
      register_id: expect.stringMatching(/^IPP-/),
      last_event: { action: 'APPROVE', by: 'Head One' },
    });
    expect(detail.can_edit).toBe(false);
    expect(
      detail.history.map((h: { from: { name: string }; to: { name: string }; by: string; role: string | null }) => [
        h.from.name,
        h.to.name,
        h.by,
        h.role,
      ]),
    ).toEqual([
      ['Head Office', 'Final approval', 'Head One', 'Head Officer'],
      ['COEP', 'Head Office', 'Coep One', 'COEP'],
      ['Divisional Officer', 'COEP', 'Officer One', 'Divisional Officer'],
      ['Batch', 'Divisional Officer', 'Program Auditor', null],
      ['Auditor', 'Batch', 'Program Auditor', null],
    ]);
    /* At the time the officer decided. */
    expect(detail.history[2].at).toBe(at);
    expect((await request('get', `/manage/batches/${batch}`, admin.token)).body.data).toMatchObject({
      stages: { APPROVED: 1 },
      rejected: 0,
    });
  });

  it('while Head Office is off, the Super Admin decides; switching it moves who is waiting', async () => {
    const { applicationId: id, student } = await inBatch();
    const boss = { by: { name: 'Super One', role: 'Super Admin' } };
    await results(decision(id, 'APPROVE', 'DIVISION', 'COEP'), decision(id, 'APPROVE', 'COEP', 'SUPER_ADMIN'));
    expect(await stageOf(id)).toBe('ADMIN');
    const list = (await request('get', '/manage/applicants', admin.token)).body.data[0];
    expect(list.approval).toMatchObject({ stage: 'ADMIN', stage_label: 'With Super Admin (final approval)' });
    await results(
      decision(id, 'MOVE', 'SUPER_ADMIN', 'HEAD_OFFICE', boss),
      decision(id, 'MOVE', 'HEAD_OFFICE', 'SUPER_ADMIN', boss),
    );
    expect(await stageOf(id)).toBe('ADMIN');
    expect((await events(id)).slice(-2)).toEqual([
      {
        action: 'MOVE',
        from_stage: 'ADMIN',
        to_stage: 'HEAD_OFFICE',
        reason: null,
        actor_kind: 'OFFICER',
        actor_name: 'Super One',
        actor_role: 'Super Admin',
      },
      {
        action: 'MOVE',
        from_stage: 'HEAD_OFFICE',
        to_stage: 'ADMIN',
        reason: null,
        actor_kind: 'OFFICER',
        actor_name: 'Super One',
        actor_role: 'Super Admin',
      },
    ]);
    await results(decision(id, 'APPROVE', 'SUPER_ADMIN', 'APPROVED', boss));
    const detail = (await request('get', `/manage/applicants/${student.id}`, admin.token)).body.data;
    expect(detail.history[0]).toMatchObject({ from: { name: 'Super Admin' }, to: { name: 'Final approval' }, by: 'Super One' });
    expect(detail.history[1]).toMatchObject({ action: 'MOVE' });
  });

  it('a rejection goes back one stage, with its reason; from the Divisional Officer to the Auditor, who approves again', async () => {
    const { applicationId: id, student } = await inBatch();
    const { student: other, applicationId: otherId } = await inBatch();
    await results(
      decision(id, 'APPROVE', 'DIVISION', 'COEP'),
      decision(id, 'APPROVE', 'COEP', 'HEAD_OFFICE'),
      decision(id, 'REJECT', 'HEAD_OFFICE', 'COEP', { reason: 'Marks do not match' }),
      decision(id, 'REJECT', 'COEP', 'DIVISION', { reason: 'Marks do not match, see HO' }),
    );
    expect(await stageOf(id)).toBe('DIVISION');
    const list = (await request('get', '/manage/applicants', admin.token)).body.data as {
      id: string;
      approval: { last_event: object };
    }[];
    expect(list.find((r) => r.id === student.id)!.approval.last_event).toMatchObject({
      action: 'REJECT',
      from: { name: 'COEP' },
      to: { name: 'Divisional Officer' },
      reason: 'Marks do not match, see HO',
    });
    await results(decision(id, 'REJECT', 'DIVISION', 'AUDITOR', { reason: ' Correct the marks ' }));
    const back = await applicationRow(student.id);
    expect(back).toMatchObject({ approval_stage: null, approved_at: null, approved_by: null, batch_id: batch });
    expect(back.documents_verified_at).not.toBeNull();
    expect((await request('get', '/manage/applicants?application_stage=RETURNED', admin.token)).body.data).toHaveLength(1);
    expect((await events(id)).at(-1)).toMatchObject({ action: 'REJECT', reason: 'Correct the marks', actor_kind: 'OFFICER' });
    /* The rest of the batch goes on. */
    await results(decision(otherId, 'APPROVE', 'DIVISION', 'COEP'));
    expect((await applicationRow(other.id)).approval_stage).toBe('COEP');
    expect((await request('get', `/manage/batches/${batch}`, admin.token)).body.data).toMatchObject({
      stages: { AUDITOR: 1, COEP: 1 },
      rejected: 1,
    });
    expect((await request('post', `/manage/applicants/${student.id}/approve`, admin.token)).status).toBe(200);
    expect(await stageOf(id)).toBe('DIVISION');
  });

  it('SUPER_ADMIN rejects to COEP too', async () => {
    const { applicationId: id } = await inBatch();
    await results(
      decision(id, 'APPROVE', 'DIVISION', 'COEP'),
      decision(id, 'APPROVE', 'COEP', 'SUPER_ADMIN'),
      decision(id, 'REJECT', 'SUPER_ADMIN', 'COEP'),
    );
    expect(await stageOf(id)).toBe('COEP');
  });

  const MOVES = [
    'APPROVE DIVISION COEP',
    'APPROVE COEP HEAD_OFFICE',
    'APPROVE COEP SUPER_ADMIN',
    'APPROVE HEAD_OFFICE APPROVED',
    'APPROVE SUPER_ADMIN APPROVED',
    'REJECT DIVISION AUDITOR',
    'REJECT COEP DIVISION',
    'REJECT HEAD_OFFICE COEP',
    'REJECT SUPER_ADMIN COEP',
    'MOVE HEAD_OFFICE SUPER_ADMIN',
    'MOVE SUPER_ADMIN HEAD_OFFICE',
  ];
  it('any other move is refused, wherever the form is', async () => {
    const { applicationId: id } = await inBatch();
    const wrong = [];
    for (const action of ['APPROVE', 'REJECT', 'MOVE'])
      for (const from of ['DIVISION', 'COEP', 'HEAD_OFFICE', 'SUPER_ADMIN'])
        for (const to of ['AUDITOR', 'DIVISION', 'COEP', 'HEAD_OFFICE', 'SUPER_ADMIN', 'APPROVED'])
          if (!MOVES.includes(`${action} ${from} ${to}`)) wrong.push(decision(id, action, from, to));
    expect(wrong).toHaveLength(61);
    const answers = await results(...wrong);
    expect(new Set(answers.map((r) => `${r.ok} ${r.code} ${r.stage}`))).toEqual(new Set(['false INVALID_MOVE DIVISION']));
    expect(await stageOf(id)).toBe('DIVISION');
    expect(await rows('SELECT 1 FROM link_inbound')).toHaveLength(0);
  });

  it('a decision for another stage than the form is at is refused, and says where it is', async () => {
    const { applicationId: id, student } = await inBatch();
    expect(await results(decision(id, 'APPROVE', 'COEP', 'HEAD_OFFICE'))).toEqual([
      {
        id: expect.any(String),
        ok: false,
        code: 'STAGE_MISMATCH',
        message: 'The application is at DIVISION, not at COEP',
        stage: 'DIVISION',
      },
    ]);
    await setStage(student.id, 'ADMIN');
    expect((await results(decision(id, 'REJECT', 'COEP', 'DIVISION')))[0]).toMatchObject({
      code: 'STAGE_MISMATCH',
      stage: 'SUPER_ADMIN',
    });
    await setStage(student.id, 'DIVISION');
    await results(decision(id, 'REJECT', 'DIVISION', 'AUDITOR'));
    expect((await results(decision(id, 'APPROVE', 'DIVISION', 'COEP')))[0]).toMatchObject({
      code: 'STAGE_MISMATCH',
      stage: 'AUDITOR',
    });
  });

  it('an application there is not, or that is in no batch', async () => {
    const waiting = await makeApplication('BATCH', { centre, by: admin });
    const draft = await makeApplication('DRAFT', { centre });
    const gone = await inBatch();
    await pool.query(`UPDATE applications SET deleted_at = now() WHERE id = $1`, [gone.applicationId]);
    for (const id of [crypto.randomUUID(), waiting.applicationId, draft.applicationId, gone.applicationId])
      expect((await results(decision(id, 'APPROVE', 'DIVISION', 'COEP')))[0]).toMatchObject({
        ok: false,
        code: 'APPLICATION_UNKNOWN',
        stage: null,
      });
  });

  it('a refused one does not hold up the next; the same one again changes nothing', async () => {
    const a = await inBatch();
    const b = await inBatch();
    const good = decision(b.applicationId, 'APPROVE', 'DIVISION', 'COEP');
    const bad = decision(a.applicationId, 'APPROVE', 'COEP', 'HEAD_OFFICE');
    expect((await results(bad, good)).map((r) => r.ok)).toEqual([false, true]);
    expect((await results(good, good)).map((r) => [r.ok, r.duplicate])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect((await events(b.applicationId)).filter((e) => e.actor_kind === 'OFFICER')).toHaveLength(1);
    /* Refused before, the same id can be done once it fits. */
    await results(decision(a.applicationId, 'APPROVE', 'DIVISION', 'COEP'));
    expect((await results(bad))[0]).toEqual({ id: bad.id, ok: true, duplicate: false });
  });

  it('of two decisions at the same moment one is done; the same one sent twice at once is done once', async () => {
    const { applicationId: id } = await inBatch();
    const both = await Promise.all([
      results(decision(id, 'APPROVE', 'DIVISION', 'COEP')),
      results(decision(id, 'REJECT', 'DIVISION', 'AUDITOR')),
    ]);
    expect(
      both
        .flat()
        .map((r) => r.code ?? 'done')
        .sort(),
    ).toEqual(['STAGE_MISMATCH', 'done']);
    const other = await inBatch();
    const same = decision(other.applicationId, 'APPROVE', 'DIVISION', 'COEP');
    const answers = (await Promise.all([1, 2, 3, 4].map(() => results(same)))).flat();
    expect(answers.map((r) => [r.ok, r.duplicate]).sort()).toEqual([
      [true, false],
      [true, true],
      [true, true],
      [true, true],
    ]);
    expect((await events(other.applicationId)).filter((e) => e.actor_kind === 'OFFICER')).toHaveLength(1);
  });

  it('a malformed call is refused as a whole', async () => {
    const { applicationId: id } = await inBatch();
    const good = decision(id, 'APPROVE', 'DIVISION', 'COEP');
    for (const bad of [
      { ...good, id: 'x' },
      { ...good, action: 'DELETE' },
      { ...good, from: 'AUDITOR' },
      { ...good, to: 'BATCH' },
      { ...good, by: { name: '', role: 'x' } },
      { ...good, at: 'yesterday' },
      { ...good, more: 1 },
      { ...good, reason: 'x'.repeat(501) },
      decision(id, 'REJECT', 'DIVISION', 'AUDITOR', { reason: null }),
      decision(id, 'REJECT', 'DIVISION', 'AUDITOR', { reason: ' no ' }),
    ]) {
      const res = await send(good, bad);
      expect([res.status, res.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    }
    expect((await send()).status).toBe(422);
    expect((await send(...Array.from({ length: 101 }, () => good))).status).toBe(422);
    expect(await stageOf(id)).toBe('DIVISION');
  });

  it('is recorded without personal data', async () => {
    const { applicationId: id } = await inBatch();
    const d = decision(id, 'REJECT', 'DIVISION', 'AUDITOR');
    await results(d);
    expect(await audits('edp.application.decision')).toEqual([
      expect.objectContaining({
        resource: 'application',
        resource_id: id,
        actor_kind: 'OFFICER',
        actor_id: null,
        details: { decision: d.id, action: 'REJECT', from: 'DIVISION', to: 'AUDITOR' },
      }),
    ]);
  });

  it('a decision of the future is recorded as of now', async () => {
    const { applicationId: id } = await inBatch();
    await results(decision(id, 'APPROVE', 'DIVISION', 'COEP', { at: '2099-01-01T00:00:00+05:30' }));
    const e = (await one<{ late: boolean }>(
      `SELECT created_at > now() AS late FROM approval_events WHERE application_id = $1 ORDER BY seq DESC LIMIT 1`,
      [id],
    ))!;
    expect(e.late).toBe(false);
  });
});

describe('GET /link/applications/:id/documents/:code', () => {
  const read = (path: string) =>
    sarthiCalls('get', path)
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => done(null, Buffer.concat(parts)));
      });

  it('gives a document of a student in a batch, with its type and length', async () => {
    const { applicationId: id } = await inBatch();
    await pool.query(`DELETE FROM application_files WHERE application_id = $1 AND document_code = 'PHOTO'`, [id]);
    await addFile(id, 'PHOTO', FILES.pdf);
    const res = await read(`/applications/${id}/documents/photo`);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': String(FILES.pdf.length),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(res.body).toEqual(FILES.pdf);
  });

  it('not of one that is in no batch, not an unknown one, and not one the storage has lost', async () => {
    const { applicationId: id } = await inBatch();
    const waiting = await makeApplication('BATCH', { centre, by: admin });
    for (const path of [
      `/applications/${waiting.applicationId}/documents/PHOTO`,
      `/applications/${crypto.randomUUID()}/documents/PHOTO`,
      `/applications/abc/documents/PHOTO`,
      `/applications/${id}/documents/HSC_DIPLOMA`,
      `/applications/${id}/documents/..%2F..%2Fx`,
    ])
      expect([path, (await sarthiCalls('get', path)).status]).toEqual([path, 404]);
    const { key } = (await one<{ key: string }>(
      `SELECT storage_key AS key FROM application_files WHERE application_id = $1 AND document_code = 'PHOTO'`,
      [id],
    ))!;
    await storage.remove(key);
    const lost = await sarthiCalls('get', `/applications/${id}/documents/PHOTO`);
    expect([lost.status, lost.body.message]).toEqual([404, 'There is no such document']);
  });

  it('needs the signature', async () => {
    const { applicationId: id } = await inBatch();
    const res = await sarthiCalls('get', `/applications/${id}/documents/PHOTO`, undefined, { secret: 'y'.repeat(40) });
    expect(res.status).toBe(401);
  });
});
