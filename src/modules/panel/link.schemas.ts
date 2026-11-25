import { z } from 'zod';
import { uuid } from '../../lib/text';

/* Which messages are tried again: these, those of a batch, or (neither given) every one that is not sent. */
export const retryBody = z
  .object({
    ids: z
      .array(uuid('Message'), { invalid_type_error: 'Messages must be a list' })
      .min(1, 'Select at least one message')
      .max(100, 'At most 100 messages at a time')
      .optional(),
    batch_id: uuid('Batch').optional(),
  })
  .strict();
export type RetryBody = z.infer<typeof retryBody>;
