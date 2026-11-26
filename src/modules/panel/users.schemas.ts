import { z } from 'zod';
import { content, email, password, uuid } from '../../lib/text';

/* An existing password: only compared, so no rule but its length. */
export const loginBody = z
  .object({
    email,
    password: z
      .string({ required_error: 'Password is required', invalid_type_error: 'Password must be text' })
      .min(1, 'Password is required')
      .max(200, 'Password must be at most 200 characters'),
  })
  .strict();
export type LoginBody = z.infer<typeof loginBody>;

export const newUserBody = z
  .object({
    name: content('Name', 150, 2),
    email,
    password,
    role: z.enum(['ADMIN', 'VIEWER'], { errorMap: () => ({ message: 'Choose Admin or Viewer' }) }),
  })
  .strict();
export type NewUserBody = z.infer<typeof newUserBody>;

/* Name, email and role of a user; the password stays (the user changes it). */
export const updateUserBody = z
  .object({
    name: content('Name', 150, 2),
    email,
    role: z.enum(['ADMIN', 'VIEWER'], { errorMap: () => ({ message: 'Choose Admin or Viewer' }) }),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateUserBody = z.infer<typeof updateUserBody>;

export const userParams = z.object({ id: uuid() });
export const userStatusBody = z
  .object({
    is_active: z.boolean({ required_error: 'is_active is required', invalid_type_error: 'is_active must be true or false' }),
  })
  .strict();
