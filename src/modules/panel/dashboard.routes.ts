import { Api } from '../../http/api';
import { rows } from '../../db/pool';
import { ok } from '../../http/respond';

export const dashboardApi = new Api('Panel: dashboard');

/* One value of a filter and how many students have it; id and name null = not filled in yet (no form, or not chosen). */
export interface Group {
  id: string | null;
  name: string | null;
  count: number;
}
export interface DashboardFigures {
  districts: Group[];
  categories: Group[];
  technologies: Group[];
  centres: Group[];
  documents: { VERIFIED: number; NOT_VERIFIED: number };
  final: { VERIFIED: number; NOT_VERIFIED: number };
}

/*
 * Over the students of the list (Student tracking): every account not deleted and not in the trash, with its form if it
 * has one. The values are the ones the list's filters take (program/filters.ts), so a count opens the same students there.
 */
const PEOPLE = `student_accounts a LEFT JOIN applications p ON p.account_id = a.id AND p.deleted_at IS NULL`;
const ACTIVE = `a.deleted_at IS NULL AND a.manage_deleted_at IS NULL`;

const grouped = (id: string, name: string, joins: string) =>
  rows<Group>(
    `SELECT ${id} AS id, ${name} AS name, count(*)::int AS count
     FROM ${PEOPLE} ${joins}
     WHERE ${ACTIVE}
     GROUP BY 1, 2
     ORDER BY (${id}) IS NULL, count(*) DESC, lower(${name})`,
  );

/*
 * The Auditor's dashboard: the students by District, Category, Technology and Centre of their form, and by Documents and
 * Final verification. The form keeps the Technology as the choice's code: its id and name are those of the choice with
 * that code, a deleted one only when no other has it (as the list's Technology filter reads it).
 */
export async function dashboardFigures(): Promise<DashboardFigures> {
  const [districts, categories, technologies, centres, checks] = await Promise.all([
    grouped('p.district_id', 'dd.name', 'LEFT JOIN districts dd ON dd.id = p.district_id'),
    grouped(
      'p.caste_id',
      'coalesce(co.name_mr, co.name_en)',
      `LEFT JOIN program_options co ON co.id = p.caste_id AND co.kind = 'CASTE'`,
    ),
    grouped(
      'te.id',
      'te.name_en',
      `LEFT JOIN LATERAL (
         SELECT o.id, o.name_en FROM program_options o WHERE o.kind = 'TECHNOLOGY' AND o.code = p.data ->> 'technology'
         ORDER BY o.deleted_at NULLS FIRST LIMIT 1
       ) te ON true`,
    ),
    grouped('p.centre_id', 'ce.name', 'LEFT JOIN centres ce ON ce.id = p.centre_id'),
    rows<{ documents: number; no_documents: number; final: number; no_final: number }>(
      `SELECT count(*) FILTER (WHERE p.documents_verified_at IS NOT NULL)::int AS documents,
              count(*) FILTER (WHERE p.documents_verified_at IS NULL)::int AS no_documents,
              count(*) FILTER (WHERE p.approval_stage IS NOT DISTINCT FROM 'APPROVED')::int AS final,
              count(*) FILTER (WHERE p.approval_stage IS DISTINCT FROM 'APPROVED')::int AS no_final
       FROM ${PEOPLE} WHERE ${ACTIVE}`,
    ),
  ]);
  const c = checks[0]!;
  return {
    districts,
    categories,
    technologies,
    centres,
    documents: { VERIFIED: c.documents, NOT_VERIFIED: c.no_documents },
    final: { VERIFIED: c.final, NOT_VERIFIED: c.no_final },
  };
}

dashboardApi.get(
  '/manage/dashboard',
  {
    auth: 'panel',
    summary: "The Auditor's dashboard: students by District, Category, Technology, Centre, Documents and Final verification",
    returns:
      '{ districts, categories, technologies, centres: { id, name, count }[] (id null = not filled in), documents, final: { VERIFIED, NOT_VERIFIED } }',
  },
  async ({ res }) => ok(res, await dashboardFigures()),
);
