import { one, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { ORDER_MAX, type DocumentKind } from '../../program/constants';
import { lock, orConflict, record, type By } from './common.service';
import type { NewDocumentBody, UpdateDocumentBody } from './documents.schemas';

/*
 * The documents of step 3 can be renamed, made optional, switched off or deleted; documents an ADMIN adds
 * have codes IPP_DOC_<n>. One switched off or deleted is no longer asked for; a file already uploaded
 * for it stays with its form and is still shown.
 */
const PREFIX = 'IPP_DOC_';
const duplicates = (name: string) => ({ uq_program_documents_name: `A document named "${name}" already exists.` });

interface DocumentRow {
  id: string;
  code: string;
  name_en: string;
  name_mr: string | null;
  required: boolean;
  is_active: boolean;
  is_system: boolean;
  kind: DocumentKind;
  order: number;
  in_use: boolean;
}

const SELECT = `SELECT d.id, d.code, d.name_en, d.name_mr, d.required, d.is_active, d.is_system, d.kind, d.display_order AS "order",
    d.code IN (SELECT f.document_code FROM application_files f) AS in_use
  FROM program_documents d WHERE d.deleted_at IS NULL`;

async function getDocument(db: Db, id: string): Promise<DocumentRow> {
  const row = await one<DocumentRow>(`${SELECT} AND d.id = $1`, [id], db);
  if (!row) throw AppError.notFound('Document not found');
  return row;
}

const lockDocuments = (db: Db) => lock(db, 'program-documents');

export const documentsService = {
  list: () => rows<DocumentRow>(`${SELECT} ORDER BY d.display_order, d.created_at, d.code`),

  create(who: By, body: NewDocumentBody) {
    return orConflict(duplicates(body.name_en), () =>
      transaction(async (db) => {
        await lockDocuments(db);
        /* A deleted one's number is never given again: files are stored under the code. */
        const next = await one<{ n: number }>(
          `SELECT coalesce(max(substr(code, $1)::int), 0) + 1 AS n FROM program_documents WHERE code ~ $2`,
          [PREFIX.length + 1, `^${PREFIX}[0-9]{1,6}$`],
          db,
        );
        const code = `${PREFIX}${next!.n}`;
        const row = await one<{ id: string }>(
          `INSERT INTO program_documents (code, name_en, name_mr, required, is_active, kind, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, coalesce($7,
             (SELECT least(coalesce(max(display_order), 0) + 10, ${ORDER_MAX}) FROM program_documents WHERE deleted_at IS NULL)))
           RETURNING id`,
          [
            code,
            body.name_en,
            body.name_mr ?? null,
            body.required ?? true,
            body.is_active ?? true,
            body.kind ?? 'DOCUMENT',
            body.order ?? null,
          ],
          db,
        );
        await record(db, who, 'edp.document.create', 'program_documents', row!.id, { code });
        return getDocument(db, row!.id);
      }),
    );
  },

  update(who: By, id: string, body: UpdateDocumentBody) {
    return orConflict(duplicates(body.name_en ?? ''), () =>
      transaction(async (db) => {
        await lockDocuments(db);
        const before = await getDocument(db, id);
        await db.query(
          `UPDATE program_documents SET name_en = $2, name_mr = $3, required = $4, is_active = $5, display_order = $6 WHERE id = $1`,
          [
            id,
            body.name_en ?? before.name_en,
            body.name_mr === undefined ? before.name_mr : body.name_mr,
            body.required ?? before.required,
            body.is_active ?? before.is_active,
            body.order ?? before.order,
          ],
        );
        await record(db, who, 'edp.document.update', 'program_documents', id, { code: before.code, fields: Object.keys(body) });
        return getDocument(db, id);
      }),
    );
  },

  /* Keep the master row and its code so uploaded files remain accessible. */
  remove(who: By, id: string) {
    return transaction(async (db) => {
      await lockDocuments(db);
      const document = await getDocument(db, id);
      await db.query('UPDATE program_documents SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await record(db, who, 'edp.document.delete', 'program_documents', id, { code: document.code, in_use: document.in_use });
    });
  },
};
