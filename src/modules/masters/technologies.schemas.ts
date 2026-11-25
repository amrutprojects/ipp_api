import { z } from 'zod';
import { uuid } from '../../lib/text';

export const districtParams = z.object({ districtId: uuid() });

export const districtTechnologiesBody = z
  .object({
    codes: z
      .array(z.string().trim().toUpperCase().min(1).max(120), {
        invalid_type_error: 'codes must be a list',
        required_error: 'codes is required',
      })
      .max(200, 'At most 200 technologies')
      .refine((a) => new Set(a).size === a.length, 'Each technology may be listed only once'),
  })
  .strict();
export type DistrictTechnologiesBody = z.infer<typeof districtTechnologiesBody>;
