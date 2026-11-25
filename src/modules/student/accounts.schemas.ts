import { z } from 'zod';
import { email, hasControlChars, mobileNumber, NAME_RE, password, personName } from '../../lib/text';

const confirmPassword = z
  .string({ required_error: 'Please re-enter the password', invalid_type_error: 'Please re-enter the password' })
  .min(1, 'Please re-enter the password');
const passwordsMatch = (v: { password: string; confirm_password: string }, ctx: z.RefinementCtx) => {
  if (v.password !== v.confirm_password)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm_password'], message: 'Passwords do not match' });
};
/* A password that is compared, not chosen: its rules are not checked again. */
const anyPassword = z
  .string({ required_error: 'Password is required', invalid_type_error: 'Password must be text' })
  .min(1, 'Password is required')
  .max(200, 'Password must be at most 200 characters');

export const signupBody = z
  .object({
    first_name: personName('First name', 100),
    middle_name: z
      .string({ invalid_type_error: 'Middle name must be text' })
      .trim()
      .max(100, 'Middle name must be at most 100 characters')
      .refine((v) => !hasControlChars(v), 'Middle name contains characters that cannot be saved')
      .refine((v) => !v || NAME_RE.test(v), "Middle name may contain only letters, spaces and . ' -")
      .optional(),
    last_name: personName('Last name', 100),
    email,
    mobile_number: mobileNumber('Mobile number'),
    password,
    confirm_password: confirmPassword,
  })
  .strict()
  .superRefine(passwordsMatch);
export type SignupBody = z.infer<typeof signupBody>;

export const emailBody = z.object({ email }).strict();

/* The texted code, with the password chosen at sign-up (the code proves the handset, the password who signed up). */
export const otpBody = z
  .object({
    email,
    otp: z
      .string({ required_error: 'OTP is required', invalid_type_error: 'Enter the 6-digit OTP' })
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit OTP'),
    password: anyPassword,
  })
  .strict();

export const loginBody = z.object({ email, password: anyPassword }).strict();

/* The token of an e-mailed link; whether it is valid is the database's answer, not its form's. */
const resetToken = z
  .string({
    required_error: 'The password reset link is incomplete',
    invalid_type_error: 'The password reset link is incomplete',
  })
  .trim()
  .min(1, 'The password reset link is incomplete')
  .max(200, 'This password reset link is not valid');
export const resetTokenBody = z.object({ token: resetToken }).strict();
export const resetPasswordBody = z
  .object({ token: resetToken, password, confirm_password: confirmPassword })
  .strict()
  .superRefine(passwordsMatch);
