import { z } from 'zod';
import { flag, hasChange, NO_CHANGE, placeCode, placeName, ref, statusFilter, unlessBlank } from './common.schemas';

/* Without a filter: every district. */
export const districtListQuery = z.object({ status: statusFilter, state_id: unlessBlank(ref('State')) });
export type DistrictListQuery = z.infer<typeof districtListQuery>;

/* A blank code is not sent: a new district's is made from its name, an existing one's stays. */
const code = unlessBlank(placeCode);

export const newDistrictBody = z
  .object({ name: placeName, code, state_id: ref('State').optional(), is_active: flag('is_active').optional() })
  .strict();
export type NewDistrictBody = z.infer<typeof newDistrictBody>;

export const updateDistrictBody = z
  .object({ name: placeName, code, state_id: ref('State'), is_active: flag('is_active') })
  .partial()
  .strict()
  .refine(hasChange, NO_CHANGE);
export type UpdateDistrictBody = z.infer<typeof updateDistrictBody>;
