import type { Request } from 'express';
import { rows, transaction } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { AppError } from '../../http/errors';
import { loadProgram } from '../../program/masters';
import { batchSettings, districtSizes, saveSetting, type SettingKey, type SettingValues } from '../../program/settings';
import { audit } from '../../services/audit';
import { actor } from './common';
import type { BatchSizeBody } from './settings.schemas';

/* Saves one of the settings, and who did (not what: it holds contact details). */
export const saveSettings = <K extends SettingKey>(req: Request, user: PanelUser, key: K, value: SettingValues[K]) =>
  transaction(async (db) => {
    await saveSetting(db, key, value, user.id);
    await audit.inTx(db, req, { action: `edp.settings.${key}`, resource: 'settings', resourceId: key, actor: actor(user) });
  });

/*
 * What a new batch must be: the default size, the districts with a size of their own, and whether each of its students must
 * have a district (Masters → Form fields).
 */
export async function batchRules() {
  const [size, districts, program] = await Promise.all([batchSettings(), districtSizes(), loadProgram()]);
  return { ...size, districts, district_required: program.requires('district_id') };
}

/* Saves the default size and, when they are given, the districts' own sizes (a district that is not listed has none). */
export const saveBatchSize = (req: Request, user: PanelUser, body: BatchSizeBody) =>
  transaction(async (db) => {
    await saveSetting(db, 'batch', { size: body.size }, user.id);
    const list = body.districts;
    if (list) {
      const ids = list.map((d) => d.district_id.toLowerCase());
      const known = await rows<{ id: string }>(
        `SELECT id FROM districts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
        [ids],
        db,
      );
      const unknown = ids.flatMap((id, i) =>
        known.some((d) => d.id === id) ? [] : [{ field: `body.districts.${i}.district_id`, message: 'District not found' }],
      );
      if (unknown.length) throw AppError.validation(unknown);
      await db.query(
        `UPDATE districts d SET batch_size = t.size
         FROM (SELECT d2.id, n.size FROM districts d2 LEFT JOIN unnest($1::uuid[], $2::smallint[]) AS n (id, size) ON n.id = d2.id) t
         WHERE t.id = d.id AND d.batch_size IS DISTINCT FROM t.size`,
        [ids, list.map((d) => d.size)],
      );
    }
    await audit.inTx(db, req, {
      action: 'edp.settings.batch',
      resource: 'settings',
      resourceId: 'batch',
      actor: actor(user),
      ...(list ? { details: { districts: list.length } } : {}),
    });
  });
