import type { Request } from 'express';
import { DatabaseError } from 'pg';
import { one, pool, rows, transaction, type Db } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { AppError, ERROR_CODES } from '../../http/errors';
import { pageMeta } from '../../lib/paging';
import { approvalDto, batchProgress, recordMove, type BatchProgress } from '../../program/approval';
import { allVerified } from '../../program/document-checks';
import { filterDto } from '../../program/filters';
import { loadProgram } from '../../program/masters';
import { batchSync, enqueueBatch } from '../../program/link/outbox';
import { kickLink } from '../../program/link/runtime';
import { batchSettings, batchSizeOf } from '../../program/settings';
import { audit } from '../../services/audit';
import {
  findBatch,
  findBatches,
  findMembers,
  lockBatch,
  lockCandidates,
  type BatchRow,
  type CandidateRow,
} from './batches.repository';
import type { BatchListQuery, BatchRunBody, CreateBatchBody, UpdateBatchBody } from './batches.schemas';
import { actor, people } from './common';
import { confirmIdentity } from './users.service';

/*
 * Batches: a named group of exactly as many students as the batch size of their district is set to (Settings: the default, or
 * the district's own), all of one district, at a center of the Center Master. While the form does not require a district, students without one go with any; a batch of only such
 * students is of its center's district. The Auditor makes one of approved forms that wait for a batch, which sends them to
 * the Divisional Officer at once. Its students are fixed from then on (one sent back stays in it); its name, center, dates,
 * delivery mode and technology can be changed at any time.
 */

const NAME_TAKEN = 'A batch with this name already exists. Choose another name.';
const nameTaken = () => new AppError(409, NAME_TAKEN, ERROR_CODES.CONFLICT, [{ field: 'body.name', message: NAME_TAKEN }]);
const invalid = (field: string, message: string) => AppError.validation([{ field: `body.${field}`, message }]);

/* Two batches given one name at the same moment: the second is refused by the index. */
async function orNameTaken<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof DatabaseError && err.constraint === 'uq_batches_name' ? nameTaken() : err;
  }
}

/* ---------------------------------------------------------------------------------------------------------------- views */

/*
 * Where the batch is: NOT_STARTED, ONGOING (started, not ended) or ENDED, when and by whom; ready = every student of it is
 * finally approved, so it may start.
 */
export type RunStatus = 'NOT_STARTED' | 'ONGOING' | 'ENDED';
export const runStatus = (b: { started_at: Date | null; ended_at: Date | null }): RunStatus =>
  b.ended_at ? 'ENDED' : b.started_at ? 'ONGOING' : 'NOT_STARTED';
const allApproved = (p: BatchProgress) => p.students > 0 && p.stages.APPROVED === p.students;
const runDto = (b: BatchRow, p: BatchProgress) => ({
  status: runStatus(b),
  ready: allApproved(p),
  started_at: b.started_at,
  started_by: b.started_by,
  ended_at: b.ended_at,
  ended_by: b.ended_by,
});

/* Batches as listed, each with where its students are now. */
async function batchDtos(list: BatchRow[], db: Db) {
  const ids = list.map((b) => b.id);
  const progress = await batchProgress(ids, db);
  const sync = await batchSync(ids, db);
  return list.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    centre: { id: b.centre_id, name: b.centre_name, code: b.centre_code },
    district: { id: b.district_id, name: b.district_name },
    size: b.size,
    ...progress.get(b.id)!,
    run: runDto(b, progress.get(b.id)!),
    /* Whether Sarthi has it as it is now; null = nothing was sent of it. */
    sync: sync.get(b.id) ?? null,
    /* How many of its students chose another center than the batch's. */
    other_centre: b.other_centre,
    start_date: b.start_date,
    end_date: b.end_date,
    delivery_mode: b.delivery_mode,
    technology:
      b.technology_id && b.technology_code ? { id: b.technology_id, code: b.technology_code, name: b.technology_name } : null,
    created_at: b.created_at,
    created_by: b.created_by,
    updated_at: b.updated_at,
    updated_by: b.updated_by,
  }));
}

/* Every batch, newest first; search by its code or name, its center or its district. */
export async function listBatches(q: BatchListQuery) {
  const [{ items, total }, { size }] = await Promise.all([findBatches(q), batchSettings()]);
  return { items: await batchDtos(items, pool), meta: { ...pageMeta(q, total), size } };
}

/* One batch with its students: where each one is in the approval, and why one was sent back. */
export async function batch(id: string, db: Db = pool) {
  const b = await findBatch(id, db);
  if (!b) throw AppError.notFound('Batch not found');
  const [dto] = await batchDtos([b], db);
  const members = await findMembers(id, db);
  const program = await loadProgram(db);
  /* Every start and end, oldest first. */
  const runs = await rows<{ action: 'START' | 'END'; at: Date; by: string; recorded_at: Date }>(
    `SELECT action, at, actor_name AS by, created_at AS recorded_at FROM batch_runs WHERE batch_id = $1 ORDER BY seq`,
    [id],
    db,
  );
  return {
    ...dto!,
    runs,
    members: members.map((m) => {
      const approval = approvalDto(m);
      return {
        id: m.id,
        name: m.full_name,
        email: m.email,
        mobile_number: m.mobile,
        registration_id: m.registration_code,
        register_id: approval.register_id,
        ...filterDto(m),
        centre_id: m.centre_id,
        technology: m.technology ? (program.optionName('TECHNOLOGY', m.technology) ?? m.technology) : null,
        approval,
      };
    }),
  };
}

/* --------------------------------------------------------------------------------------------------------------- checks */

/* A center a batch may be placed at (its district); kept from being switched off or deleted until the batch is saved. */
async function checkCentre(db: Db, id: string): Promise<{ district_id: string }> {
  const centre = await one<{ is_active: boolean; gone: boolean; district_id: string }>(
    `SELECT is_active, (deleted_at IS NOT NULL) AS gone, district_id FROM centres WHERE id = $1 FOR SHARE`,
    [id],
    db,
  );
  if (!centre || centre.gone) throw invalid('centre_id', 'Centre not found');
  if (!centre.is_active) throw invalid('centre_id', 'This centre is inactive. Choose an active centre.');
  return centre;
}

/* The ID of an active technology, locked while the batch is saved. */
async function technologyId(db: Db, id: string): Promise<string> {
  const option = await one<{ id: string }>(
    `SELECT id FROM program_options WHERE kind = 'TECHNOLOGY' AND id = $1 AND is_active AND deleted_at IS NULL FOR SHARE`,
    [id],
    db,
  );
  if (!option) throw invalid('technology', 'Please select a technology.');
  return option.id;
}

function checkDates(start: string | null | undefined, end: string | null | undefined): void {
  if (start && end && end <= start) throw invalid('end_date', 'End date must be after the start date');
}

/* The one district of the selected forms: two are refused, and none while the form requires one. null = no form has one. */
function districtOf(candidates: CandidateRow[], required: boolean): string | null {
  const counted = candidates.filter((c) => required || c.district_id);
  const districts = new Map(counted.map((c) => [c.district_id, c.district ?? 'no district']));
  const [id] = districts.keys();
  if (districts.size === 1 && id) return id;
  if (!districts.size) return null;
  const names = [...districts.values()].sort();
  throw invalid('ids', `All students of a batch must be from one district. Selected: ${names.join(', ')}.`);
}

/* --------------------------------------------------------------------------------------------------------------- changes */

/* A new batch; it is sent to the Divisional Officer at once. */
export async function createBatch(req: Request, user: PanelUser, body: CreateBatchBody) {
  checkDates(body.start_date, body.end_date);
  const made = await orNameTaken(() =>
    transaction(async (db) => {
      const selected = body.ids.length;
      const centre = await checkCentre(db, body.centre_id);
      const technology = await technologyId(db, body.technology);
      /* Locked before they are checked: no edit, verification or other batch comes in between. */
      const candidates = await lockCandidates(body.ids, db);
      const required = (await loadProgram(db)).requires('district_id');
      const district = districtOf(candidates, required) ?? centre.district_id;
      const { size, name: districtName } = await batchSizeOf(db, district);
      if (selected !== size)
        throw invalid(
          'ids',
          `A batch of ${districtName} must have exactly ${people(size)} (Settings → Batch size); ${selected} selected.`,
        );
      if (await one(`SELECT 1 FROM batches WHERE lower(name) = lower($1) AND deleted_at IS NULL`, [body.name], db))
        throw nameTaken();
      const waiting = candidates.filter((c) => c.approval_stage === 'BATCH' && !c.batch_id);
      if (waiting.length !== selected)
        throw AppError.conflict(
          `${people(selected - waiting.length)} of the selected cannot be added: only approved forms waiting for a batch can be.`,
        );
      const unverified = waiting.filter((c) => !allVerified(c)).length;
      if (unverified)
        throw AppError.conflict(`${people(unverified)} of the selected cannot be added: every document must be verified first.`);
      const made = (await one<{ id: string }>(
        `INSERT INTO batches (name, district_id, centre_id, size, start_date, end_date, delivery_mode, technology_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 'OFFLINE'), $8, $9, $9) RETURNING id`,
        [
          body.name,
          district,
          body.centre_id,
          size,
          body.start_date ?? null,
          body.end_date ?? null,
          body.delivery_mode ?? null,
          technology,
          user.id,
        ],
        db,
      ))!;
      await db.query(
        `UPDATE applications SET batch_id = $1, approval_stage = 'DIVISION', stage_updated_at = now() WHERE id = ANY($2::uuid[])`,
        [made.id, waiting.map((c) => c.id)],
      );
      for (const c of waiting)
        await recordMove(db, { applicationId: c.id, action: 'APPROVE', from: 'BATCH', to: 'DIVISION', by: user });
      await enqueueBatch(db, 'BATCH', made.id);
      await audit.inTx(db, req, {
        action: 'edp.batch.create',
        resource: 'batch',
        resourceId: made.id,
        actor: actor(user),
        details: { students: size, centreId: body.centre_id, districtId: district },
      });
      return batch(made.id, db);
    }),
  );
  kickLink();
  return made;
}

/* Changes the batch details, never its students; a technology must still be active. */
export async function updateBatch(req: Request, user: PanelUser, id: string, body: UpdateBatchBody) {
  const saved = await orNameTaken(() =>
    transaction(async (db) => {
      const before = (await lockBatch(id, db)) && (await findBatch(id, db));
      if (!before) throw AppError.notFound('Batch not found');
      const after = {
        name: body.name ?? before.name,
        centre_id: body.centre_id?.toLowerCase() ?? before.centre_id,
        start_date: body.start_date === undefined ? before.start_date : body.start_date,
        end_date: body.end_date === undefined ? before.end_date : body.end_date,
        delivery_mode: body.delivery_mode ?? before.delivery_mode,
        technology_id: before.technology_id,
      };
      checkDates(after.start_date, after.end_date);
      if (after.centre_id !== before.centre_id) await checkCentre(db, after.centre_id);
      const selectedTechnology = body.technology ?? before.technology_id;
      if (!selectedTechnology) throw invalid('technology', 'Please select a technology.');
      after.technology_id = await technologyId(db, selectedTechnology);

      const fields = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]);
      if (!fields.length) return batch(id, db);
      await db.query(
        `UPDATE batches SET name = $2, centre_id = $3, start_date = $4, end_date = $5, delivery_mode = $6, technology_id = $7,
           updated_by = $8 WHERE id = $1`,
        [id, after.name, after.centre_id, after.start_date, after.end_date, after.delivery_mode, after.technology_id, user.id],
      );
      await enqueueBatch(db, 'BATCH_UPDATE', id);
      await audit.inTx(db, req, {
        action: 'edp.batch.update',
        resource: 'batch',
        resourceId: id,
        actor: actor(user),
        details: { fields },
      });
      return batch(id, db);
    }),
  );
  kickLink();
  return saved;
}

/* ------------------------------------------------------------------------------------------------------------ start, end */

/* A date and time a little ahead of the server's clock is still now (the browser's clock may run ahead). */
const CLOCK_SLACK_MS = 5 * 60_000;

/*
 * Starts or ends a batch, at the date and time the Auditor gives, after they confirmed their e-mail and password. A batch
 * starts once every student of it is finally approved, and only once; it ends once, after it started. Each is kept in
 * batch_runs, audited, and sent to Sarthi with the batch (BATCH_UPDATE).
 */
async function runBatch(req: Request, user: PanelUser, id: string, body: BatchRunBody, action: 'START' | 'END') {
  await confirmIdentity(user, body.email, body.password);
  const at = new Date(body.at);
  if (at.getTime() > Date.now() + CLOCK_SLACK_MS)
    throw invalid('at', action === 'START' ? 'The start cannot be in the future.' : 'The end cannot be in the future.');
  const saved = await transaction(async (db) => {
    if (!(await lockBatch(id, db))) throw AppError.notFound('Batch not found');
    const b = (await findBatch(id, db))!;
    if (action === 'START') {
      if (b.started_at) throw AppError.conflict('This batch has already started.');
      const p = (await batchProgress([id], db)).get(id)!;
      if (!allApproved(p))
        throw AppError.conflict(
          `A batch starts once every student of it is final approved: ${p.stages.APPROVED} of ${p.students} are now.`,
        );
      if (at < b.created_at) throw invalid('at', 'The start cannot be before the batch was created.');
      await db.query(`UPDATE batches SET started_at = $2, started_by = $3 WHERE id = $1`, [id, at, user.id]);
    } else {
      if (!b.started_at) throw AppError.conflict('This batch has not started yet.');
      if (b.ended_at) throw AppError.conflict('This batch has already ended.');
      if (at < b.started_at) throw invalid('at', 'The end cannot be before the batch started.');
      await db.query(`UPDATE batches SET ended_at = $2, ended_by = $3 WHERE id = $1`, [id, at, user.id]);
    }
    await db.query(`INSERT INTO batch_runs (batch_id, action, at, panel_user_id, actor_name) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      action,
      at,
      user.id,
      user.name,
    ]);
    await enqueueBatch(db, 'BATCH_UPDATE', id);
    await audit.inTx(db, req, {
      action: action === 'START' ? 'edp.batch.start' : 'edp.batch.end',
      resource: 'batch',
      resourceId: id,
      actor: actor(user),
      details: { at: at.toISOString() },
    });
    return batch(id, db);
  });
  kickLink();
  return saved;
}

export const startBatch = (req: Request, user: PanelUser, id: string, body: BatchRunBody) =>
  runBatch(req, user, id, body, 'START');
export const endBatch = (req: Request, user: PanelUser, id: string, body: BatchRunBody) => runBatch(req, user, id, body, 'END');
