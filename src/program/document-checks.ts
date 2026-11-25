import { one, pool, rows, type Db } from '../db/pool';
import type { Program } from './masters';

/*
 * The Auditor's check of each uploaded document. "Documents verified" on the form (applications.documents_verified_at)
 * follows the checks: set once every uploaded document is verified, cleared otherwise.
 */

/* dc.uploaded / dc.verified: how many documents of application `p` are uploaded, and how many of them are verified. */
export const DOCUMENT_COUNTS = `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS uploaded, count(k.document_code)::int AS verified
    FROM application_files f
    LEFT JOIN document_checks k ON k.application_id = f.application_id AND k.document_code = f.document_code
    WHERE f.application_id = p.id
  ) dc ON true`;

export interface DocumentCounts {
  uploaded: number;
  verified: number;
}
export const allVerified = (c: DocumentCounts) => c.uploaded > 0 && c.verified === c.uploaded;
/* Why a form cannot be approved yet. */
export const notVerifiedMessage = (c: DocumentCounts) =>
  c.uploaded
    ? `Verify every document first (${c.verified} of ${c.uploaded} verified).`
    : 'No document has been uploaded for this form, so it cannot be approved.';

export async function documentCounts(applicationId: string, db: Db = pool): Promise<DocumentCounts> {
  return (
    (await one<DocumentCounts>(
      `SELECT dc.uploaded, dc.verified FROM applications p${DOCUMENT_COUNTS} WHERE p.id = $1`,
      [applicationId],
      db,
    )) ?? { uploaded: 0, verified: 0 }
  );
}

/* Brings the form's mark in step with the checks (the application row must be locked); returns the counts. */
export async function syncDocumentsVerified(db: Db, applicationId: string, panelUserId: string | null): Promise<DocumentCounts> {
  const counts = await documentCounts(applicationId, db);
  if (allVerified(counts))
    await db.query(
      `UPDATE applications SET documents_verified_at = now(), documents_verified_by = $2
       WHERE id = $1 AND documents_verified_at IS NULL`,
      [applicationId, panelUserId],
    );
  else
    await db.query(
      `UPDATE applications SET documents_verified_at = NULL, documents_verified_by = NULL
       WHERE id = $1 AND documents_verified_at IS NOT NULL`,
      [applicationId],
    );
  return counts;
}

export interface DocumentCheck {
  verified: boolean;
  at: Date | null;
  by: string | null;
}
const UNCHECKED: DocumentCheck = { verified: false, at: null, by: null };

/* The checks of one application, by document code. */
export async function documentChecks(applicationId: string, db: Db = pool): Promise<(code: string) => DocumentCheck> {
  const list = await rows<{ document_code: string; verified_at: Date; by: string | null }>(
    `SELECT k.document_code, k.verified_at, u.name AS by FROM document_checks k
     LEFT JOIN panel_users u ON u.id = k.verified_by WHERE k.application_id = $1`,
    [applicationId],
    db,
  );
  const byCode = new Map(list.map((r) => [r.document_code, { verified: true, at: r.verified_at, by: r.by }]));
  return (code) => byCode.get(code) ?? UNCHECKED;
}

/* A stored file as the portal shows it. */
export interface StoredFile {
  doc_type: string;
  name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
}

export async function storedFiles(program: Program, applicationId: string, db: Db = pool): Promise<StoredFile[]> {
  const list = await rows<Omit<StoredFile, 'name'>>(
    `SELECT document_code AS doc_type, original_name, mime_type, size_bytes, uploaded_at FROM application_files WHERE application_id = $1`,
    [applicationId],
    db,
  );
  const order = program.documentOrder();
  return list
    .map((f) => ({ ...f, name: program.documentName(f.doc_type) }))
    .sort((a, b) => (order.get(a.doc_type) ?? 999) - (order.get(b.doc_type) ?? 999));
}

/* The documents as every login shows them: the ones asked for now, in order, and any other one with a file. */
export function documentList<F extends { doc_type: string }>(
  program: Program,
  files: F[],
  check: (code: string) => DocumentCheck,
) {
  const order = program.documentOrder();
  const codes = new Set([...program.documents().map((d) => d.code), ...files.map((f) => f.doc_type)]);
  return [...codes]
    .flatMap((c) => program.document(c) ?? [])
    .sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0))
    .map((d) => {
      const file = files.find((f) => f.doc_type === d.code) ?? null;
      return {
        code: d.code,
        name: d.nameEn,
        name_mr: d.nameMr,
        required: d.required,
        kind: d.kind,
        file,
        verified: file ? check(d.code) : UNCHECKED,
      };
    });
}
