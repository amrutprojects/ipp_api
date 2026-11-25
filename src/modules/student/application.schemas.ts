import { z } from 'zod';
import { hasControlChars } from '../../lib/text';
import { FORM_VALUE_MAX, FORM_VALUES_MAX, type Form } from '../../program/constants';

/* Half of a surrogate pair: text that is not Unicode, which PostgreSQL refuses in JSON. */
const LONE_SURROGATE = /\p{Cs}/u;
const storable = (v: string) => !hasControlChars(v) && !LONE_SURROGATE.test(v);
/* The text with what cannot be saved left out, at most as long as a value may be. */
const storablePart = (v: string) => [...v.slice(0, FORM_VALUE_MAX)].filter(storable).join('');

/*
 * The values of one step. complete = false keeps them as typed, so nothing about their content is an error (the portal sends
 * a refused autosave again for ever): what cannot be saved is left out. complete = true must be text that can be saved.
 */
export const saveStepBody = z
  .object({ complete: z.boolean().default(false), data: z.record(z.unknown()) })
  .strict()
  .superRefine(({ complete, data }, ctx) => {
    if (!complete) return;
    const issue = (message: string, key?: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: key === undefined ? ['data'] : ['data', key], message });
    if (Object.keys(data).length > FORM_VALUES_MAX) issue('Too many values');
    for (const [key, v] of Object.entries(data)) {
      if (typeof v !== 'string') issue('Value must be text', key);
      else if (v.length > FORM_VALUE_MAX) issue('Value is too long', key);
      else if (!storable(v)) issue('Value contains characters that cannot be saved', key);
    }
  })
  .transform(({ complete, data }) => ({
    complete,
    data: Object.fromEntries(
      Object.entries(data).flatMap(([key, v]) => (typeof v === 'string' ? [[key, complete ? v : storablePart(v)]] : [])),
    ) as Form,
  }));
export type SaveStepBody = z.output<typeof saveStepBody>;

/* Checked by the handler: another step is a 422, not a record that does not exist. */
export const stepParams = z.object({ step: z.string() });

/* A document's code, in any case. */
export const docTypeParams = z.object({
  docType: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,40}$/)
    .transform((v) => v.toUpperCase()),
});

/* The final submission (once; it cannot be changed afterwards). */
export const submitBody = z
  .object({
    declaration_accepted: z.literal(true, { errorMap: () => ({ message: 'The declaration must be accepted' }) }),
  })
  .strict();
