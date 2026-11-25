import { Api } from '../../http/api';
import { studentOf } from '../../http/auth';
import { created, ok } from '../../http/respond';
import { emailBody, loginBody, otpBody, resetPasswordBody, resetTokenBody, signupBody } from './accounts.schemas';
import { accountDto, accountsService, RESET_LINK_MINUTES, RESET_WAIT_SECONDS } from './accounts.service';

const OTP_SENT = 'An OTP has been sent to your mobile number';
const TIMING = 'OtpTiming: email, mobile_masked, otp_expires_in and resend_after (seconds)';
const SESSION = 'Session: token, expires_at and account';

export const accountsApi = new Api('Student account');

accountsApi.post(
  '/auth/register',
  {
    auth: 'public',
    limited: true,
    status: 201,
    summary: 'Create an account (or replace one not verified yet) and text a one-time code to its mobile number',
    returns: TIMING,
    body: signupBody,
  },
  async ({ req, res, body }) => created(res, await accountsService.register(req, body), OTP_SENT),
);

accountsApi.post(
  '/auth/verify-otp',
  {
    auth: 'public',
    limited: true,
    summary: 'Verify the mobile number with the texted code and the sign-up password, and sign in',
    returns: SESSION,
    body: otpBody,
  },
  async ({ req, res, body }) =>
    ok(
      res,
      await accountsService.verifyOtp(req, body.email, body.otp, body.password),
      'Account created. Your mobile number is verified.',
    ),
);

accountsApi.post(
  '/auth/resend-otp',
  { auth: 'public', limited: true, summary: 'Text a new one-time code', returns: TIMING, body: emailBody },
  async ({ res, body }) => ok(res, await accountsService.resendOtp(body.email), OTP_SENT),
);

accountsApi.post(
  '/auth/otp-status',
  {
    auth: 'public',
    limited: true,
    summary: 'How long the pending code still works, and when a new one can be asked for',
    returns: TIMING,
    body: emailBody,
  },
  async ({ res, body }) => ok(res, await accountsService.otpStatus(body.email)),
);

accountsApi.post(
  '/auth/login',
  { auth: 'public', limited: true, summary: 'Sign in with e-mail and password', returns: SESSION, body: loginBody },
  async ({ res, body }) => ok(res, await accountsService.login(body.email, body.password), 'Logged in'),
);

accountsApi.post(
  '/auth/forgot-password',
  {
    auth: 'public',
    limited: true,
    summary: 'E-mail a link to set a new password',
    returns: 'email, link_valid_minutes and resend_after (seconds)',
    body: emailBody,
  },
  async ({ req, res, body }) => {
    await accountsService.forgotPassword(req, body.email);
    ok(
      res,
      { email: body.email, link_valid_minutes: RESET_LINK_MINUTES, resend_after: RESET_WAIT_SECONDS },
      `A password reset link has been sent to your email ID. The link is valid for ${RESET_LINK_MINUTES} minutes.`,
    );
  },
);

accountsApi.post(
  '/auth/reset-password/check',
  {
    auth: 'public',
    limited: true,
    summary: 'Whether a reset link can still be used, and for which e-mail',
    returns: 'email',
    body: resetTokenBody,
  },
  async ({ res, body }) => ok(res, await accountsService.checkResetLink(body.token)),
);

accountsApi.post(
  '/auth/reset-password',
  {
    auth: 'public',
    limited: true,
    summary: 'Set a new password from a reset link (signs out every device)',
    returns: 'email',
    body: resetPasswordBody,
  },
  async ({ req, res, body }) =>
    ok(
      res,
      await accountsService.resetPassword(req, body.token, body.password),
      'Your password has been changed. Please log in with your new password.',
    ),
);

accountsApi.get('/me', { auth: 'student', summary: 'The signed-in student', returns: 'Account' }, ({ res }) =>
  ok(res, accountDto(studentOf(res))),
);
