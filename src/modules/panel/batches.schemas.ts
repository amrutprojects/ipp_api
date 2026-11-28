import { z } from 'zod';
import { content, isDate, uuid } from '../../lib/text';
import { BATCH_NAME_MAX, BATCH_SIZE, DELIVERY_MODES } from '../../program/constants';
import { blankToNull, panelListQuery, studentIds } from './common';

export const batchParams = z.object({ id: uuid() });

export const batchListQuery = panelListQuery(['createdAt', 'name'] as const);
export type BatchListQuery = z.infer<typeof batchListQuery>;

const nothingToMissing = (v: unknown) => blankToNull(v) ?? undefined;

/* A day (YYYY-MM-DD); null clears it. */
const day = (message: string) =>
  z.preprocess(blankToNull, z.string({ invalid_type_error: message }).trim().refine(isDate, message).nullable().optional());

const NO_TECHNOLOGY = 'Please select a technology.';
const schedule = {
  start_date: day('Enter a valid start date'),
  end_date: day('Enter a valid end date'),
  /* Never empty: none (or null) = offline for a new batch, unchanged for another. */
  delivery_mode: z.preprocess(
    nothingToMissing,
    z.enum(DELIVERY_MODES, { errorMap: () => ({ message: 'Select a valid delivery mode' }) }).optional(),
  ),
  /* A technology master ID; the service also checks unchanged IDs on edit. */
  technology: z.string({ invalid_type_error: NO_TECHNOLOGY }).uuid(NO_TECHNOLOGY).optional(),
};

const name = content('Batch name', BATCH_NAME_MAX, 2);

export const createBatchBody = z
  .object({
    name,
    centre_id: uuid('Centre'),
    ids: studentIds({ max: BATCH_SIZE.MAX, twice: 'Each student may be listed only once', list: 'Students must be a list' }),
    ...schedule,
    technology: z.string({ required_error: NO_TECHNOLOGY, invalid_type_error: NO_TECHNOLOGY }).uuid(NO_TECHNOLOGY),
  })
  .strict();
export type CreateBatchBody = z.infer<typeof createBatchBody>;

export const updateBatchBody = z
  .object({ name: name.optional(), centre_id: uuid('Centre').optional(), ...schedule })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');
export type UpdateBatchBody = z.infer<typeof updateBatchBody>;

/*
 * Starting or ending a batch: the signed-in user's e-mail and password again (the final confirmation), and the date and time
 * it started or ended (an ISO date-time, e.g. from the browser's local date and time).
 */
export const batchRunBody = z
  .object({
    email: z
      .string({ required_error: 'Email is required', invalid_type_error: 'Email must be text' })
      .trim()
      .min(1, 'Email is required')
      .max(254),
    password: z
      .string({ required_error: 'Password is required', invalid_type_error: 'Password must be text' })
      .min(1, 'Password is required')
      .max(200, 'Password must be at most 200 characters'),
    at: z
      .string({ required_error: 'Date and time are required', invalid_type_error: 'Date and time must be text' })
      .refine((v) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v), 'Enter a valid date and time'),
  })
  .strict();
export type BatchRunBody = z.infer<typeof batchRunBody>;
