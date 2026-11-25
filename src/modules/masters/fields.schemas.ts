import { z } from 'zod';
import { hasControlChars } from '../../lib/text';
import { FIELD_TYPES, FORM_VALUE_MAX } from '../../program/constants';
import { hasChoices } from '../../program/field-types';
import { CHECK_KINDS, CUSTOM_CHECKS_MAX, RULE_TYPES } from '../../program/validation';
import { flag, hasChange, named, names, NO_CHANGE, optionalNamed, order } from './common.schemas';

const choices = z
  .array(z.object(names).strict(), { invalid_type_error: 'Choices must be a list' })
  .max(200, 'At most 200 choices')
  .refine((a) => new Set(a.map((o) => o.name_en.toLowerCase())).size === a.length, 'Each choice may be listed only once');
const step = z.union([z.literal(1), z.literal(2)], { errorMap: () => ({ message: 'Choose step 1 or 2' }) });
const type = z.enum(FIELD_TYPES, { errorMap: () => ({ message: 'Choose a type' }) });
const texts = {
  label_en: named('Label'),
  label_mr: optionalNamed('Marathi label'),
  help_en: optionalNamed('Help text', 300),
  help_mr: optionalNamed('Marathi help text', 300),
};

/* The checks of a field (program/validation.ts): that they fit and can be run is the service's to say. */
const source = z
  .string({ required_error: 'Write the check', invalid_type_error: 'The check must be text' })
  .max(2000, 'The check must be at most 2000 characters')
  .refine((v) => v.trim() !== '', 'Write the check')
  .refine((v) => !hasControlChars(v), 'The check contains characters that cannot be saved');
const customCheck = z
  .object({
    kind: z.enum(CHECK_KINDS, { errorMap: () => ({ message: 'Choose a regular expression or a JavaScript function' }) }),
    source,
    flags: z
      .string({ invalid_type_error: 'Flags must be text' })
      .refine(
        (v) => [...v].every((f, n) => 'imsu'.includes(f) && v.indexOf(f) === n),
        'Only the flags i, m, s and u can be used, each once',
      )
      .optional(),
    message_en: named('Error message'),
    message_mr: optionalNamed('Marathi error message'),
  })
  .strict();
const validation = z
  .object({
    rules: z
      .array(
        z
          .object({
            type: z.enum(RULE_TYPES, { errorMap: () => ({ message: 'Unknown check' }) }),
            value: z
              .union([z.number().finite(), z.string().max(10)], { errorMap: () => ({ message: 'Enter a number' }) })
              .optional(),
          })
          .strict(),
        { invalid_type_error: 'Checks must be a list' },
      )
      .max(RULE_TYPES.length, 'Each check may be chosen only once')
      .refine((a) => new Set(a.map((r) => r.type)).size === a.length, 'Each check may be chosen only once')
      .default([]),
    custom: z
      .array(customCheck, { invalid_type_error: 'Custom checks must be a list' })
      .max(CUSTOM_CHECKS_MAX, `At most ${CUSTOM_CHECKS_MAX} custom checks`)
      .default([]),
  })
  .strict()
  .nullable();
export type ValidationBody = z.infer<typeof validation>;

/* Tries the checks on a value, before they are saved. */
export const testValidationBody = z
  .object({
    label_en: named('Label'),
    type,
    validation,
    value: z
      .string({ required_error: 'Enter a value to try', invalid_type_error: 'The value must be text' })
      .max(FORM_VALUE_MAX, 'The value is too long')
      .refine((v) => v.trim() !== '', 'Enter a value to try'),
  })
  .strict();
export type TestValidationBody = z.infer<typeof testValidationBody>;

/* Also said by the service, when a field becomes a dropdown or is no longer one. */
export const NO_CHOICES = 'Add at least one choice';
export const NO_CHOICES_HERE = 'A field of this type has no choices';

export const newFieldBody = z
  .object({
    ...texts,
    step,
    type,
    required: flag('required').optional(),
    order: order.optional(),
    is_active: flag('is_active').optional(),
    options: choices.optional(),
    validation: validation.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message });
    if (hasChoices(b.type) && !b.options?.length) issue(NO_CHOICES);
    if (!hasChoices(b.type) && b.options?.length) issue(NO_CHOICES_HERE);
  });
export type NewFieldBody = z.infer<typeof newFieldBody>;

/* Which types a field takes depends on it: fields.service.ts. */
export const updateFieldBody = z
  .object({
    ...texts,
    order,
    required: flag('required'),
    is_active: flag('is_active'),
    step,
    type,
    options: choices,
    validation,
  })
  .partial()
  .strict()
  .refine(hasChange, NO_CHANGE);
export type UpdateFieldBody = z.infer<typeof updateFieldBody>;
