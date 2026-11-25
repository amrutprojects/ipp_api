import { Api } from '../../http/api';
import { panelOf } from '../../http/auth';
import { ok } from '../../http/respond';
import { helpSettings, supportSettings, welcomeSettings } from '../../program/settings';
import { batchSizeBody, helpBody, supportBody, welcomeBody } from './settings.schemas';
import { batchRules, saveBatchSize, saveSettings } from './settings.service';

/* The settings the panel edits: every panel user reads them, an ADMIN saves them. Students get them with GET /options. */
export const settingsApi = new Api('Panel: settings');
const api = settingsApi;

api.get(
  '/manage/settings/batch',
  {
    auth: 'panel',
    summary: 'How many students a new batch has: the default, and the districts with a size of their own',
    returns: '{ size, districts: { district_id, name, size }[], updated_at, updated_by, district_required } (null = never saved)',
  },
  async ({ res }) => ok(res, await batchRules()),
);
api.put(
  '/manage/settings/batch',
  {
    auth: 'admin',
    summary: 'Sets how many students a new batch has (existing batches keep theirs); districts, when given, replace the list',
    returns: 'as GET',
    body: batchSizeBody,
  },
  async ({ req, res, body }) => {
    await saveBatchSize(req, panelOf(res), body);
    ok(res, await batchRules(), 'Batch size saved');
  },
);

api.get(
  '/manage/settings/support',
  {
    auth: 'panel',
    summary: 'The contact line students see',
    returns: '{ message, email, mobile, updated_at, updated_by }',
  },
  async ({ res }) => ok(res, await supportSettings()),
);
api.put(
  '/manage/settings/support',
  {
    auth: 'admin',
    summary: 'Saves the contact line students see',
    returns: '{ message, email, mobile, updated_at, updated_by }',
    body: supportBody,
  },
  async ({ req, res, body }) => {
    await saveSettings(req, panelOf(res), 'support', {
      message: body.message,
      email: body.email ?? null,
      mobile: body.mobile ?? null,
    });
    ok(res, await supportSettings(), 'Support contact saved');
  },
);

api.get(
  '/manage/settings/welcome',
  {
    auth: 'panel',
    summary: 'The dialog shown once an account is created',
    returns: '{ enabled, title, message, button_label, updated_at, updated_by }',
  },
  async ({ res }) => ok(res, await welcomeSettings()),
);
api.put(
  '/manage/settings/welcome',
  {
    auth: 'admin',
    summary: 'Saves the dialog shown once an account is created',
    returns: '{ enabled, title, message, button_label, updated_at, updated_by }',
    body: welcomeBody,
  },
  async ({ req, res, body }) => {
    await saveSettings(req, panelOf(res), 'welcome', body);
    ok(res, await welcomeSettings(), 'Welcome message saved');
  },
);

api.get(
  '/manage/settings/help',
  {
    auth: 'panel',
    summary: "The Help button's contact details",
    returns: '{ enabled, title, intro, fields, updated_at, updated_by }',
  },
  async ({ res }) => ok(res, await helpSettings()),
);
api.put(
  '/manage/settings/help',
  {
    auth: 'admin',
    summary: "Saves the Help button's contact details (blank rows are dropped)",
    returns: '{ enabled, title, intro, fields, updated_at, updated_by }',
    body: helpBody,
  },
  async ({ req, res, body }) => {
    await saveSettings(req, panelOf(res), 'help', { ...body, fields: body.fields.filter((f) => f.label && f.value) });
    ok(res, await helpSettings(), 'Help contact saved');
  },
);
