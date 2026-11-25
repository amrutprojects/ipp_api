import type { Request } from 'express';
import { transaction } from '../../db/pool';
import type { PanelUser } from '../../http/auth';
import { saveSetting, type SettingKey, type SettingValues } from '../../program/settings';
import { audit } from '../../services/audit';
import { actor } from './common';

/* Saves one of the settings, and who did (not what: it holds contact details). */
export const saveSettings = <K extends SettingKey>(req: Request, user: PanelUser, key: K, value: SettingValues[K]) =>
  transaction(async (db) => {
    await saveSetting(db, key, value, user.id);
    await audit.inTx(db, req, { action: `edp.settings.${key}`, resource: 'settings', resourceId: key, actor: actor(user) });
  });
