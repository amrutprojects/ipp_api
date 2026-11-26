import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { one, transaction } from '../../db/pool';
import { AppError } from '../../http/errors';
import { logger } from '../../lib/logger';
import { recordOfficerMove } from '../../program/approval';
import type { ApprovalStage, StagePoint } from '../../program/constants';
import { audit } from '../../services/audit';
import { storage } from '../../services/storage';
import type { Decision } from './link.schemas';

/* The officers' decisions, as Sarthi reports them, and the documents its officers open. */

type SarthiStage = 'AUDITOR' | 'DIVISION' | 'COEP' | 'HEAD_OFFICE' | 'SUPER_ADMIN' | 'APPROVED';
/* Sarthi's names of the stages, and this system's. */
const here = (s: SarthiStage): StagePoint => (s === 'SUPER_ADMIN' ? 'ADMIN' : s);
const there = (s: ApprovalStage | null): string => (s === null ? 'AUDITOR' : s === 'ADMIN' ? 'SUPER_ADMIN' : s);

/* The moves there are: action from>to. */
const MOVES: readonly string[] = [
  'APPROVE DIVISION>COEP',
  'APPROVE COEP>HEAD_OFFICE',
  'APPROVE COEP>SUPER_ADMIN',
  'APPROVE HEAD_OFFICE>APPROVED',
  'APPROVE SUPER_ADMIN>APPROVED',
  'REJECT DIVISION>AUDITOR',
  'REJECT COEP>DIVISION',
  'REJECT HEAD_OFFICE>COEP',
  'REJECT SUPER_ADMIN>COEP',
  'MOVE HEAD_OFFICE>SUPER_ADMIN',
  'MOVE SUPER_ADMIN>HEAD_OFFICE',
];

export type DecisionResult =
  | { id: string; ok: true; duplicate: boolean }
  | {
      id: string;
      ok: false;
      code: 'APPLICATION_UNKNOWN' | 'STAGE_MISMATCH' | 'INVALID_MOVE';
      message: string;
      stage: string | null;
    };

/* Refused: nothing of the transaction is kept, not even the decision's id. */
class Refused extends Error {
  constructor(readonly result: DecisionResult & { ok: false }) {
    super(result.code);
  }
}

async function decide(req: Request, d: Decision): Promise<DecisionResult> {
  const refuse = (code: (DecisionResult & { ok: false })['code'], message: string, stage: string | null = null) =>
    new Refused({ id: d.id, ok: false, code, message, stage });
  try {
    return await transaction(async (db): Promise<DecisionResult> => {
      const done = await one<{ application_id: string }>(`SELECT application_id FROM link_inbound WHERE id = $1`, [d.id], db);
      if (done) return { id: d.id, ok: true, duplicate: true };
      /* Locked: of two decisions at the same moment the second one finds the stage the first one left. */
      const p = await one<{ id: string; approval_stage: ApprovalStage | null; batch_id: string | null }>(
        `SELECT id, approval_stage, batch_id FROM applications
         WHERE id = $1 AND deleted_at IS NULL AND status = 'SUBMITTED' AND batch_id IS NOT NULL FOR UPDATE`,
        [d.application_id],
        db,
      );
      if (!p) throw refuse('APPLICATION_UNKNOWN', 'There is no such application in a batch');
      /* The same decision sent twice at once: the second one waited for the first here. */
      const { rowCount } = await db.query(
        `INSERT INTO link_inbound (id, application_id, action) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [d.id, p.id, d.action],
      );
      if (!rowCount) return { id: d.id, ok: true, duplicate: true };
      const stage = there(p.approval_stage);
      if (!MOVES.includes(`${d.action} ${d.from}>${d.to}`))
        throw refuse('INVALID_MOVE', `${d.action} from ${d.from} to ${d.to} is not a move of the approval`, stage);
      if (stage !== d.from) throw refuse('STAGE_MISMATCH', `The application is at ${stage}, not at ${d.from}`, stage);

      const to = here(d.to);
      if (to === 'AUDITOR')
        /* Back with the Auditor: the batch and the checks of the documents stay. */
        await db.query(
          `UPDATE applications SET approval_stage = NULL, approved_at = NULL, approved_by = NULL, stage_updated_at = now() WHERE id = $1`,
          [p.id],
        );
      else await db.query(`UPDATE applications SET approval_stage = $2, stage_updated_at = now() WHERE id = $1`, [p.id, to]);
      await recordOfficerMove(db, {
        applicationId: p.id,
        action: d.action,
        from: here(d.from),
        to,
        /* Why the officer approved or rejected; a change of hands (MOVE) has none. */
        reason: d.action === 'MOVE' ? null : d.reason,
        by: d.by,
        at: new Date(d.at),
      });
      await audit.inTx(db, req, {
        action: 'edp.application.decision',
        resource: 'application',
        resourceId: p.id,
        actor: { kind: 'OFFICER', id: null },
        details: { decision: d.id, action: d.action, from: here(d.from), to },
      });
      return { id: d.id, ok: true, duplicate: false };
    });
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    logger.warn({ decision: d.id, code: err.result.code, stage: err.result.stage }, 'a decision of Sarthi was not done');
    return err.result;
  }
}

/* Each on its own, in the order given: a refused one does not hold up the next. */
export async function decideAll(req: Request, decisions: Decision[]): Promise<DecisionResult[]> {
  const results: DecisionResult[] = [];
  for (const d of decisions) results.push(await decide(req, d));
  return results;
}

const NO_DOCUMENT = 'There is no such document';

/* A document of a student in a batch, as it is stored. */
export async function sendDocument(res: Response, applicationId: string, code: string): Promise<void> {
  const f = await one<{ id: string; storage_key: string; mime_type: string; size_bytes: number }>(
    `SELECT f.id, f.storage_key, f.mime_type, f.size_bytes FROM application_files f
     JOIN applications p ON p.id = f.application_id AND p.deleted_at IS NULL AND p.batch_id IS NOT NULL
     WHERE f.application_id = $1 AND f.document_code = $2`,
    [applicationId, code],
  );
  if (!f) throw AppError.notFound(NO_DOCUMENT);
  if (!(await storage.exists(f.storage_key))) {
    logger.error({ file: f.id, document: code }, 'a stored document is missing');
    throw AppError.notFound(NO_DOCUMENT);
  }
  const body = await storage.read(f.storage_key);
  res.setHeader('Content-Type', f.mime_type);
  res.setHeader('Content-Length', f.size_bytes);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    await pipeline(body, res);
  } catch (err) {
    /* Not the error itself: its text may hold a file's path, with the student's name. */
    const reason = (err as NodeJS.ErrnoException).code ?? 'unknown';
    logger.warn({ reason, requestId: res.locals.requestId as string | undefined }, 'a document was not sent to the end');
  }
}
