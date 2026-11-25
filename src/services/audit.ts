import type { Request } from 'express';
import { pool, type Db } from '../db/pool';
import { logger } from '../lib/logger';

/* Who did something: a student, a panel user (Auditor), an officer (added later), or the system. */
export interface Actor {
  kind: 'STUDENT' | 'PANEL' | 'OFFICER' | 'SYSTEM';
  id: string | null;
}

export interface AuditEvent {
  action: string;
  resource: string;
  resourceId: string | null;
  actor: Actor;
  /* Never personal data, passwords, codes or file contents: ids, counts and names of fields only. */
  details?: Record<string, unknown>;
}

async function write(db: Db, req: Request | null, e: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (action, resource, resource_id, actor_kind, actor_id, details, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.action,
      e.resource,
      e.resourceId,
      e.actor.kind,
      e.actor.id,
      e.details ? JSON.stringify(e.details) : null,
      req?.ip ?? null,
      req?.header('user-agent')?.slice(0, 300) ?? null,
      (req?.res?.locals.requestId as string | undefined) ?? null,
    ],
  );
}

export const audit = {
  /* Inside a transaction: the change and its record are kept, or neither is. */
  inTx: (db: Db, req: Request | null, e: AuditEvent) => write(db, req, e),
  /* After the change: a failure to record is logged and does not undo it. */
  async record(req: Request | null, e: AuditEvent): Promise<void> {
    try {
      await write(pool, req, e);
    } catch (err) {
      logger.error({ err, action: e.action }, 'could not write the audit log');
    }
  },
};
