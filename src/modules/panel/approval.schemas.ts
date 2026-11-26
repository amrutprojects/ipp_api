import { z } from 'zod';
import { content } from '../../lib/text';
import { studentIds } from './common';

/*
 * Why the Auditor approves: 3 to 500 characters, kept in the form's approval history and sent to Sarthi with the form (as a
 * rejection's reason is). Asked only for a second approval (a form rejected or returned to the candidate before: the
 * service refuses one without it, 422); a first approval may have one. The same reason is kept for each form of "Approve
 * selected".
 */
export const APPROVAL_REASON_MIN = 3;
export const APPROVAL_REASON_MAX = 500;
const reason = content('Approval reason', APPROVAL_REASON_MAX, APPROVAL_REASON_MIN);

export const approveBody = z.object({ reason: reason.optional() }).strict();

export const approveSelectedBody = z
  .object({
    ids: studentIds({ max: 500, twice: 'Each student may be selected only once', list: 'ids must be a list' }),
    reason: reason.optional(),
  })
  .strict();

export const verifyDocumentBody = z
  .object({
    verified: z.boolean({ required_error: 'verified is required', invalid_type_error: 'verified must be true or false' }),
  })
  .strict();
