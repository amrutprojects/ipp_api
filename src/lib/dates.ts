import { env } from '../config/env';

const format = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/* Today's date where the program is run (Asia/Kolkata), YYYY-MM-DD. Dates are compared as text. */
export const today = (now: Date = new Date()): string => format.format(now);

/* Whole years from a date of birth to a day. */
export function ageOn(born: string, day: string): number {
  const [by, bm, bd] = born.split('-').map(Number) as [number, number, number];
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
