import crypto from 'node:crypto';
import { one, pool, rows, transaction, type Db } from '../db/pool';
import { aadhaarBlindIndex, encryptAadhaar } from '../lib/aadhaar';
import { MOBILE_RE, normaliseMobile } from '../lib/text';
import { aadhaarDigits, isAadhaar } from '../program/rules';
import { storage } from '../services/storage';
import { importMasters, type Maps } from './masters';
import type { Source } from './source';

/*
 * Copies the program's data of the earlier system into an empty program database: masters, panel users, settings, students,
 * forms (also those kept in the old student register), files, checks, approvals, edits, follow-ups and batches. Ids are kept;
 * Aadhaar numbers are encrypted again with this system's keys. Everything is one transaction: it is copied completely or not
 * at all (files already written are removed again). What cannot be copied is listed, never guessed. A dry run does the same
 * and takes everything back at the end.
 */
export interface Report {
  counts: Record<string, number>;
  warnings: string[];
}

class DryRun extends Error {}

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v));
const orNull = (v: unknown) => text(v) || null;
/* A date column as YYYY-MM-DD (pg gives it as text here, see db/pool.ts). */
const day = (v: unknown) => text(v).slice(0, 10);

const EXT: Record<string, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4' };
const folderOf = (code: string, data: Record<string, string>) =>
  `${code}_${data.first_name ?? ''}_${data.last_name ?? ''}`
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
const publicCode = (code: string) => code.replace(/^EDP-/, 'IPP-');

/* The values of a form kept in the old student register. */
function registerForm(s: Row): Record<string, string> {
  return {
    first_name: text(s.firstName),
    last_name: text(s.lastName),
    father_name: text(s.fatherName),
    mother_name: text(s.motherName),
    date_of_birth: day(s.dateOfBirth),
    current_address: text(s.currentAddress),
    mobile_number: text(s.mobile),
    religion: text(s.religion),
    caste_id: text(s.casteId),
    region_id: text(s.regionId),
    technology: text(s.trackCode),
    education_id: text(s.educationId),
    gender: text(s.gender),
    marital_status: text(s.maritalStatus),
    permanent_address: text(s.permanentAddress),
    landmark: text(s.landmark),
    district_id: text(s.districtId),
    taluka: text(s.talukaName),
    pin_code: text(s.pinCode),
    alternate_mobile_number: text(s.alternateMobile),
    alternate_email: text(s.alternateEmail),
    disability_status: s.disabilityStatus === null ? '' : s.disabilityStatus ? 'Yes' : 'No',
    disability_type: text(s.disabilityType),
    disability_certificate_number: text(s.disabilityCertificateNumber),
    centre_id: text(s.centreId),
    qualification_name: text(s.qualificationName),
    qualification_stream: text(s.qualificationStream),
    qualification_board: text(s.qualificationBoard),
    qualification_completed_on: day(s.qualificationCompletedOn),
    grading_type: text(s.gradingType),
    cgpa_scale: text(s.cgpaScale),
    score: s.score === null ? '' : String(Number(s.score)),
    qualification_class: text(s.qualificationClass),
  };
}

export async function importLegacy(src: Source, opts: { dryRun: boolean }): Promise<Report> {
  const report: Report = { counts: {}, warnings: [] };
  const count = (what: string, n = 1) => (report.counts[what] = (report.counts[what] ?? 0) + n);
  const warn = (message: string) => report.warnings.push(message);
  const written: string[] = [];
  try {
    await transaction(async (db) => {
      const used = await one<{ n: number }>(
        `SELECT (SELECT count(*) FROM student_accounts) + (SELECT count(*) FROM batches) AS n`,
        [],
        db,
      );
      if (used!.n > 0) throw new Error('The database already has students or batches: import into an empty one only.');
      const maps = await importMasters(src, db, count, warn);
      const people = await panelUsers(src, db, count);
      await settings(src, db, people, count);
      await accounts(src, db, count, warn);
      await batches(src, db, maps, people, count, warn);
      await applications(src, db, maps, people, count, warn, async (key, data) => {
        count('files');
        if (opts.dryRun) return;
        await storage.write(key, data);
        written.push(key);
      });
      await history(src, db, people, count);
      if (opts.dryRun) throw new DryRun();
      /* Sequences are not part of the transaction: set last, on success only. */
      await db.query(
        `SELECT setval('registration_seq', greatest(1, (SELECT coalesce(max(substring(registration_code FROM '^IPP-([0-9]+)$')::bigint), 0)
           FROM applications)), EXISTS (SELECT 1 FROM applications WHERE registration_code ~ '^IPP-[0-9]+$'))`,
      );
    });
  } catch (err) {
    for (const key of written) await storage.remove(key).catch(() => undefined);
    if (!(err instanceof DryRun)) throw err;
    await pool.query(`SELECT setval('batch_code_seq', 1, false)`);
  }
  return report;
}

/* Panel accounts keep their id and password; one whose e-mail is already here is that account. */
async function panelUsers(
  src: Source,
  db: Db,
  count: (w: string) => unknown,
): Promise<Map<string, { id: string; name: string }>> {
  const map = new Map<string, { id: string; name: string }>();
  const list = await src.rows<Row>(
    `SELECT id, name, email, "passwordHash", role, "isActive", "isDelete", "lastLoginAt", "createdAt" FROM edp_admins
     ORDER BY "isDelete", "createdAt"`,
  );
  for (const u of list) {
    const email = text(u.email).toLowerCase();
    const known = await one<{ id: string }>(`SELECT id FROM panel_users WHERE email = $1 AND deleted_at IS NULL`, [email], db);
    if (known && !u.isDelete) {
      map.set(text(u.id), { id: known.id, name: text(u.name) });
      continue;
    }
    await db.query(
      `INSERT INTO panel_users (id, name, email, password_hash, role, is_active, last_login_at, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)`,
      [u.id, u.name, email, u.passwordHash, u.role, u.isActive && !u.isDelete, u.lastLoginAt, u.createdAt, u.isDelete],
    );
    map.set(text(u.id), { id: text(u.id), name: text(u.name) });
    count('panel users');
  }
  return map;
}
type People = Awaited<ReturnType<typeof panelUsers>>;

async function settings(src: Source, db: Db, people: People, count: (w: string) => unknown): Promise<void> {
  for (const s of await src.rows<Row>(
    `SELECT key, value, "updatedAt", "updatedById" FROM edp_settings WHERE key IN ('batch', 'support', 'welcome', 'help')`,
  )) {
    await db.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [s.key, JSON.stringify(s.value), s.updatedAt, people.get(text(s.updatedById))?.id ?? null],
    );
    count('settings');
  }
}

/* Students keep their id and password, so they sign in as before. Pending OTPs and reset links are not copied. */
async function accounts(src: Source, db: Db, count: (w: string) => unknown, warn: (m: string) => unknown): Promise<void> {
  for (const a of await src.rows<Row>(
    `SELECT id, "firstName", "middleName", "lastName", email, mobile, "passwordHash", "emailVerifiedAt", "passwordChangedAt",
            "lastLoginAt", "isActive", "isDelete", "createdAt" FROM edp_accounts ORDER BY "createdAt"`,
  )) {
    const mobile = normaliseMobile(text(a.mobile));
    if (!MOBILE_RE.test(mobile)) {
      warn(`account ${text(a.id)}: its mobile number is not valid; left out`);
      continue;
    }
    await db.query(
      `INSERT INTO student_accounts (id, first_name, middle_name, last_name, email, mobile, password_hash, verified_at,
         password_changed_at, last_login_at, is_active, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13 THEN now() END)`,
      [
        a.id,
        text(a.firstName),
        orNull(a.middleName),
        text(a.lastName),
        text(a.email).toLowerCase(),
        mobile,
        a.passwordHash,
        a.emailVerifiedAt,
        a.passwordChangedAt,
        a.lastLoginAt,
        a.isActive,
        a.createdAt,
        a.isDelete,
      ],
    );
    count('students');
  }
}

const DISTRICT = `coalesce(nullif(p."data"->>'district_id', ''), s."districtId"::text)`;
const CENTRE = `coalesce(nullif(p."data"->>'centre_id', ''), s."centreId"::text)`;

/*
 * Batches keep their id; one without a district takes its students'. Students past the batch stage without one (approved
 * before batches came) are put into "Imported – <district>" batches, because here a student only moves on in a batch.
 */
async function batches(
  src: Source,
  db: Db,
  maps: Maps,
  people: People,
  count: (w: string) => unknown,
  warn: (m: string) => unknown,
): Promise<void> {
  for (const b of await src.rows<Row>(
    `SELECT b.*, (SELECT ${DISTRICT} FROM edp_applications p LEFT JOIN students s ON s.id = p."studentId"
                  WHERE p."batchId" = b.id LIMIT 1) AS "memberDistrict",
            (SELECT count(*)::int FROM edp_applications p WHERE p."batchId" = b.id AND NOT p."isDelete") AS members
     FROM edp_batches b WHERE NOT b."isDelete" ORDER BY b."createdAt"`,
  )) {
    const district = maps.district.get(text(b.districtId) || text(b.memberDistrict));
    const centre = maps.centre.get(text(b.centreId));
    if (!district || !centre) {
      warn(`batch ${text(b.id)}: without a known ${district ? 'center' : 'district'}; left out`);
      continue;
    }
    await db.query(
      `INSERT INTO batches (id, name, district_id, centre_id, size, created_by, updated_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        b.id,
        b.name,
        district,
        centre,
        Math.min(100, Math.max(1, Number(b.size ?? b.members) || 1)),
        people.get(text(b.createdByAdminId))?.id ?? null,
        people.get(text(b.updatedByAdminId))?.id ?? null,
        b.createdAt,
      ],
    );
    maps.batch.set(text(b.id), text(b.id));
    count('batches');
  }

  const loose = await src.rows<{ id: string; district: string | null; centre: string | null }>(
    `SELECT p.id, ${DISTRICT} AS district, ${CENTRE} AS centre FROM edp_applications p LEFT JOIN students s ON s.id = p."studentId"
     WHERE NOT p."isDelete" AND p."batchId" IS NULL AND p."approvalStage" IN ('DIVISION', 'COEP', 'HEAD_OFFICE', 'ADMIN', 'APPROVED')
     ORDER BY p."submittedAt", p.id`,
  );
  const groups = new Map<string, typeof loose>();
  for (const l of loose) {
    const district = maps.district.get(text(l.district));
    if (!district) warn(`form ${l.id}: past the batch stage, without a known district; left out`);
    else groups.set(district, [...(groups.get(district) ?? []), l]);
  }
  const [anyCentre] = await rows<{ id: string }>(`SELECT id FROM centres ORDER BY created_at, id LIMIT 1`, [], db);
  for (const [district, list] of groups)
    for (let i = 0; i < list.length; i += 100) {
      const part = list.slice(i, i + 100);
      const centre =
        part.map((l) => maps.centre.get(text(l.centre))).find(Boolean) ?? (await importCentre(db, district, anyCentre));
      const name = (await one<{ name: string }>(`SELECT name FROM districts WHERE id = $1`, [district], db))!.name;
      const row = await one<{ id: string }>(
        `INSERT INTO batches (name, district_id, centre_id, size) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`Imported – ${name}${i ? ` (${i / 100 + 1})` : ''}`, district, centre, part.length],
        db,
      );
      for (const l of part) maps.looseBatch.set(l.id, row!.id);
      count('batches made for students approved without one');
    }
}

/* A center for imported batches whose students have none that is known. */
async function importCentre(db: Db, district: string, any: { id: string } | undefined): Promise<string> {
  if (any) return any.id;
  const row = await one<{ id: string }>(
    `INSERT INTO centres (district_id, name, code, is_active) VALUES ($1, 'Not assigned', 'IMPORTED', false)
     ON CONFLICT (upper(code)) WHERE deleted_at IS NULL DO UPDATE SET name = centres.name RETURNING id`,
    [district],
    db,
  );
  return row!.id;
}

const inRegister = (p: Row) => p.status === 'SUBMITTED' && !!p.studentId && !p.registrationCode;

async function applications(
  src: Source,
  db: Db,
  maps: Maps,
  people: People,
  count: (w: string) => unknown,
  warn: (m: string) => unknown,
  write: (key: string, data: Buffer) => Promise<void>,
): Promise<void> {
  const students = new Set((await rows<{ id: string }>(`SELECT id FROM student_accounts`, [], db)).map((r) => r.id));
  for (const p of await src.rows<Row>(`SELECT p.* FROM edp_applications p WHERE NOT p."isDelete" ORDER BY p."createdAt", p.id`)) {
    const id = text(p.id);
    if (!students.has(text(p.accountId))) {
      warn(`form ${id}: its account was left out, so it is too`);
      continue;
    }
    const register = inRegister(p) ? (await src.rows<Row>(`SELECT * FROM students WHERE id = $1`, [p.studentId]))[0] : undefined;
    if (inRegister(p) && !register) {
      warn(`form ${id}: its record is no longer in the student register; left out`);
      continue;
    }
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries((p.data ?? {}) as Record<string, unknown>)) if (typeof v === 'string') form[k] = v;
    for (const [k, v] of Object.entries(register ? registerForm(register) : {})) if (v) form[k] = v;
    delete form.aadhaar_number;
    delete form.email;
    /* The ids a form stores, as they are here. */
    for (const key of ['district_id', 'centre_id', 'caste_id', 'region_id', 'education_id'] as const) {
      if (!form[key]) continue;
      const mapped = maps.reference(key, form[key]);
      if (mapped) form[key] = mapped;
      else {
        warn(`form ${id}: its ${key} is not known; left empty`);
        delete form[key];
      }
    }

    const enc = (register?.aadhaarEnc ?? p.aadhaarEnc) as Buffer | null;
    const aadhaar = enc ? aadhaarDigits(src.decryptAadhaar(enc)) : '';
    const submitted = p.status === 'SUBMITTED';
    if (submitted && !isAadhaar(aadhaar)) {
      warn(`form ${id}: submitted without a valid Aadhaar number; left out`);
      continue;
    }
    const code = submitted ? publicCode(text(register?.code) || text(p.registrationCode)) : null;
    const stage = submitted ? orNull(p.approvalStage) : null;
    const batch = stage === 'BATCH' ? null : (maps.batch.get(text(p.batchId)) ?? maps.looseBatch.get(id) ?? null);
    if (stage && stage !== 'BATCH' && !batch) {
      warn(`form ${id}: past the batch stage without a batch; left out`);
      continue;
    }
    await db.query(
      `INSERT INTO applications (id, account_id, status, current_step, data, aadhaar_enc, aadhaar_index, aadhaar_last4,
         basic_completed_at, main_completed_at, declared_at, submitted_at, registration_code, registration_number, student_active_at,
         approved_at, approved_by, approval_stage, stage_updated_at, batch_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        id,
        p.accountId,
        p.status,
        Math.min(3, Math.max(1, Number(p.currentStep) || 1)),
        JSON.stringify(form),
        aadhaar ? encryptAadhaar(aadhaar) : null,
        submitted ? aadhaarBlindIndex(aadhaar) : null,
        submitted ? aadhaar.slice(-4) : null,
        p.basicCompletedAt ?? (submitted ? p.submittedAt : null),
        p.mainCompletedAt ?? (submitted ? p.submittedAt : null),
        p.submittedAt,
        code,
        submitted ? (orNull(register?.registrationNumber) ?? orNull(p.registrationNumber)) : null,
        p.updatedAt,
        p.approvedAt,
        people.get(text(p.approvedByAdminId))?.id ?? null,
        stage,
        p.stageUpdatedAt,
        batch,
        p.createdAt,
      ],
    );
    count(submitted ? 'submitted forms' : 'drafts');
    await files(src, db, p, code, form, !!register, people, warn, write);
  }
}

/* The files of a form, with the Auditor's checks of them. */
async function files(
  src: Source,
  db: Db,
  p: Row,
  code: string | null,
  form: Record<string, string>,
  register: boolean,
  people: People,
  warn: (m: string) => unknown,
  write: (key: string, data: Buffer) => Promise<void>,
): Promise<void> {
  const list = await src.rows<Row>(
    register
      ? `SELECT DISTINCT ON ("docType") "docType", "storageKey", "originalName", "mimeType", "createdAt" FROM student_documents
         WHERE "studentId" = $1 AND NOT "isDelete" ORDER BY "docType", "createdAt" DESC`
      : `SELECT "docType", "storageKey", "originalName", "mimeType", "createdAt" FROM edp_application_files
         WHERE "applicationId" = $1 AND NOT "isDelete"`,
    [register ? p.studentId : p.id],
  );
  const checks = await src.rows<Row>(`SELECT * FROM edp_document_checks WHERE "applicationId" = $1`, [p.id]);
  for (const f of list) {
    const doc = text(f.docType);
    const known = await one(`SELECT 1 FROM program_documents WHERE code = $1`, [doc], db);
    const data = known ? await src.file(text(f.storageKey)) : null;
    if (!data?.length) {
      warn(
        `form ${text(p.id)}: the file of ${doc} ${known ? 'is not in the storage' : 'is not a document of the program'}; left out`,
      );
      continue;
    }
    const name = `${doc}${EXT[text(f.mimeType)] ?? ''}`;
    const key = code ? storage.candidateKey(folderOf(code, form), name) : storage.draftKey(text(p.id), name);
    await write(key, data);
    await db.query(
      `INSERT INTO application_files (application_id, document_code, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        p.id,
        doc,
        key,
        text(f.originalName).slice(0, 255) || name,
        f.mimeType,
        data.length,
        crypto.createHash('sha256').update(data).digest('hex'),
        f.createdAt,
      ],
    );
    const check = checks.find((c) => c.docType === doc);
    if (check)
      await db.query(
        `INSERT INTO document_checks (application_id, document_code, verified_at, verified_by) VALUES ($1, $2, $3, $4)`,
        [p.id, doc, check.verifiedAt, people.get(text(check.verifiedByAdminId))?.id ?? null],
      );
  }
  await db.query(
    `UPDATE applications p SET documents_verified_at = k.at, documents_verified_by = $2
     FROM (SELECT max(c.verified_at) AS at, count(*) AS files, count(c.document_code) AS checked
           FROM application_files f
           LEFT JOIN document_checks c ON c.application_id = f.application_id AND c.document_code = f.document_code
           WHERE f.application_id = $1) k
     WHERE p.id = $1 AND k.files > 0 AND k.checked = k.files`,
    [p.id, people.get(text(p.documentsVerifiedByAdminId))?.id ?? null],
  );
}

/* Approval events, the Auditor's edits and the follow-ups of the forms and students that were copied, in their order. */
async function history(src: Source, db: Db, people: People, count: (w: string) => unknown): Promise<void> {
  const forms = new Set((await rows<{ id: string }>(`SELECT id FROM applications`, [], db)).map((r) => r.id));
  const students = new Set((await rows<{ id: string }>(`SELECT id FROM student_accounts`, [], db)).map((r) => r.id));
  for (const e of await src.rows<Row>(
    `SELECT e.*, u.name AS "officer" FROM edp_approval_events e LEFT JOIN users u ON u.id = e."actorUserId" ORDER BY e."createdAt", e.id`,
  )) {
    if (!forms.has(text(e.applicationId))) continue;
    const by = people.get(text(e.edpAdminId));
    await db.query(
      `INSERT INTO approval_events (application_id, action, from_stage, to_stage, reason, actor_kind, panel_user_id, actor_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.applicationId,
        e.action,
        e.fromStage,
        e.toStage,
        e.reason ?? (e.action === 'REJECT' ? 'Not recorded' : null),
        by ? 'PANEL' : e.officer ? 'OFFICER' : 'SYSTEM',
        by?.id ?? null,
        by?.name ?? orNull(e.officer),
        e.createdAt,
      ],
    );
    count('approval events');
  }
  for (const e of await src.rows<Row>(`SELECT * FROM edp_application_edits ORDER BY "createdAt", id`)) {
    if (!forms.has(text(e.applicationId))) continue;
    const by = people.get(text(e.adminId));
    await db.query(
      `INSERT INTO application_edits (application_id, changes, panel_user_id, actor_name, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [e.applicationId, JSON.stringify(e.changes), by?.id ?? null, by?.name ?? null, e.createdAt],
    );
    count('edits');
  }
  for (const f of await src.rows<Row>(`SELECT * FROM edp_follow_ups WHERE NOT "isDelete" ORDER BY "createdAt", id`)) {
    if (!students.has(text(f.accountId))) continue;
    await db.query(`INSERT INTO follow_ups (account_id, status, note, panel_user_id, created_at) VALUES ($1, $2, $3, $4, $5)`, [
      f.accountId,
      f.status,
      orNull(f.note),
      people.get(text(f.adminId))?.id ?? null,
      f.createdAt,
    ]);
    count('follow-ups');
  }
}
