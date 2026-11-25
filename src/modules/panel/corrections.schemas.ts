import { z } from 'zod';
import { hasControlChars } from '../../lib/text';
import { FORM_VALUE_MAX, FORM_VALUES_MAX } from '../../program/constants';

/* The changed fields of a form, as typed: text that can be stored; what it must be is the form's check (program/form.ts). */
export const editFormBody = z
  .object({
    data: z
      .record(
        z
          .string({ invalid_type_error: 'Value must be text' })
          .max(FORM_VALUE_MAX, 'Value is too long')
          .refine((v) => !hasControlChars(v), 'Value contains characters that cannot be saved'),
        { required_error: 'data is required', invalid_type_error: 'data must be an object' },
      )
      .refine((d) => Object.keys(d).length <= FORM_VALUES_MAX, 'Too many values'),
  })
  .strict();
