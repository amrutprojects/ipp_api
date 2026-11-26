import { z } from 'zod';
import { content, uuid } from '../../lib/text';
import { BATCH_SIZE } from '../../program/constants';
import { HELP_FIELDS_MAX } from '../../program/settings';
import { blankToNull } from './common';

/* What the panel's settings accept. */

const issue = (ctx: z.RefinementCtx, path: (string | number)[], message: string) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

const batchSize = z
  .number({ required_error: 'Batch size is required', invalid_type_error: 'Batch size must be a number' })
  .int('Batch size must be a whole number')
  .min(BATCH_SIZE.MIN, `Batch size must be at least ${BATCH_SIZE.MIN}`)
  .max(BATCH_SIZE.MAX, `Batch size must be at most ${BATCH_SIZE.MAX}`);

/* The default size, and the districts with a size of their own: given, they replace the ones there are; left out, they stay. */
export const batchSizeBody = z
  .object({
    size: batchSize,
    districts: z
      .array(z.object({ district_id: uuid('District'), size: batchSize }).strict(), {
        invalid_type_error: 'Districts must be a list',
      })
      .max(500, 'At most 500 districts')
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.districts?.forEach((d, i) => {
      const id = d.district_id.toLowerCase();
      if (seen.has(id)) issue(ctx, ['districts', i, 'district_id'], 'Each district may be listed only once');
      seen.add(id);
    });
  });
export type BatchSizeBody = z.infer<typeof batchSizeBody>;

/* The contact line: a placeholder in the message needs its value. */
export const supportBody = z
  .object({
    message: content('Message', 500, 10),
    email: z.preprocess(
      blankToNull,
      z
        .string({ invalid_type_error: 'Email must be text' })
        .trim()
        .toLowerCase()
        .max(254, 'Email must be at most 254 characters')
        .email('Enter a valid email address')
        .nullable()
        .optional(),
    ),
    mobile: z.preprocess(
      blankToNull,
      z
        .string({ invalid_type_error: 'Mobile must be text' })
        .trim()
        .regex(/^\+?\d[\d ()-]{5,18}\d$/, 'Enter a valid phone number, e.g. 8530092236 or +91 85300 92236')
        .nullable()
        .optional(),
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.message.includes('{email}') && !v.email) issue(ctx, ['email'], 'Email is required because the message uses {email}');
    if (v.message.includes('{mobile}') && !v.mobile)
      issue(ctx, ['mobile'], 'Mobile is required because the message uses {mobile}');
  });

const enabled = z.boolean({ invalid_type_error: 'enabled must be true or false' }).optional().default(true);

/* The dialog shown once the account is created; a blank button label leaves the portal's own text. */
export const welcomeBody = z
  .object({
    enabled,
    title: content('Title', 120, 3),
    message: content('Message', 1000, 10),
    button_label: content('Button label', 60).optional().default(''),
  })
  .strict();

/* The Help button: checked as sent (the rows' numbers are those on the screen); a row needs both halves or none. */
const helpField = z
  .object({ label: content('Field name', 60).optional().default(''), value: content('Value', 200).optional().default('') })
  .strict();
export const helpBody = z
  .object({
    enabled,
    title: content('Title', 120, 2).optional().default('Need help?'),
    intro: content('Intro', 300).optional().default(''),
    fields: z
      .array(helpField, { invalid_type_error: 'Fields must be a list' })
      .max(HELP_FIELDS_MAX, `At most ${HELP_FIELDS_MAX} fields can be shown`)
      .optional()
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    v.fields.forEach((f, i) => {
      if (f.value && !f.label) issue(ctx, ['fields', i, 'label'], 'Field name is required when a value is given');
      if (f.label && !f.value) issue(ctx, ['fields', i, 'value'], 'Value is required when a field name is given');
    });
    if (v.enabled && !v.fields.some((f) => f.label && f.value))
      issue(ctx, ['fields'], 'Add at least one contact detail to show in the Help panel');
  });

/* "Enable Rejection Email Notification and Resubmission": required, so a missing value never switches it by accident. */
export const rejectionBody = z
  .object({ enabled: z.boolean({ required_error: 'enabled is required', invalid_type_error: 'enabled must be true or false' }) })
  .strict();
