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

export const userParams = z.object({ id: uuid() });
export const userStatusBody = z
  .object({
    is_active: z.boolean({ required_error: 'is_active is required', invalid_type_error: 'is_active must be true or false' }),
  })
  .strict();
