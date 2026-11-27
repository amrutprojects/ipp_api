import { z } from 'zod';
import { content as textOf } from '../../lib/text';
import { DEFAULT_CONTENT } from './defaults';

/*
 * The landing page's document: texts, links, buttons and the switches of its sections (courses and FAQs are lists of their
 * own). What is stored is read over the defaults, part by part: a part saved by an older version, or one that no longer
 * passes the rules, falls back to its default instead of breaking the page. Text is plain text (the page escapes it);
 * links must be web addresses, so a stored value can never become a script link on the page.
 */

/* The icons the page draws (its own SVG sprite), by name. */
export const ICONS = [
  'cap',
  'check',
  'clock',
  'calendar',
  'user-check',
  'briefcase',
  'code',
  'cpu',
  'bar',
  'trend',
  'pie',
  'db',
  'layers',
  'coffee',
  'network',
  'monitor',
  'server',
  'globe',
  'tool',
  'users',
  'user',
  'clipboard',
  'box',
  'target',
  'star',
  'message',
  'grid',
  'book',
  'gift',
  'pin',
  'id',
  'file',
  'home',
  'photo',
  'shield',
  'wallet',
  'ban',
  'edit',
  'send',
  'search',
  'flag',
  'info',
  'zap',
  'mic',
  'folder',
  'compass',
  'lock',
  'bug',
] as const;

/* The sections of the page, by their anchor (#about, …): what a menu item or a button can point to. */
export const SECTIONS = [
  'home',
  'about',
  'courses',
  'structure',
  'benefits',
  'eligibility',
  'documents',
  'journey',
  'placement',
  'faqs',
  'get-started',
] as const;

/* Where a button goes. */
export const CTA_ACTIONS = ['register', 'login', 'url', 'section'] as const;

const t = (max: number, label = 'Text') => textOf(label, max);
const on = z.boolean({ required_error: 'Must be on or off', invalid_type_error: 'Must be on or off' });
const icon = z.enum(ICONS, { errorMap: () => ({ message: 'Choose an icon from the list' }) });
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max, `At most ${max} items`);

export const isWebAddress = (v: string): boolean => {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '';
  } catch {
    return false;
  }
};
const webAddress = (label: string) =>
  z
    .string({ invalid_type_error: `${label} must be text` })
    .trim()
    .max(500, `${label} must be at most 500 characters`)
    .refine((v) => v === '' || isWebAddress(v), `${label} must be a full address starting with https://`);
const requiredAddress = (label: string) => webAddress(label).refine((v) => v !== '', `${label} is required`);

const cta = z
  .object({
    enabled: on,
    label: t(60, 'Button text'),
    action: z.enum(CTA_ACTIONS, { errorMap: () => ({ message: 'Choose where the button goes' }) }),
    url: webAddress('Link'),
    section: z.enum(SECTIONS, { errorMap: () => ({ message: 'Choose a section' }) }),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.label) ctx.addIssue({ code: 'custom', path: ['label'], message: 'Button text is required' });
    if (v.enabled && v.action === 'url' && !v.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Link is required' });
  });
const note = z.object({ enabled: on, title: t(120), text: t(600) });
const ctaBlock = z.object({ enabled: on, title: t(160), text: t(300), primary: cta, secondary: cta });
/* The heading of a section, and whether the section is shown. */
const head = { enabled: on, eyebrow: t(80), title: t(160), subtitle: t(400) };

export const contentShape = {
  seo: z.object({ title: t(160), description: t(320), keywords: t(600) }),
  links: z.object({
    register_url: requiredAddress('Registration page'),
    login_url: requiredAddress('Login page'),
    /* Where the landing page itself is published (the panel's Preview button). */
    landing_url: webAddress('Landing page address'),
  }),
  branding: z.object({ logo_alt: t(120), title_line1: t(60), title_line2: t(60), show_title_with_logo: on }),
  header: z.object({ register: cta, login: cta, mobile_bar: on }),
  nav: list(z.object({ label: t(40), section: z.enum(SECTIONS), enabled: on }), 12),
  hero: z.object({
    badge_tag: t(30),
    badge_text: t(100),
    title_line1: t(80),
    title_line2: t(80),
    tagline: t(200),
    paragraphs: list(t(800), 4),
    primary: cta,
    secondary: cta,
    note: t(300),
    snapshot: z.object({ enabled: on, kicker: t(60), title: t(120), show_mix: on, chips: list(t(40), 6) }),
    stats: list(z.object({ icon, value: t(20), label: t(60), enabled: on }), 6),
  }),
  about: z.object({
    ...head,
    lead: t(600),
    paragraphs: list(t(800), 4),
    chips: list(t(40), 10),
    pillars: list(z.object({ icon, title: t(120), text: t(400), enabled: on }), 6),
  }),
  courses: z.object({ ...head, button_label: t(40), closed_label: t(40), note: t(600) }),
  structure: z.object({
    ...head,
    facts: list(z.object({ icon, label: t(40), value: t(30), enabled: on }), 6),
    show_mix: on,
    theory_label: t(30),
    practical_label: t(30),
    theory_percent: z
      .number({ invalid_type_error: 'Must be a number' })
      .int('Must be a whole number')
      .min(0, 'Must be 0 to 100')
      .max(100, 'Must be 0 to 100'),
    project_note: note,
    stages_title: t(120),
    stages: list(z.object({ title: t(120), text: t(300), enabled: on }), 10),
    months: z.object({
      enabled: on,
      title: t(120),
      note: t(300),
      items: list(z.object({ label: t(30), title: t(120), points: list(t(80), 6) }), 6),
    }),
  }),
  benefits: z.object({ ...head, items: list(z.object({ icon, title: t(120), enabled: on }), 16), attendance_note: note }),
  eligibility: z.object({
    ...head,
    items: list(z.object({ icon, title: t(120), text: t(400), chips: list(t(40), 8), enabled: on }), 12),
    fine_print: t(400),
    summary: z.object({
      enabled: on,
      kicker: t(60),
      title: t(120),
      rows: list(z.object({ label: t(60), value: t(160) }), 8),
      note: t(400),
      primary: cta,
      secondary: cta,
    }),
  }),
  documents: z.object({ ...head, items: list(z.object({ icon, text: t(300), enabled: on }), 16), note, cta: ctaBlock }),
  journey: z.object({
    ...head,
    steps: list(z.object({ icon, title: t(120), text: t(300), enabled: on }), 12),
    note,
    cta: ctaBlock,
  }),
  placement: z.object({
    ...head,
    lead: t(600),
    note,
    items: list(z.object({ icon, label: t(120), enabled: on }), 12),
    primary: cta,
    secondary: cta,
  }),
  faqs: z.object({ ...head }),
  final_cta: z.object({
    enabled: on,
    title: t(160),
    text: t(400),
    points: list(t(60), 6),
    primary: cta,
    secondary: cta,
  }),
  footer: z.object({
    description: t(600),
    show_quick_links: on,
    quick_links_title: t(60),
    show_programmes: on,
    programmes_title: t(60),
    portal_enabled: on,
    portal_title: t(60),
    portal_text: t(300),
    primary: cta,
    secondary: cta,
    copyright: t(200),
    bottom_note: t(300),
  }),
};

export const landingContent = z.object(contentShape);
export type LandingContent = z.infer<typeof landingContent>;
type Part = keyof LandingContent;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/*
 * `over` laid on `base`: objects key by key, a list as stored (each item filled in from the first default item, so an item
 * saved before a key existed still has it), anything else as stored.
 */
function merge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlain(base) && isPlain(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(over)) if (!UNSAFE_KEYS.has(key)) out[key] = merge(base[key], over[key]);
    return out;
  }
  if (Array.isArray(base) && Array.isArray(over) && isPlain(base[0])) return over.map((item) => merge(base[0], item));
  return over;
}

/* The stored document as the page and the panel use it. */
export function readContent(stored: unknown): LandingContent {
  const merged = merge(DEFAULT_CONTENT, stored) as Record<string, unknown>;
  const out = {} as Record<Part, unknown>;
  for (const part of Object.keys(contentShape) as Part[]) {
    const result = contentShape[part].safeParse(merged[part]);
    out[part] = result.success ? result.data : DEFAULT_CONTENT[part];
  }
  return out as LandingContent;
}
