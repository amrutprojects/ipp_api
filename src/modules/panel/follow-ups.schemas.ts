import { z } from 'zod';
import { hasControlChars } from '../../lib/text';
import { FOLLOW_UP_STATUS, type FollowUpStatus } from '../../program/constants';

const NOTE_MAX = 1000;
const STATUSES = Object.keys(FOLLOW_UP_STATUS) as [FollowUpStatus, ...FollowUpStatus[]];

export const followUpBody = z
  .object({
    status: z.enum(STATUSES, { errorMap: () => ({ message: 'Choose a follow-up status' }) }),
    /* Blank = none; line breaks are kept. */
    note: z
      .string({ invalid_type_error: 'Note must be text' })
      .trim()
      .max(NOTE_MAX, `Note must be at most ${NOTE_MAX} characters`)
      .refine((v) => !hasControlChars(v), 'Note contains characters that cannot be saved')
      .optional(),
  })
  .strict();
export type FollowUpBody = z.infer<typeof followUpBody>;
