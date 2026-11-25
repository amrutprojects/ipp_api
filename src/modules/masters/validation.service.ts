import { AppError, type FieldError } from '../../http/errors';
import type { FieldType } from '../../program/constants';
import { expressionProblem, functionProblem } from '../../program/sandbox';
import { PAIRS, RULES, rulesFor, type FieldValidation } from '../../program/validation';
import type { ValidationBody } from './fields.schemas';

/* The checks an ADMIN gives to a field: that they fit its type and can be run. */

/* Checks them (422, every problem), and gives them as they are stored; null = none. */
export async function checkedValidation(type: FieldType, body: ValidationBody): Promise<FieldValidation | null> {
  if (!body) return null;
  const errors: FieldError[] = [];
  const issue = (path: string, message: string) => errors.push({ field: `body.validation.${path}`, message });
  body.rules.forEach((r, i) => {
    const rule = RULES[r.type];
    const wrong = rule.limit ? rule.limit(r.value, type) : r.value === undefined ? null : 'This check has no limit';
    if (!rule.on.includes(type)) issue(`rules.${i}.type`, 'This check does not fit the type of the field');
    else if (wrong) issue(`rules.${i}.value`, wrong);
  });
  for (const [min, max] of PAIRS) {
    const at = body.rules.findIndex((r) => r.type === max);
    const low = body.rules.find((r) => r.type === min)?.value;
    const high = body.rules[at]?.value;
    /* Of one kind, numbers or dates as text: compared as they are. */
    if (low !== undefined && high !== undefined && typeof low === typeof high && low > high)
      issue(`rules.${at}.value`, 'The maximum is smaller than the minimum');
  }
  for (const [i, c] of body.custom.entries()) {
    const problem = c.kind === 'REGEX' ? await expressionProblem(c.source, c.flags ?? '') : await functionProblem(c.source);
    if (problem) issue(`custom.${i}.source`, `This ${c.kind === 'REGEX' ? 'expression' : 'function'} cannot be used: ${problem}`);
  }
  if (errors.length) throw AppError.validation(errors);
  if (!body.rules.length && !body.custom.length) return null;
  return {
    rules: body.rules,
    custom: body.custom.map((c) => ({
      kind: c.kind,
      source: c.source,
      ...(c.kind === 'REGEX' ? { flags: c.flags ?? '' } : {}),
      message_en: c.message_en,
      message_mr: c.message_mr ?? null,
    })),
  };
}

/* The checks a field keeps when its type changes: the rules that fit the new one, with their limits, and its own checks. */
export function keptFor(type: FieldType, v: FieldValidation | null): FieldValidation | null {
  if (!v) return null;
  const rules = rulesFor(type, v.rules).filter((r) => !RULES[r.type].limit?.(r.value, type));
  return rules.length || v.custom.length ? { rules, custom: v.custom } : null;
}

export const stored = (v: FieldValidation | null) => (v ? JSON.stringify(v) : null);
