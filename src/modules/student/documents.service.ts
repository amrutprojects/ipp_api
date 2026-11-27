import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { one, rows, transaction } from '../../db/pool';
import type { StudentAccount } from '../../http/auth';
import { AppError } from '../../http/errors';
import { fileLink } from '../../program/file-links';
import { folderFor } from '../../program/folders';
import { loadProgram } from '../../program/masters';
import { checkUploads, discardFiles, discardUnusedFiles } from '../../program/uploads';
import { storage } from '../../services/storage';
import { applicationService, lockDraft } from './application.service';

const noFile = () => AppError.notFound('No file has been uploaded for this document');

export const documentsService = {
  /*
   * Step 3: stores the files, each in place of an earlier one of its document. Every upload has a storage key of its own, so
   * the earlier file is there until the database holds the new one; only then it is deleted.
   */
  async upload(account: StudentAccount, files: Express.Multer.File[]) {
    /* The student's folder, named as the form says now (else the account): "Asha Patil 9876501234". */
    const { id, folder } = await transaction(async (db) => {
      const p = await lockDraft(db, account.id);
      const v = (k: string) => (typeof p.data[k] === 'string' ? p.data[k] : '');
      const who = { first_name: v('first_name'), last_name: v('last_name'), mobile: v('mobile_number') };
      return { id: p.id, folder: await folderFor(db, p.id, who, account) };
    });
    if (!files.length) throw AppError.validation([{ field: 'files', message: 'Choose a file to upload' }]);
    const uploads = await checkUploads(files, (await loadProgram()).documents());
    const written: string[] = [];
    let replaced: string[];
    try {
      const stored: { code: string; values: unknown[] }[] = [];
      for (const { code, path, type, name } of uploads) {
        const data = await fs.readFile(path);
        const key = storage.studentKey(folder, `${code}-${crypto.randomUUID()}.${type.ext}`);
        /* Noted first: a file written only in part is deleted too. */
        written.push(key);
        await storage.write(key, data);
        const sha256 = crypto.createHash('sha256').update(data).digest('hex');
        stored.push({ code, values: [key, name, type.mime, data.length, sha256] });
      }
      replaced = await transaction(async (db) => {
        /* Not submitted meanwhile. */
        await lockDraft(db, account.id);
        /* Deleted and added (not changed in place), so nothing known about the earlier file stays. */
        const old = await rows<{ storage_key: string }>(
          `DELETE FROM application_files WHERE application_id = $1 AND document_code = ANY($2::text[]) RETURNING storage_key`,
          [id, stored.map((s) => s.code)],
          db,
        );
        for (const { code, values } of stored)
          await db.query(
            `INSERT INTO application_files (application_id, document_code, storage_key, original_name, mime_type, size_bytes, sha256)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, code, ...values],
          );
        await db.query(`UPDATE applications SET student_active_at = now() WHERE id = $1`, [id]);
        return old.map((o) => o.storage_key);
      });
    } catch (err) {
      await discardUnusedFiles(written);
      throw err;
    }
    await discardFiles(replaced);
    return applicationService.get(account);
  },

  async remove(account: StudentAccount, code: string) {
    const key = await transaction(async (db) => {
      const { id } = await lockDraft(db, account.id);
      const file = await one<{ storage_key: string }>(
        `DELETE FROM application_files WHERE application_id = $1 AND document_code = $2 RETURNING storage_key`,
        [id, code],
        db,
      );
      if (!file) throw noFile();
      await db.query(`UPDATE applications SET student_active_at = now() WHERE id = $1`, [id]);
      return file.storage_key;
    });
    await discardFiles([key]);
    return applicationService.get(account);
  },

  /* The student's own file: of the draft or the submitted form, also of a document switched off since. */
  /* A short-lived link to the student's own file (program/file-links.ts). */
  async link(account: StudentAccount, code: string) {
    const file = await one<{ id: string }>(
      `SELECT f.id FROM application_files f JOIN applications p ON p.id = f.application_id
       WHERE p.account_id = $1 AND f.document_code = $2`,
      [account.id, code],
    );
    if (!file) throw noFile();
    return fileLink(file.id);
  },

  async file(account: StudentAccount, code: string): Promise<{ stream: Readable; mimeType: string; name: string }> {
    const file = await one<{ storage_key: string; mime_type: string; original_name: string }>(
      `SELECT f.storage_key, f.mime_type, f.original_name FROM application_files f JOIN applications p ON p.id = f.application_id
       WHERE p.account_id = $1 AND f.document_code = $2`,
      [account.id, code],
    );
    if (!file) throw noFile();
    return { stream: await storage.read(file.storage_key), mimeType: file.mime_type, name: file.original_name };
  },
};
