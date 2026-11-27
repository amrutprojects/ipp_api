import { one, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { ORDER_MAX } from '../../program/constants';
import { orConflict, record, type By } from '../masters/common.service';
import type { NewCourseBody, NewFaqBody, UpdateCourseBody, UpdateFaqBody } from './cms.schemas';
import { readContent, type LandingContent } from './content';
import { DEFAULT_CONTENT } from './defaults';
import type { LogoImage } from './logo';

/*
 * The landing page CMS. The page's document is one row of cms_documents (key "landing"), read over the defaults; the logo
 * one row of cms_assets; courses and FAQs are soft-deleted rows, shown on the page while active.
 */
const PAGE = 'landing';
const LOGO = 'logo';
export const LOGO_PATH = '/landing/logo';

export interface CourseRow {
  id: string;
  title: string;
  short_title: string | null;
  description: string;
  icon: string;
  tags: string[];
  registration_open: boolean;
  display_order: number;
  is_active: boolean;
  updated_at: Date;
}
export interface FaqRow {
  id: string;
  question: string;
  answer: string;
  answer_kind: 'TEXT' | 'COURSES';
  display_order: number;
  is_active: boolean;
  updated_at: Date;
}
export interface LogoMeta {
  mime_type: string;
  size_bytes: number;
  version: string;
  updated_at: Date;
}

const COURSE = `SELECT id, title, short_title, description, icon, tags, registration_open, display_order, is_active, updated_at
  FROM cms_courses WHERE deleted_at IS NULL`;
const FAQ = `SELECT id, question, answer, answer_kind, display_order, is_active, updated_at FROM cms_faqs WHERE deleted_at IS NULL`;

const pageRow = (db?: Db) =>
  one<{ value: unknown; updated_at: Date; updated_by: string | null }>(
    `SELECT d.value, d.updated_at, u.name AS updated_by
     FROM cms_documents d LEFT JOIN panel_users u ON u.id = d.updated_by WHERE d.key = $1`,
    [PAGE],
    db,
  );
const logoMeta = (db?: Db) =>
  one<LogoMeta>('SELECT mime_type, size_bytes, version, updated_at FROM cms_assets WHERE key = $1', [LOGO], db);

/* After the last one, within the limit of an order. */
const nextOrder = async (db: Db, table: 'cms_courses' | 'cms_faqs') =>
  Math.min(
    ORDER_MAX,
    (await one<{ n: number }>(
      `SELECT COALESCE(max(display_order), 0)::int + 10 AS n FROM ${table} WHERE deleted_at IS NULL`,
      [],
      db,
    ))!.n,
  );

async function getCourse(db: Db, id: string): Promise<CourseRow> {
  const row = await one<CourseRow>(`${COURSE} AND id = $1`, [id], db);
  if (!row) throw AppError.notFound('Course not found');
  return row;
}
async function lockCourse(db: Db, id: string): Promise<CourseRow> {
  const row = await one<CourseRow>(`${COURSE} AND id = $1 FOR UPDATE`, [id], db);
  if (!row) throw AppError.notFound('Course not found');
  return row;
}
async function getFaq(db: Db, id: string): Promise<FaqRow> {
  const row = await one<FaqRow>(`${FAQ} AND id = $1`, [id], db);
  if (!row) throw AppError.notFound('Question not found');
  return row;
}
async function lockFaq(db: Db, id: string): Promise<FaqRow> {
  const row = await one<FaqRow>(`${FAQ} AND id = $1 FOR UPDATE`, [id], db);
  if (!row) throw AppError.notFound('Question not found');
  return row;
}
/* A written answer needs its text; the list of courses may go without an introduction. */
function assertAnswer(kind: FaqRow['answer_kind'], answer: string): void {
  if (kind === 'TEXT' && !answer.trim()) throw AppError.validation([{ field: 'body.answer', message: 'Answer is required' }]);
}

const COURSE_TITLE = { uq_cms_courses_title: 'A course with this title already exists' };
const FAQ_QUESTION = { uq_cms_faqs_question: 'This question is already in the list' };

export const cmsService = {
  /* ------------------------------------------------------------------------------------------------ the public page */

  /* Everything the landing page shows: the document, the shown courses and FAQs in order, and the logo's address. */
  async publicPage() {
    const [page, courses, faqs, logo] = await Promise.all([
      pageRow(),
      rows<Omit<CourseRow, 'display_order' | 'is_active' | 'updated_at'>>(
        `SELECT id, title, short_title, description, icon, tags, registration_open FROM cms_courses
         WHERE is_active AND deleted_at IS NULL ORDER BY display_order, lower(title), id`,
      ),
      rows<Pick<FaqRow, 'id' | 'question' | 'answer' | 'answer_kind'>>(
        `SELECT id, question, answer, answer_kind FROM cms_faqs
         WHERE is_active AND deleted_at IS NULL ORDER BY display_order, id`,
      ),
      logoMeta(),
    ]);
    return {
      content: readContent(page?.value),
      courses,
      faqs,
      logo: logo ? { path: LOGO_PATH, version: logo.version } : null,
      updated_at: page?.updated_at ?? null,
    };
  },

  logoFile: () =>
    one<{ mime_type: string; size_bytes: number; data: Buffer; version: string }>(
      'SELECT mime_type, size_bytes, data, version FROM cms_assets WHERE key = $1',
      [LOGO],
    ),

  /* ------------------------------------------------------------------------------------------------ the panel */

  async landing(db?: Db) {
    const page = await pageRow(db);
    const logo = await logoMeta(db);
    return {
      content: readContent(page?.value),
      defaults: DEFAULT_CONTENT,
      logo: logo ? { ...logo, path: LOGO_PATH } : null,
      updated_at: page?.updated_at ?? null,
      updated_by: page?.updated_by ?? null,
    };
  },

  saveLanding(who: By, content: LandingContent) {
    return transaction(async (db) => {
      await db.query(
        `INSERT INTO cms_documents (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
        [PAGE, JSON.stringify(content), who.user.id],
      );
      await record(db, who, 'edp.cms.landing.update', 'cms', PAGE);
      return cmsService.landing(db);
    });
  },

  saveLogo(who: By, image: LogoImage) {
    return transaction(async (db) => {
      await db.query(
        `INSERT INTO cms_assets (key, mime_type, size_bytes, data, version, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO UPDATE SET mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
           data = EXCLUDED.data, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by`,
        [LOGO, image.mime, image.data.length, image.data, image.version, who.user.id],
      );
      await record(db, who, 'edp.cms.logo.update', 'cms', LOGO, { mime_type: image.mime, size_bytes: image.data.length });
      return { ...(await logoMeta(db))!, path: LOGO_PATH };
    });
  },

  removeLogo(who: By) {
    return transaction(async (db) => {
      const gone = await db.query('DELETE FROM cms_assets WHERE key = $1', [LOGO]);
      if (!gone.rowCount) throw AppError.notFound('There is no logo to remove');
      await record(db, who, 'edp.cms.logo.delete', 'cms', LOGO);
    });
  },

  /* ------------------------------------------------------------------------------------------------ courses */

  courses: () => rows<CourseRow>(`${COURSE} ORDER BY display_order, lower(title), id`),

  createCourse(who: By, body: NewCourseBody) {
    return orConflict(COURSE_TITLE, () =>
      transaction(async (db) => {
        const row = await one<{ id: string }>(
          `INSERT INTO cms_courses (title, short_title, description, icon, tags, registration_open, display_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            body.title,
            body.short_title ?? null,
            body.description ?? '',
            body.icon ?? 'code',
            JSON.stringify(body.tags ?? []),
            body.registration_open ?? true,
            body.display_order ?? (await nextOrder(db, 'cms_courses')),
            body.is_active ?? true,
          ],
          db,
        );
        await record(db, who, 'edp.cms.course.create', 'cms_course', row!.id);
        return getCourse(db, row!.id);
      }),
    );
  },

  updateCourse(who: By, id: string, body: UpdateCourseBody) {
    return orConflict(COURSE_TITLE, () =>
      transaction(async (db) => {
        const before = await lockCourse(db, id);
        await db.query(
          `UPDATE cms_courses SET title = $2, short_title = $3, description = $4, icon = $5, tags = $6,
             registration_open = $7, display_order = $8, is_active = $9 WHERE id = $1`,
          [
            id,
            body.title ?? before.title,
            body.short_title === undefined ? before.short_title : body.short_title,
            body.description ?? before.description,
            body.icon ?? before.icon,
            JSON.stringify(body.tags ?? before.tags),
            body.registration_open ?? before.registration_open,
            body.display_order ?? before.display_order,
            body.is_active ?? before.is_active,
          ],
        );
        await record(db, who, 'edp.cms.course.update', 'cms_course', id, { fields: Object.keys(body) });
        return getCourse(db, id);
      }),
    );
  },

  removeCourse(who: By, id: string) {
    return transaction(async (db) => {
      await lockCourse(db, id);
      await db.query('UPDATE cms_courses SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.cms.course.delete', 'cms_course', id);
    });
  },

  /* ------------------------------------------------------------------------------------------------ FAQs */

  faqs: () => rows<FaqRow>(`${FAQ} ORDER BY display_order, id`),

  createFaq(who: By, body: NewFaqBody) {
    const kind = body.answer_kind ?? 'TEXT';
    assertAnswer(kind, body.answer ?? '');
    return orConflict(FAQ_QUESTION, () =>
      transaction(async (db) => {
        const row = await one<{ id: string }>(
          `INSERT INTO cms_faqs (question, answer, answer_kind, display_order, is_active)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            body.question,
            body.answer ?? '',
            kind,
            body.display_order ?? (await nextOrder(db, 'cms_faqs')),
            body.is_active ?? true,
          ],
          db,
        );
        await record(db, who, 'edp.cms.faq.create', 'cms_faq', row!.id);
        return getFaq(db, row!.id);
      }),
    );
  },

  updateFaq(who: By, id: string, body: UpdateFaqBody) {
    return orConflict(FAQ_QUESTION, () =>
      transaction(async (db) => {
        const before = await lockFaq(db, id);
        const kind = body.answer_kind ?? before.answer_kind;
        const answer = body.answer ?? before.answer;
        assertAnswer(kind, answer);
        await db.query(
          `UPDATE cms_faqs SET question = $2, answer = $3, answer_kind = $4, display_order = $5, is_active = $6 WHERE id = $1`,
          [
            id,
            body.question ?? before.question,
            answer,
            kind,
            body.display_order ?? before.display_order,
            body.is_active ?? before.is_active,
          ],
        );
        await record(db, who, 'edp.cms.faq.update', 'cms_faq', id, { fields: Object.keys(body) });
        return getFaq(db, id);
      }),
    );
  },

  removeFaq(who: By, id: string) {
    return transaction(async (db) => {
      await lockFaq(db, id);
      await db.query('UPDATE cms_faqs SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.cms.faq.delete', 'cms_faq', id);
    });
  },
};
