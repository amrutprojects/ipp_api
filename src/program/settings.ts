import { config } from '../config';
import { one, pool, type Db } from '../db/pool';
import { logger } from '../lib/logger';
import { BATCH_SIZE } from './constants';

/*
 * The settings the panel edits (table settings, one row per key), with the defaults used until a row is saved. "batch": how
 * many students a new batch has. "support": the contact line students see after submitting and in e-mails. "welcome": the
 * dialog shown once the account is created. "help": the Help button's contact details.
 */
export interface SavedMeta {
  /* null = never saved: the defaults are in use. */
  updated_at: Date | null;
  /* The name of the panel user who saved it. */
  updated_by: string | null;
}

export interface BatchValue {
  size: number;
}
/* {email} and {mobile} in the message are replaced with the contact details. */
export interface SupportValue {
  message: string;
  email: string | null;
  mobile: string | null;
}
export interface WelcomeValue {
  enabled: boolean;
  title: string;
  message: string;
  /* Blank: the portal uses its own text, in the language the student chose. */
  button_label: string;
}
/* One line of the Help button; an e-mail address or a phone number is shown as a link. */
export interface HelpField {
  label: string;
  value: string;
}
export interface HelpValue {
  enabled: boolean;
  title: string;
  intro: string;
  fields: HelpField[];
}

export interface SettingValues {
  batch: BatchValue;
  support: SupportValue;
  welcome: WelcomeValue;
  help: HelpValue;
}
export type SettingKey = keyof SettingValues;

export type BatchSettings = BatchValue & SavedMeta;
export type SupportSettings = SupportValue & SavedMeta;
export type WelcomeSettings = WelcomeValue & SavedMeta;
export type HelpSettings = HelpValue & SavedMeta;

/* The most lines of the Help button. */
export const HELP_FIELDS_MAX = 4;

export const DEFAULT_SUPPORT_MESSAGE =
  'If you have any query related to your registration, you can contact us on email ID {email} or mobile number {mobile}.';
const DEFAULT_HELP_TITLE = 'Need help?';

const DEFAULTS: { [K in SettingKey]: () => SettingValues[K] } = {
  batch: () => ({ size: BATCH_SIZE.DEFAULT }),
  support: () => ({ message: DEFAULT_SUPPORT_MESSAGE, ...config.support }),
  welcome: () => ({
    enabled: true,
    title: 'Congratulations! Your account is created',
    message:
      'Your mobile number is verified and your 3 Month Internship Placement Program account is ready. Fill in the form in three steps, upload your documents and submit it — you can see your application any time.',
    button_label: '',
  }),
  /* Whichever of SUPPORT_MOBILE and SUPPORT_EMAIL is set. */
  help: () => ({
    enabled: true,
    title: DEFAULT_HELP_TITLE,
    intro: 'For any query about your registration, you can contact the programme office.',
    fields: [
      { label: 'Contact Number', value: config.support.mobile ?? '' },
      { label: 'Email ID', value: config.support.email ?? '' },
    ].filter((f) => f.value),
  }),
};

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
/* A value saved before the flag existed counts as enabled. */
const flag = (v: unknown) => v !== false;

type Saved<K extends SettingKey> = { [P in keyof SettingValues[K]]?: unknown };

/* A saved row is JSON and may predate a field: read defensively, never trusting its shape. */
const SHAPES: { [K in SettingKey]: (v: Saved<K>) => SettingValues[K] } = {
  batch: (v) => {
    const n = Number(v.size);
    return { size: Number.isInteger(n) && n >= BATCH_SIZE.MIN && n <= BATCH_SIZE.MAX ? n : BATCH_SIZE.DEFAULT };
  },
  support: (v) => ({ message: str(v.message), email: strOrNull(v.email), mobile: strOrNull(v.mobile) }),
  welcome: (v) => ({
    enabled: flag(v.enabled),
    title: str(v.title, DEFAULTS.welcome().title),
    message: str(v.message, DEFAULTS.welcome().message),
    button_label: str(v.button_label),
  }),
  help: (v) => ({
    enabled: flag(v.enabled),
    title: str(v.title, DEFAULT_HELP_TITLE),
    intro: str(v.intro),
    fields: (Array.isArray(v.fields) ? (v.fields as (Partial<Record<keyof HelpField, unknown>> | null)[]) : [])
      .map((f) => ({ label: str(f?.label).trim(), value: str(f?.value).trim() }))
      .filter((f) => f.label && f.value)
      .slice(0, HELP_FIELDS_MAX),
  }),
};

async function read<K extends SettingKey>(key: K, db: Db): Promise<SettingValues[K] & SavedMeta> {
  const row = await one<{ value: Saved<K> | null } & SavedMeta>(
    `SELECT s.value, s.updated_at, u.name AS updated_by
     FROM settings s LEFT JOIN panel_users u ON u.id = s.updated_by WHERE s.key = $1`,
    [key],
    db,
  );
  if (!row) return { ...DEFAULTS[key](), updated_at: null, updated_by: null };
  return { ...SHAPES[key](row.value ?? {}), updated_at: row.updated_at, updated_by: row.updated_by };
}

/* A setting as saved (else the defaults), when it was last saved and by whom. */
export const batchSettings = (db: Db = pool): Promise<BatchSettings> => read('batch', db);
export const supportSettings = (db: Db = pool): Promise<SupportSettings> => read('support', db);
export const welcomeSettings = (db: Db = pool): Promise<WelcomeSettings> => read('welcome', db);
export const helpSettings = (db: Db = pool): Promise<HelpSettings> => read('help', db);

/* What students get: the value alone, and the defaults when it cannot be read, so the portal and its e-mails still work. */
async function forStudents<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
  try {
    const { updated_at: _at, updated_by: _by, ...value } = await read(key, pool);
    return value as unknown as SettingValues[K];
  } catch (err) {
    logger.warn({ err, key }, 'a setting could not be read; using its default');
    return DEFAULTS[key]();
  }
}
export const supportForStudents = () => forStudents('support');
export const welcomeForStudents = () => forStudents('welcome');
export const helpForStudents = () => forStudents('help');

/* Saves a setting (the audit record is the caller's). */
export async function saveSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingValues[K],
  panelUserId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), panelUserId],
  );
}
