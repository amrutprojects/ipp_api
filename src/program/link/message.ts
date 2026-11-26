import { one, rows, type Db } from '../../db/pool';
import { maskAadhaar } from '../../lib/aadhaar';
import type { DeliveryMode, DocumentKind, FieldType, Form, Step } from '../constants';
import { documentChecks, documentList, storedFiles } from '../document-checks';
import { applies, referenceNames, storedForm, viewFields } from '../form';
import { loadProgram, type Program } from '../masters';
import type { OutboxRow } from './outbox';

/*
 * What a message to Sarthi says (docs/SARTHI_LINK.md, section 2): the batch in full and the students concerned, as they are
 * when it is sent. The Aadhaar number is never in it, only its last four digits.
 */
export interface LinkMessage {
  id: string;
  seq: number;
  sent_at: Date;
  batch: {
    id: string;
    code: string;
    name: string;
    size: number;
    district: { code: string; name: string; state_code: string };
    centre: { code: string; name: string };
    start_date: string | null;
    end_date: string | null;
    delivery_mode: DeliveryMode;
    technology: { code: string; name: string } | null;
    created_at: Date;
    created_by: string | null;
  };
  applications: LinkApplication[];
}

export interface LinkApplication {
  action: 'SUBMIT' | 'RESUBMIT' | 'UPDATE';
  id: string;
  registration_id: string;
  registration_number: string | null;
  name: string;
  email: string;
  mobile_number: string;
  aadhaar_masked: string | null;
  district: string | null;
  category: string | null;
  centre: string | null;
  technology: string | null;
  submitted_at: Date;
  auditor_approved_at: Date | null;
  auditor_approved_by: string | null;
  /* Why the Auditor approved it (the latest approval); null for one approved before reasons were asked. */
  auditor_approval_reason: string | null;
  fields: { key: string; step: Step; label_en: string; label_mr: string; type: FieldType; text: string }[];
  documents: {
    code: string;
    name: string;
    name_mr: string | null;
    required: boolean;
    kind: DocumentKind;
    file: { name: string; mime: string; size: number; uploaded_at: Date } | null;
    verified: boolean;
    verified_at: Date | null;
    verified_by: string | null;
  }[];
  edits: { at: Date; by: string | null; changes: { key: string; label: string; from: string; to: string }[] }[];
}

/* The Auditor's corrections that are sent. */
const EDITS = 50;

interface BatchData {
  id: string;
  code: string;
  name: string;
  size: number;
  start_date: string | null;
  end_date: string | null;
  delivery_mode: DeliveryMode;
  created_at: Date;
  created_by: string | null;
  district_code: string;
  district_name: string;
  state_code: string;
  centre_code: string;
  centre_name: string;
  technology_code: string | null;
  technology_name: string | null;
}

async function batchOf(db: Db, id: string): Promise<LinkMessage['batch'] | null> {
  const b = await one<BatchData>(
    `SELECT b.id, b.code, b.name, b.size, b.start_date, b.end_date, b.delivery_mode, b.created_at, cu.name AS created_by,
            d.code AS district_code, d.name AS district_name, s.code AS state_code, c.code AS centre_code, c.name AS centre_name,
            t.code AS technology_code, t.name_en AS technology_name
     FROM batches b JOIN districts d ON d.id = b.district_id JOIN states s ON s.id = d.state_id JOIN centres c ON c.id = b.centre_id
     LEFT JOIN program_options t ON t.id = b.technology_id LEFT JOIN panel_users cu ON cu.id = b.created_by
     WHERE b.id = $1 AND b.deleted_at IS NULL`,
    [id],
    db,
  );
  if (!b) return null;
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    size: b.size,
    district: { code: b.district_code, name: b.district_name, state_code: b.state_code },
    centre: { code: b.centre_code, name: b.centre_name },
    start_date: b.start_date,
    end_date: b.end_date,
    delivery_mode: b.delivery_mode,
    technology: b.technology_code ? { code: b.technology_code, name: b.technology_name! } : null,
    created_at: b.created_at,
    created_by: b.created_by,
  };
}

interface ApplicationData {
  id: string;
  data: Record<string, unknown>;
  aadhaar_last4: string | null;
  registration_code: string;
  registration_number: string | null;
  submitted_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  approval_reason: string | null;
  full_name: string;
  email: string;
  mobile: string;
}

/* A score as people read it: "72.5%", "8.2 / 10". */
function scoreText(text: string, form: Form): string {
  if (!/^\d+(\.\d+)?$/.test(text)) return text;
  if (form.grading_type === 'PERCENTAGE') return `${text}%`;
  return form.grading_type === 'CGPA' && form.cgpa_scale ? `${text} / ${form.cgpa_scale}` : text;
}

async function applicationOf(
  db: Db,
  program: Program,
  p: ApplicationData,
  action: LinkApplication['action'],
): Promise<LinkApplication> {
  const form = storedForm(program, p.data);
  if (program.field('email')?.isActive) form.email ||= p.email;
  const masked = maskAadhaar(p.aadhaar_last4);
  const names = await referenceNames(program, form, db);
  const files = await storedFiles(program, p.id, db);
  const check = await documentChecks(p.id, db);
  const edits = await rows<LinkApplication['edits'][number]>(
    `SELECT e.created_at AS at, coalesce(e.actor_name, u.name) AS by, e.changes
     FROM application_edits e LEFT JOIN panel_users u ON u.id = e.panel_user_id
     WHERE e.application_id = $1 ORDER BY e.seq DESC LIMIT ${EDITS}`,
    [p.id],
    db,
  );
  return {
    action,
    id: p.id,
    registration_id: p.registration_code,
    registration_number: p.registration_number,
    name: p.full_name,
    email: p.email,
    mobile_number: p.mobile,
    aadhaar_masked: masked,
    district: names.district,
    category: names.caste,
    centre: names.centre,
    technology: names.technology,
    submitted_at: p.submitted_at,
    auditor_approved_at: p.approved_at,
    auditor_approved_by: p.approved_by,
    auditor_approval_reason: p.approved_at ? p.approval_reason : null,
    fields: viewFields(program, form, names, masked)
      .filter((f) => applies(f.key, (key) => form[key] ?? ''))
      .map(({ key, step, label_en, label_mr, type, text }) => ({
        key,
        step,
        label_en,
        label_mr,
        type,
        text: key === 'score' ? scoreText(text, form) : text,
      })),
    documents: documentList(program, files, check).map((d) => ({
      code: d.code,
      name: d.name,
      name_mr: d.name_mr,
      required: d.required,
      kind: d.kind,
      file: d.file && {
        name: d.file.original_name,
        mime: d.file.mime_type,
        size: d.file.size_bytes,
        uploaded_at: d.file.uploaded_at,
      },
      verified: d.verified.verified,
      verified_at: d.verified.at,
      verified_by: d.verified.by,
    })),
    edits,
  };
}

/*
 * The students a message is of. A new batch: those with the Divisional Officer (one who was sent back meanwhile follows with
 * a message of its own).
 */
async function applicationsOf(db: Db, m: OutboxRow): Promise<LinkApplication[]> {
  if (m.kind === 'BATCH_UPDATE') return [];
  const which = m.kind === 'BATCH' ? `p.batch_id = $1 AND p.approval_stage = 'DIVISION'` : `p.id = $1`;
  const list = await rows<ApplicationData>(
    `SELECT p.id, p.data, p.aadhaar_last4, p.registration_code, p.registration_number, p.submitted_at, p.approved_at,
            u.name AS approved_by, a.full_name, a.email, a.mobile,
            (SELECT e.reason FROM approval_events e
             WHERE e.application_id = p.id AND e.action = 'APPROVE' AND e.from_stage = 'AUDITOR'
             ORDER BY e.seq DESC LIMIT 1) AS approval_reason
     FROM applications p JOIN student_accounts a ON a.id = p.account_id LEFT JOIN panel_users u ON u.id = p.approved_by
     WHERE ${which} AND p.status = 'SUBMITTED' AND p.deleted_at IS NULL AND a.deleted_at IS NULL ORDER BY p.registration_code`,
    [m.kind === 'BATCH' ? m.batch_id : m.application_id],
    db,
  );
  if (!list.length) return [];
  const program = await loadProgram(db);
  const action = m.kind === 'BATCH' ? 'SUBMIT' : m.kind;
  const out: LinkApplication[] = [];
  for (const p of list) out.push(await applicationOf(db, program, p, action));
  return out;
}

/* null = there is nothing to say any more (the batch was deleted). */
export async function buildMessage(db: Db, m: OutboxRow, now: Date): Promise<LinkMessage | null> {
  const batch = await batchOf(db, m.batch_id);
  return batch && { id: m.id, seq: m.seq, sent_at: now, batch, applications: await applicationsOf(db, m) };
}
