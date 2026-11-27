import { z } from 'zod';
import { content, text } from '../../lib/text';
import { flag, hasChange, NO_CHANGE, optional, order } from '../masters/common.schemas';
import { ICONS, landingContent } from './content';

/* What the panel sends to the CMS. Texts are plain text: the landing page escapes them. */

export const saveLandingBody = z.object({ content: landingContent }).strict();
export type SaveLandingBody = z.infer<typeof saveLandingBody>;

const icon = z.enum(ICONS, { errorMap: () => ({ message: 'Choose an icon from the list' }) });
const oneLine = (label: string, max: number) => text(label, max).transform((v) => v.replace(/\s+/g, ' ').normalize('NFC'));
const tags = z
  .array(oneLine('Tag', 40), { invalid_type_error: 'Tags must be a list' })
  .max(10, 'At most 10 tags')
  .refine((list) => new Set(list.map((t) => t.toLowerCase())).size === list.length, 'Each tag only once');

const course = {
  title: oneLine('Title', 200),
  short_title: optional(oneLine('Short name', 120)),
  description: content('Description', 1000),
  icon,
  tags,
  registration_open: flag('Registration open'),
  display_order: order,
  is_active: flag('Shown'),
};
export const newCourseBody = z.object(course).partial().required({ title: true }).strict();
export type NewCourseBody = z.infer<typeof newCourseBody>;
export const updateCourseBody = z.object(course).partial().strict().refine(hasChange, NO_CHANGE);
export type UpdateCourseBody = z.infer<typeof updateCourseBody>;

export const ANSWER_KINDS = ['TEXT', 'COURSES'] as const;
const faq = {
  question: oneLine('Question', 300),
  answer: content('Answer', 2000),
  answer_kind: z.enum(ANSWER_KINDS, { errorMap: () => ({ message: 'Choose Text or List of courses' }) }),
  display_order: order,
  is_active: flag('Shown'),
};
export const newFaqBody = z.object(faq).partial().required({ question: true }).strict();
export type NewFaqBody = z.infer<typeof newFaqBody>;
export const updateFaqBody = z.object(faq).partial().strict().refine(hasChange, NO_CHANGE);
export type UpdateFaqBody = z.infer<typeof updateFaqBody>;
