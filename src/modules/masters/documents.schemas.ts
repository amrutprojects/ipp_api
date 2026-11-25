import { z } from 'zod';
import { DOCUMENT_KINDS } from '../../program/constants';
import { flag, hasChange, names, NO_CHANGE, order } from './common.schemas';

export const newDocumentBody = z
  .object({
    ...names,
    required: flag('required').optional(),
    kind: z.enum(DOCUMENT_KINDS, { errorMap: () => ({ message: 'Choose Document or Video' }) }).optional(),
    order: order.optional(),
    is_active: flag('is_active').optional(),
  })
  .strict();
export type NewDocumentBody = z.infer<typeof newDocumentBody>;

/* The kind never changes: files of the other one may be stored already. */
export const updateDocumentBody = z
  .object({ ...names, required: flag('required'), is_active: flag('is_active'), order })
  .partial()
  .strict()
  .refine(hasChange, NO_CHANGE);
export type UpdateDocumentBody = z.infer<typeof updateDocumentBody>;
