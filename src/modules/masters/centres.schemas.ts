import { z } from 'zod';
import { blankAsMissing } from '../../lib/paging';
import { hasControlChars, NAME_RE } from '../../lib/text';
import { entityName, flag, masterListQuery, optional, placeCode, ref, unlessBlank } from './common.schemas';

export const centreListQuery = masterListQuery(['name', 'code', 'districtName', 'createdAt', 'updatedAt'] as const).extend({
  isActive: z.preprocess(
    blankAsMissing,
    z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  ),
  stateId: unlessBlank(ref('State')),
  districtId: unlessBlank(ref('District')),
});
export type CentreListQuery = z.infer<typeof centreListQuery>;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .refine((v) => !hasControlChars(v), 'Contains characters that cannot be saved');

/* The state only cross-checks the district; the taluka is one of the district's. */
const fields = {
  stateId: ref('State').optional(),
  districtId: ref('District'),
  talukaId: optional(ref('Taluka')),
  name: entityName,
  code: placeCode,
  address: optional(text(300)),
  pinCode: optional(
    z
      .string()
      .trim()
      .regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code'),
  ),
  contactPerson: optional(text(120).refine((v) => NAME_RE.test(v), "Contact person may contain only letters, spaces and . ' -")),
  /* A mobile number, or a landline with its STD code. */
  contactNumber: optional(
    z
      .string()
      .transform((v) => v.replace(/\s+/g, ''))
      .pipe(z.string().regex(/^(?:[6-9]\d{9}|0\d{2,4}-?\d{6,8})$/, 'Enter a 10-digit mobile number or a landline with STD code')),
  ),
  email: optional(z.string().trim().toLowerCase().email('Enter a valid email address').max(254, 'Enter a valid email address')),
};

export const newCentreBody = z.object({ ...fields, isActive: flag('isActive').optional() }).strict();
export type NewCentreBody = z.infer<typeof newCentreBody>;

export const updateCentreBody = z
  .object(fields)
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');
export type UpdateCentreBody = z.infer<typeof updateCentreBody>;

export const centreStatusBody = z.object({ isActive: flag('isActive') }).strict();
