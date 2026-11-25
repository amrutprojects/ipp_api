import { z } from 'zod';
import { rows } from '../db/pool';
import { blankAsMissing, contains } from '../lib/paging';
import { uuid } from '../lib/text';

/*
 * The filters every student list offers, over student_accounts `a` and its application `p` (may be missing). Name and mobile
 * match a part; a blank value is the same as none. documents = every uploaded document verified by the Auditor, or not;
 * final = finally approved or not.
 */
const checkState = z.enum(['VERIFIED', 'NOT_VERIFIED'], { errorMap: () => ({ message: 'Choose Verified or Not verified' }) });
export const studentFilterFields = {
  name: z.preprocess(blankAsMissing, z.string().trim().max(100, 'Name must be at most 100 characters').optional()),
  mobile: z.preprocess(
    blankAsMissing,
    z
      .string()
      .trim()
      .regex(/^\d{1,15}$/, 'Mobile number must be digits')
      .optional(),
  ),
  district_id: z.preprocess(blankAsMissing, uuid('District').optional()),
  caste_id: z.preprocess(blankAsMissing, uuid('Category').optional()),
  centre_id: z.preprocess(blankAsMissing, uuid('Centre').optional()),
  documents: z.preprocess(blankAsMissing, checkState.optional()),
  final: z.preprocess(blankAsMissing, checkState.optional()),
};
export type StudentFilters = z.infer<z.ZodObject<typeof studentFilterFields>> & { search?: string };

/* The current names of the form's District, Caste (Marathi) and Center Name. */
export const FILTER_JOINS = `
  LEFT JOIN districts dd ON dd.id = p.district_id
  LEFT JOIN program_options co ON co.id = p.caste_id AND co.kind = 'CASTE'
  LEFT JOIN centres ce ON ce.id = p.centre_id`;

export const FILTER_COLUMNS = `p.registration_code, dd.name AS district, p.district_id, coalesce(co.name_mr, co.name_en) AS category,
  ce.name AS centre, (p.documents_verified_at IS NOT NULL) AS documents_verified, (p.approval_stage IS NOT DISTINCT FROM 'APPROVED') AS final_verified`;

export interface FilterRow {
  registration_code: string | null;
  district: string | null;
  district_id: string | null;
  category: string | null;
  centre: string | null;
  documents_verified: boolean;
  final_verified: boolean;
}

/* The filtered columns as every list shows them. */
export const filterDto = (r: FilterRow) => ({
  district: r.district,
  district_id: r.district_id,
  category: r.category,
  centre: r.centre,
  documents_verified: r.documents_verified,
  final_verified: r.final_verified,
});

const SHORT_NAME = `(a.first_name || ' ' || a.last_name)`;

/* Adds the filters' values to `params` and returns the conditions (each starting with AND). */
export function filterSql(q: StudentFilters, params: unknown[]): string {
  const add = (v: unknown) => `$${params.push(v)}`;
  let where = '';
  if (q.search) {
    const n = add(contains(q.search));
    where += ` AND (a.full_name ILIKE ${n} OR ${SHORT_NAME} ILIKE ${n} OR a.email ILIKE ${n} OR a.mobile LIKE ${n}
      OR p.registration_code ILIKE ${n})`;
  }
  if (q.name) {
    const n = add(contains(q.name));
    where += ` AND (a.full_name ILIKE ${n} OR ${SHORT_NAME} ILIKE ${n})`;
  }
  if (q.mobile) where += ` AND a.mobile LIKE ${add(contains(q.mobile))}`;
  if (q.district_id) where += ` AND p.district_id = ${add(q.district_id)}`;
  if (q.caste_id) where += ` AND p.caste_id = ${add(q.caste_id)}`;
  if (q.centre_id) where += ` AND p.centre_id = ${add(q.centre_id)}`;
  if (q.documents) where += ` AND p.documents_verified_at IS ${q.documents === 'VERIFIED' ? 'NOT NULL' : 'NULL'}`;
  if (q.final) where += ` AND p.approval_stage IS ${q.final === 'VERIFIED' ? 'NOT DISTINCT' : 'DISTINCT'} FROM 'APPROVED'`;
  return where;
}

type Choice = { id: string; name: string };

/* Choices of the District and Centre filters: active districts; every centre that is not deleted. */
export async function filterChoices(): Promise<{ districts: Choice[]; centres: Choice[] }> {
  const [districts, centres] = await Promise.all([
    rows<Choice>(`SELECT id, name FROM districts WHERE is_active ORDER BY lower(name)`),
    rows<Choice>(`SELECT id, name FROM centres WHERE deleted_at IS NULL ORDER BY lower(name)`),
  ]);
  return { districts, centres };
}
