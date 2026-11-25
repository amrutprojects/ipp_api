import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { one, pool, rows } from '../../src/db/pool';
import { importLegacy, type Report } from '../../src/import/legacy';
import { openSource, type Source } from '../../src/import/source';
import { aadhaarBlindIndex, decryptAadhaar } from '../../src/lib/aadhaar';
import { passwordMatches, hashPassword } from '../../src/lib/passwords';
import { loadProgram } from '../../src/program/masters';
import { storage } from '../../src/services/storage';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { FILES, newAadhaar, optionId, districtId } from '../helpers/factory';

/* The earlier system's tables (as far as they are read), in a schema of their own in the test database. */
const BASE = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(), "isDelete" boolean NOT NULL DEFAULT false, "isActive" boolean NOT NULL DEFAULT true`;
const TABLES = `
  DROP SCHEMA IF EXISTS legacy_test CASCADE; CREATE SCHEMA legacy_test; SET LOCAL search_path TO legacy_test;
  CREATE TABLE states (${BASE}, name text, code text);
  CREATE TABLE districts (${BASE}, "stateId" uuid, name text, code text);
  CREATE TABLE talukas (${BASE}, "districtId" uuid, name text, code text);
  CREATE TABLE edp_centres (${BASE}, name text, code text, "districtId" uuid, "talukaId" uuid, address text, "pinCode" text,
    "contactPerson" text, "contactNumber" text, email text);
  CREATE TABLE castes (${BASE}, code text, name text); CREATE TABLE educations (${BASE}, code text, name text);
  CREATE TABLE regions (${BASE}, code text, name text);
  CREATE TABLE program_options (${BASE}, kind text, code text, "nameEn" text, "nameMr" text, "displayOrder" int, "isSystem" boolean, "masterId" uuid);
  CREATE TABLE program_district_technologies ("districtId" uuid, "optionId" uuid);
  CREATE TABLE program_documents (${BASE}, code text, "nameEn" text, "nameMr" text, required boolean, "displayOrder" int, "isSystem" boolean, kind text);
  CREATE TABLE program_fields (${BASE}, key text, step int, "labelEn" text, "labelMr" text, required boolean, "displayOrder" int,
    "isCore" boolean, "isCustom" boolean, type text, "helpEn" text, "helpMr" text);
  CREATE TABLE edp_admins (${BASE}, name text, email text, "passwordHash" text, "lastLoginAt" timestamptz, role text);
  CREATE TABLE users (${BASE}, name text);
  CREATE TABLE edp_settings (key text PRIMARY KEY, value jsonb, "updatedAt" timestamptz DEFAULT now(), "updatedById" uuid);
  CREATE TABLE edp_accounts (${BASE}, "firstName" text, "middleName" text, "lastName" text, email text, mobile text, "passwordHash" text,
    "emailVerifiedAt" timestamptz, "passwordChangedAt" timestamptz, "lastLoginAt" timestamptz);
  CREATE TABLE edp_batches (${BASE}, name text, "centreId" uuid, "createdByAdminId" uuid, "updatedByAdminId" uuid, size int, "districtId" uuid);
  CREATE TABLE edp_applications (${BASE}, "accountId" uuid, status text, "currentStep" int, data jsonb, "aadhaarEnc" bytea,
    "basicCompletedAt" timestamptz, "mainCompletedAt" timestamptz, "studentId" uuid, "submittedAt" timestamptz, "registrationCode" text,
    "registrationNumber" text, "approvedAt" timestamptz, "approvedByAdminId" uuid, "approvalStage" text, "stageUpdatedAt" timestamptz,
    "batchId" uuid, "documentsVerifiedByAdminId" uuid);
  CREATE TABLE edp_application_files (${BASE}, "applicationId" uuid, "docType" text, "storageKey" text, "originalName" text, "mimeType" text);
  CREATE TABLE edp_document_checks ("applicationId" uuid, "docType" text, "verifiedAt" timestamptz, "verifiedByAdminId" uuid);
  CREATE TABLE edp_application_edits (id uuid DEFAULT gen_random_uuid(), "createdAt" timestamptz DEFAULT now(), "applicationId" uuid,
    "adminId" uuid, changes jsonb);
  CREATE TABLE edp_approval_events (id uuid DEFAULT gen_random_uuid(), "applicationId" uuid, action text, "fromStage" text, "toStage" text,
    reason text, "actorUserId" uuid, "edpAdminId" uuid, "createdAt" timestamptz);
  CREATE TABLE edp_follow_ups (${BASE}, "accountId" uuid, status text, note text, "adminId" uuid);
  CREATE TABLE students (${BASE}, code text, "firstName" text, "lastName" text, "fatherName" text, "motherName" text, email text,
    "dateOfBirth" date, "currentAddress" text, "aadhaarEnc" bytea, mobile text, religion text, "trackCode" text, "regionId" uuid,
    "casteId" uuid, "educationId" uuid, "registrationNumber" text, gender text, "maritalStatus" text, "permanentAddress" text,
    landmark text, "districtId" uuid, "pinCode" text, "alternateMobile" text, "alternateEmail" text, "disabilityStatus" boolean,
    "disabilityType" text, "disabilityCertificateNumber" text, "centreId" uuid, "qualificationName" text, "qualificationStream" text,
    "qualificationBoard" text, "qualificationCompletedOn" date, "gradingType" text, "cgpaScale" int, score numeric,
    "qualificationClass" text, "talukaName" text);
  CREATE TABLE student_documents (${BASE}, "studentId" uuid, "docType" text, "storageKey" text, "originalName" text, "mimeType" text);
`;

const KEY = crypto.randomBytes(32);
const encrypt = (digits: string) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(digits, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipp-legacy-'));
const put = (key: string, data: Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
  fs.writeFileSync(path.join(dir, key), data);
};
const open = (): Promise<Source> =>
  openSource({
    LEGACY_DB_HOST: env.DB_HOST,
    LEGACY_DB_PORT: String(env.DB_PORT),
    LEGACY_DB_USER: env.DB_USER,
    LEGACY_DB_PASSWORD: env.DB_PASSWORD,
    LEGACY_DB_NAME: env.DB_NAME,
    LEGACY_DB_SCHEMA: 'legacy_test',
    LEGACY_DATA_KEY: KEY.toString('base64'),
    LEGACY_STORAGE_DIR: dir,
  });

const id = () => crypto.randomUUID();
const ids = {
  state: id(),
  nas: id(),
  pun: id(),
  taluka: id(),
  centre: id(),
  caste: id(),
  oldCaste: id(),
  region: id(),
  education: id(),
  admin: id(),
  officer: id(),
  a: [id(), id(), id(), id(), id()],
  p: [id(), id(), id(), id()],
  student: id(),
  batch: id(),
};
const aadhaar = [newAadhaar(), newAadhaar(), newAadhaar(), newAadhaar()];

async function legacyData(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(TABLES);
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    await q(`INSERT INTO states (id, name, code) VALUES ($1, 'Maharashtra', 'MH')`, [ids.state]);
    await q(`INSERT INTO districts (id, "stateId", name, code) VALUES ($1, $3, 'Nashik', 'NAS'), ($2, $3, 'Pune', 'PUN')`, [
      ids.nas,
      ids.pun,
      ids.state,
    ]);
    await q(`INSERT INTO talukas (id, "districtId", name) VALUES ($1, $2, 'Sinnar')`, [ids.taluka, ids.nas]);
    await q(`INSERT INTO edp_centres (id, name, code, "districtId", "talukaId") VALUES ($1, 'Old Center', 'OLD1', $2, $3)`, [
      ids.centre,
      ids.nas,
      ids.taluka,
    ]);
    await q(`INSERT INTO castes (id, code, name) VALUES ($1, 'SAR01', 'मराठा'), ($2, 'XYZ', 'जुनी जात')`, [
      ids.caste,
      ids.oldCaste,
    ]);
    await q(`INSERT INTO educations (id, code, name) VALUES ($1, 'BCA', 'BCA')`, [ids.education]);
    await q(`INSERT INTO regions (id, code, name) VALUES ($1, 'NAS', 'Nashik')`, [ids.region]);
    /* The Auditor renamed a caste, switched a choice off and added a technology. */
    await q(
      `INSERT INTO program_options (kind, code, "nameEn", "nameMr", "displayOrder", "isActive", "masterId") VALUES
        ('CASTE', 'SAR01', 'Maratha (renamed)', 'मराठा', 10, true, $1), ('EDUCATION', 'BCA', 'BCA', NULL, 60, true, $2),
        ('REGION', 'NAS', 'Nashik', NULL, 230, true, $3), ('GENDER', 'Transgender', 'Transgender', 'तृतीयपंथी', 30, false, NULL),
        ('TECHNOLOGY', 'T13', 'Robotics', NULL, 130, true, NULL)`,
      [ids.caste, ids.education, ids.region],
    );
    await q(`INSERT INTO program_district_technologies SELECT $1, id FROM program_options WHERE code = 'T13'`, [ids.nas]);
    await q(
      `INSERT INTO program_documents (code, "nameEn", required, "displayOrder", kind, "isActive") VALUES
        ('PHOTO', 'Photograph', true, 10, 'DOCUMENT', true), ('IPP_DOC_1', 'Bonafide', false, 200, 'DOCUMENT', true)`,
    );
    await q(
      `INSERT INTO program_fields (key, step, "labelEn", required, "displayOrder", "isCustom", "isCore", type) VALUES
        ('landmark', 1, 'Nearest landmark', true, 90, false, false, 'TEXT'), ('x_hobby', 2, 'Hobby', false, 300, true, false, 'TEXT')`,
    );
    await q(
      `INSERT INTO edp_admins (id, name, email, "passwordHash", role) VALUES ($1, 'Old Auditor', 'old@example.test', $2, 'ADMIN')`,
      [ids.admin, await hashPassword('Auditor123')],
    );
    await q(`INSERT INTO users (id, name) VALUES ($1, 'Old Officer')`, [ids.officer]);
    await q(`INSERT INTO edp_settings (key, value, "updatedById") VALUES ('batch', '{"size": 2}', $1)`, [ids.admin]);
    for (const [i, a] of ids.a.entries())
      await q(
        `INSERT INTO edp_accounts (id, "firstName", "lastName", email, mobile, "passwordHash", "emailVerifiedAt", "createdAt")
         VALUES ($1, 'First', 'Last', $2, $3, $4, now(), now() - interval '1 day')`,
        [a, `Legacy${i}@Example.test`, i === 4 ? '12345' : `+91 98765 4321${i}`, await hashPassword('Legacy123')],
      );
    await q(
      `INSERT INTO edp_batches (id, name, "centreId", "createdByAdminId", size, "districtId") VALUES ($1, 'Batch One', $2, $3, 1, $4)`,
      [ids.batch, ids.centre, ids.admin, ids.nas],
    );
    const data = {
      first_name: 'Asha',
      last_name: 'Legacy',
      district_id: ids.nas,
      centre_id: ids.centre,
      caste_id: ids.caste,
      region_id: ids.region,
      education_id: ids.education,
      technology: 'T13',
      x_hobby: 'Chess',
    };
    const application = (n: number, over: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        id: ids.p[n],
        accountId: ids.a[n],
        status: 'SUBMITTED',
        currentStep: 3,
        data: JSON.stringify(data),
        aadhaarEnc: encrypt(aadhaar[n]!),
        basicCompletedAt: new Date(),
        mainCompletedAt: new Date(),
        submittedAt: new Date(),
        ...over,
      };
      const keys = Object.keys(row);
      return q(
        `INSERT INTO edp_applications (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    /* 0: in a batch, with the Divisional Officer; one file, verified. */
    await application(0, {
      registrationCode: 'EDP-000041',
      registrationNumber: '1125101010123456',
      approvalStage: 'DIVISION',
      batchId: ids.batch,
      approvedByAdminId: ids.admin,
      documentsVerifiedByAdminId: ids.admin,
    });
    put('edp/x/PHOTO.png', FILES.png);
    await q(
      `INSERT INTO edp_application_files ("applicationId", "docType", "storageKey", "originalName", "mimeType") VALUES
        ($1, 'PHOTO', 'edp/x/PHOTO.png', 'me.png', 'image/png')`,
      [ids.p[0]],
    );
    await q(`INSERT INTO edp_document_checks VALUES ($1, 'PHOTO', now(), $2)`, [ids.p[0], ids.admin]);
    await q(
      `INSERT INTO edp_approval_events ("applicationId", action, "fromStage", "toStage", reason, "actorUserId", "edpAdminId", "createdAt") VALUES
        ($1, 'APPROVE', 'AUDITOR', 'BATCH', NULL, NULL, $2, now() - interval '3 hours'),
        ($1, 'APPROVE', 'BATCH', 'DIVISION', NULL, NULL, $2, now() - interval '2 hours'),
        ($1, 'APPROVE', 'DIVISION', 'COEP', NULL, $3, NULL, now() - interval '1 hour')`,
      [ids.p[0], ids.admin, ids.officer],
    );
    await q(`INSERT INTO edp_application_edits ("applicationId", "adminId", changes) VALUES ($1, $2, '[{"key":"landmark"}]')`, [
      ids.p[0],
      ids.admin,
    ]);
    await q(`INSERT INTO edp_follow_ups ("accountId", status, note, "adminId") VALUES ($1, 'CALLED', 'Called', $2)`, [
      ids.a[0],
      ids.admin,
    ]);
    /* 1: in the old student register, finally approved without a batch; its document is in the register too. */
    await q(
      `INSERT INTO students (id, code, "firstName", "lastName", "fatherName", "motherName", "dateOfBirth", "aadhaarEnc", mobile, "casteId",
         "regionId", "educationId", "districtId", "trackCode", "registrationNumber", "disabilityStatus", score, "cgpaScale")
       VALUES ($1, 'REG-000007', 'Register', 'Student', 'F', 'M', '2001-02-03', $2, '9876500001', $3, $4, $5, $6, 'T01', '1124101010123456', false, 71.50, 10)`,
      [ids.student, encrypt(aadhaar[1]!), ids.oldCaste, ids.region, ids.education, ids.pun],
    );
    put('students/REG-000007/PHOTO.jpg', FILES.jpg);
    await q(
      `INSERT INTO student_documents ("studentId", "docType", "storageKey", "originalName", "mimeType") VALUES
        ($1, 'PHOTO', 'students/REG-000007/PHOTO.jpg', 'p.jpg', 'image/jpeg'), ($1, 'FITNESS', 'students/REG-000007/F.pdf', 'f.pdf', 'application/pdf')`,
      [ids.student],
    );
    await application(1, { data: '{}', aadhaarEnc: null, studentId: ids.student, approvalStage: 'APPROVED' });
    /* 2: a draft with a file. */
    await application(2, { status: 'DRAFT', currentStep: 2, submittedAt: null, mainCompletedAt: null });
    put('applications/d/PHOTO.pdf', FILES.pdf);
    await q(
      `INSERT INTO edp_application_files ("applicationId", "docType", "storageKey", "originalName", "mimeType") VALUES
        ($1, 'PHOTO', 'applications/d/PHOTO.pdf', 'p.pdf', 'application/pdf'), ($1, 'IPP_DOC_1', 'applications/d/none.pdf', 'n.pdf', 'application/pdf')`,
      [ids.p[2]],
    );
    /* 3: submitted, its Aadhaar number is missing. */
    await application(3, { registrationCode: 'IPP-000043', registrationNumber: '1125101010123499', aadhaarEnc: null });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function run(dryRun: boolean): Promise<Report> {
  const source = await open();
  try {
    return await importLegacy(source, { dryRun });
  } finally {
    await source.close();
  }
}

beforeAll(async () => {
  await resetDatabase();
  await legacyData();
});
afterAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS legacy_test CASCADE');
  fs.rmSync(dir, { recursive: true, force: true });
  await closeDatabase();
});

describe('import of the earlier system', () => {
  it('a dry run shows what would be copied and keeps nothing', async () => {
    const { counts } = await run(true);
    expect(counts).toMatchObject({ students: 4, 'submitted forms': 2, drafts: 1, files: 3 });
    expect((await one<{ n: number }>(`SELECT count(*) AS n FROM student_accounts`))!.n).toBe(0);
    expect(await one(`SELECT 1 FROM program_options WHERE code = 'T13'`)).toBe(null);
  });

  it('reads the earlier database only', async () => {
    const source = await open();
    await expect(source.rows(`DELETE FROM edp_accounts`)).rejects.toThrow(/read-only/);
    await source.close();
  });

  it('copies students, forms, files, approvals and masters, and lists what it left out', async () => {
    const { counts, warnings } = await run(false);
    expect(counts).toMatchObject({
      students: 4,
      'submitted forms': 2,
      drafts: 1,
      batches: 1,
      'batches made for students approved without one': 1,
      'approval events': 3,
      edits: 1,
      'follow-ups': 1,
      'panel users': 1,
    });
    expect(warnings.some((w) => w.includes(ids.a[4]!) && w.includes('mobile'))).toBe(true);
    expect(warnings.some((w) => w.includes(ids.p[3]!) && w.includes('Aadhaar'))).toBe(true);
    expect(warnings.some((w) => w.includes('FITNESS'))).toBe(true);
    expect(warnings.some((w) => w.includes('IPP_DOC_1'))).toBe(true);

    /* Students sign in as before. */
    const account = await one<{ email: string; mobile: string; password_hash: string }>(
      `SELECT email, mobile, password_hash FROM student_accounts WHERE id = $1`,
      [ids.a[0]],
    );
    expect(account).toMatchObject({ email: 'legacy0@example.test', mobile: '9876543210' });
    expect(await passwordMatches('Legacy123', account!.password_hash)).toBe(true);

    /* Masters: the seeded rows take over the Auditor's changes; added ones are added. */
    const program = await loadProgram();
    expect(program.options('CASTE').map((o) => o.nameEn)).toContain('Maratha (renamed)');
    expect(program.options('GENDER').map((o) => o.code)).toEqual(['Male', 'Female']);
    expect(program.technologies(await districtId('NAS')).map((o) => o.code)).toEqual(['T13']);
    expect(program.documentName('PHOTO')).toBe('Photograph');
    expect(program.field('landmark')).toMatchObject({ labelEn: 'Nearest landmark', required: true });
    expect(program.field('x_hobby')).toMatchObject({ isCustom: true });

    /* The form in the batch: ids translated, Aadhaar encrypted with this system's key, code with the program's prefix. */
    const form = (await one<{
      data: Record<string, string>;
      aadhaar_enc: Buffer;
      aadhaar_index: string;
      registration_code: string;
      approval_stage: string;
      batch_id: string;
      documents_verified_at: Date | null;
    }>(`SELECT * FROM applications WHERE id = $1`, [ids.p[0]]))!;
    expect(form).toMatchObject({ registration_code: 'IPP-000041', approval_stage: 'DIVISION', batch_id: ids.batch });
    expect(form.data).toMatchObject({
      district_id: await districtId('NAS'),
      caste_id: await optionId('CASTE', 'SAR01'),
      region_id: await optionId('REGION', 'NAS'),
      education_id: await optionId('EDUCATION', 'BCA'),
      x_hobby: 'Chess',
    });
    expect(form.data.aadhaar_number).toBeUndefined();
    expect(decryptAadhaar(form.aadhaar_enc)).toBe(aadhaar[0]);
    expect(form.aadhaar_index).toBe(aadhaarBlindIndex(aadhaar[0]!));
    expect(form.documents_verified_at).not.toBe(null);
    const file = (await one<{ storage_key: string; sha256: string }>(
      `SELECT * FROM application_files WHERE application_id = $1`,
      [ids.p[0]],
    ))!;
    expect(file.storage_key).toBe('candidates/IPP-000041_Asha_Legacy/PHOTO.png');
    expect(await storage.exists(file.storage_key)).toBe(true);
    expect(
      (
        await rows<{ to_stage: string; actor_kind: string; actor_name: string }>(
          `SELECT to_stage, actor_kind, actor_name FROM approval_events WHERE application_id = $1 ORDER BY seq`,
          [ids.p[0]],
        )
      ).map((e) => `${e.to_stage} ${e.actor_kind} ${e.actor_name}`),
    ).toEqual(['BATCH PANEL Old Auditor', 'DIVISION PANEL Old Auditor', 'COEP OFFICER Old Officer']);

    /* The form of the old register: its values from there, a batch made for it, its caste kept though it is no choice. */
    const old = (await one<{ data: Record<string, string>; registration_code: string; batch: string; approval_stage: string }>(
      `SELECT p.data, p.registration_code, p.approval_stage, b.name AS batch FROM applications p JOIN batches b ON b.id = p.batch_id WHERE p.id = $1`,
      [ids.p[1]],
    ))!;
    expect(old).toMatchObject({ registration_code: 'REG-000007', batch: 'Imported – Pune', approval_stage: 'APPROVED' });
    expect(old.data).toMatchObject({
      first_name: 'Register',
      date_of_birth: '2001-02-03',
      disability_status: 'No',
      score: '71.5',
      cgpa_scale: '10',
      caste_id: ids.oldCaste,
      district_id: await districtId('PUN'),
    });
    expect(program.optionName('CASTE', ids.oldCaste)).toBe('जुनी जात');

    /* The next registration ID follows the copied ones. */
    expect((await one<{ n: number }>(`SELECT nextval('registration_seq') AS n`))!.n).toBe(42);
  });

  it('refuses a database that already has students', async () => {
    await expect(run(false)).rejects.toThrow(/empty one only/);
  });
});
