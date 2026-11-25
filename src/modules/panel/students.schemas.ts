import { z } from 'zod';
import {
  APPLICATION_STAGES,
  APPROVAL_FILTERS,
  FOLLOW_UP_STATUS,
  STAGES,
  type ApplicationStage,
  type FollowUpStatus,
  type Stage,
} from '../../program/constants';
import { studentFilterFields } from '../../program/filters';
import { given, panelListQuery, searchText } from './common';

const codes = <T extends string>(of: Record<T, string>) => Object.keys(of) as [T, ...T[]];

/* The student list: search, the filters of every student list, how far a form got, its approval, its follow-up status. */
export const studentListQuery = panelListQuery(['createdAt'] as const).extend({
  ...studentFilterFields,
  name: searchText('Name'),
  /* How far the form got, then whom it is with. */
  application_stage: given(
    z.enum(codes<ApplicationStage>(APPLICATION_STAGES), { errorMap: () => ({ message: 'Choose a stage' }) }).optional(),
  ),
  stage: given(z.enum(codes<Stage>(STAGES), { errorMap: () => ({ message: 'Choose a stage' }) }).optional()),
  /* The current follow-up status; NONE = not followed up yet. */
  follow_up: given(
    z
      .enum([...codes<FollowUpStatus>(FOLLOW_UP_STATUS), 'NONE'], { errorMap: () => ({ message: 'Choose a follow-up status' }) })
      .optional(),
  ),
  /* AWAITING / RETURNED = with the Auditor (RETURNED: sent back); or a stage. */
  approval: given(z.enum(APPROVAL_FILTERS, { errorMap: () => ({ message: 'Choose a stage' }) }).optional()),
});
export type StudentListQuery = z.infer<typeof studentListQuery>;
