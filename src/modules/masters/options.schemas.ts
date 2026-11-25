import { z } from 'zod';
import { uuid } from '../../lib/text';
import { flag, hasChange, masterListQuery, names, NO_CHANGE, order, statusFilter } from './common.schemas';

/* The choices of a dropdown. Which lists there are: options.service.ts (assertKind). */
export const kindParams = z.object({ kind: z.string() });
export const optionParams = z.object({ kind: z.string(), id: uuid() });

export const optionListQuery = masterListQuery(['order', 'name'] as const).extend({ status: statusFilter });
export type OptionListQuery = z.infer<typeof optionListQuery>;

export const newOptionBody = z.object({ ...names, order: order.optional(), is_active: flag('is_active').optional() }).strict();
export type NewOptionBody = z.infer<typeof newOptionBody>;

export const updateOptionBody = z
  .object({ ...names, order, is_active: flag('is_active') })
  .partial()
  .strict()
  .refine(hasChange, NO_CHANGE);
export type UpdateOptionBody = z.infer<typeof updateOptionBody>;
