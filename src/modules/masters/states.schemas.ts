import { z } from 'zod';
import { flag, hasChange, NO_CHANGE, placeName, stateCode } from './common.schemas';

export const newStateBody = z.object({ name: placeName, code: stateCode, is_active: flag('is_active').optional() }).strict();
export type NewStateBody = z.infer<typeof newStateBody>;

export const updateStateBody = z
  .object({ name: placeName, code: stateCode, is_active: flag('is_active') })
  .partial()
  .strict()
  .refine(hasChange, NO_CHANGE);
export type UpdateStateBody = z.infer<typeof updateStateBody>;
