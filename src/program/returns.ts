import { one, rows, pool, type Db } from '../db/pool';
import type { Delivery } from '../services/mailer';

/*
 * A submitted form the Auditor sent back to the candidate (application_returns, migration 0010), possible while the setting
 * "Enable Rejection Email Notification and Resubmission" is on. While a return is open the form stays SUBMITTED but is with
 * the candidate: the Auditor can neither approve nor correct it, and the candidate can correct it and save, which resubmits
 * it to the Auditor (resubmitted_at). Switching the setting off later leaves open returns open until they are resubmitted.
 */

export const WITH_CANDIDATE = 'This form is with the candidate for correction. It can be approved or changed once they resubmit it.';
export const NOT_RETURNED = 'Your form has not been sent back for correction; a submitted form cannot be changed.';

/* An open return of the form `p` (SQL over applications `p`). */
export const OPEN_RETURN = (alias = 'p') =>
  `EXISTS (SELECT 1 FROM application_returns r WHERE r.application_id = ${alias}.id AND r.resubmitted_at IS NULL)`;

export interface FormReturn {
  seq: string;
  reason: string;
  by: string;
  at: Date;
  email_status: 'PENDING' | Delivery;
  email_at: Date | null;
  resubmitted_at: Date | null;
}

const COLUMNS = `seq, reason, actor_name AS by, created_at AS at, email_status, email_at, resubmitted_at`;

/* The open return of an application, if any; `lock` holds it until the transaction ends. */
export const openReturn = (db: Db, applicationId: string, lock = false) =>
  one<FormReturn>(
    `SELECT ${COLUMNS} FROM application_returns WHERE application_id = $1 AND resubmitted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [applicationId],
    db,
  );

/* Every return of an application, the latest first. */
export const returnsOf = (applicationId: string, db: Db = pool) =>
  rows<FormReturn>(`SELECT ${COLUMNS} FROM application_returns WHERE application_id = $1 ORDER BY seq DESC`, [applicationId], db);
