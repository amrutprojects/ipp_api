import { z } from 'zod';
import {
  flag,
  hasChange,
  masterListQuery,
  NO_CHANGE,
  optional,
  placeCode,
  placeName,
  ref,
  statusFilter,
  unlessBlank,
} from './common.schemas';

/* By district, then name (the only order there is). */
export const talukaListQuery = masterListQuery(['district'] as const).extend({
  status: statusFilter,
  district_id: unlessBlank(ref('District')),
});
export type TalukaListQuery = z.infer<typeof talukaListQuery>;

/* A taluka's code is optional (official code lists are often not available); blank or null = none. */
const code = optional(placeCode);

export const newTalukaBody = z
  .object({ district_id: ref('District'), name: placeName, code, is_active: flag('is_active').optional() })
  .strict();
export type NewTalukaBody = z.infer<typeof newTalukaBody>;

export const updateTalukaBody = z
  .object({ district_id: ref('District'), name: placeName, code, is_active: flag('is_active') })
  .partial()
  .strict()
  .refine(hasChange, NO_CHANGE);
export type UpdateTalukaBody = z.infer<typeof updateTalukaBody>;
