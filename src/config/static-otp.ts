/*
 * A fixed sign-up code for a developer's own machine (STATIC_OTP, e.g. 666666): no SMS is sent and this code is the
 * OTP. It counts only where both are true: NODE_ENV is development, and the portal's address is localhost. Anywhere else
 * (the staging and production servers, whatever their .env holds) it is ignored, and a random code goes out by SMS with
 * the gateway's own credentials: a fixed code there would let anyone sign up with any mobile number.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function staticOtpFor(nodeEnv: string, portalUrl: string, code: string | undefined): string | null {
  if (!code || nodeEnv !== 'development') return null;
  try {
    return LOCAL_HOSTS.includes(new URL(portalUrl).hostname) ? code : null;
  } catch {
    return null;
  }
}
