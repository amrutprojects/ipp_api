import { z } from 'zod';
import { hasControlChars, uuid } from '../../lib/text';

/* What Sarthi sends (docs/SARTHI_LINK.md, section 3). A malformed call is refused as a whole (422). */
const STAGES = ['DIVISION', 'COEP', 'HEAD_OFFICE', 'SUPER_ADMIN'] as const;
const storable = (v: string) => !hasControlChars(v);
const line = (max: number) => z.string().trim().min(1).max(max).refine(storable, 'Contains characters that cannot be saved');

const decision = z
  .object({
    id: uuid('Decision'),
    application_id: uuid('Application'),
    action: z.enum(['APPROVE', 'REJECT', 'MOVE']),
    from: z.enum(STAGES),
    to: z.enum(['AUDITOR', ...STAGES, 'APPROVED']),
    reason: z.string().trim().max(500).refine(storable, 'Contains characters that cannot be saved').nullable(),
    by: z.object({ name: line(150), role: line(60) }).strict(),
    at: z.string().datetime({ offset: true, message: 'Must be an ISO date and time' }),
  })
  .strict()
  .refine((d) => d.action !== 'REJECT' || (d.reason?.length ?? 0) >= 3, {
    path: ['reason'],
    message: 'A rejection needs a reason of 3 to 500 characters',
  });
export type Decision = z.infer<typeof decision>;

export const decisionsBody = z.object({ decisions: z.array(decision).min(1).max(100) }).strict();

export const documentParams = z.object({
  id: uuid(),
  /* A malformed code is a document that has no file. */
  code: z.string().transform((v) => (/^[A-Za-z0-9_]{1,40}$/.test(v) ? v.toUpperCase() : '')),
});
