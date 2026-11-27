import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { VIEW_ONLY } from '../../src/http/auth';
import { cmsApis } from '../../src/modules/cms';
import { DEFAULT_CONTENT } from '../../src/modules/cms/defaults';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { FILES, makeAccount, makePanelUser, request, type TestPanelUser, type TestStudent } from '../helpers/factory';
import { audits, del, get, issues, NOBODY, patch, post, put, refused } from '../masters/helpers';

/* Method, path and who may call it, of every endpoint of the module. */
const ENDPOINTS = [
  ['get', '/landing', 'public'],
  ['get', '/landing/logo', 'public'],
  ['get', '/manage/cms/landing', 'panel'],
  ['put', '/manage/cms/landing', 'admin'],
  ['put', '/manage/cms/landing/logo', 'admin'],
  ['delete', '/manage/cms/landing/logo', 'admin'],
  ['get', '/manage/cms/courses', 'panel'],
  ['post', '/manage/cms/courses', 'admin'],
  ['patch', '/manage/cms/courses/:id', 'admin'],
  ['delete', '/manage/cms/courses/:id', 'admin'],
  ['get', '/manage/cms/faqs', 'panel'],
  ['post', '/manage/cms/faqs', 'admin'],
  ['patch', '/manage/cms/faqs/:id', 'admin'],
  ['delete', '/manage/cms/faqs/:id', 'admin'],
] as const;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);

let admin: TestPanelUser;
let viewer: TestPanelUser;
let student: TestStudent;

beforeAll(async () => {
  await resetDatabase();
  student = await makeAccount();
});
beforeEach(async () => {
  await pool.query('TRUNCATE cms_documents, cms_assets, cms_courses, cms_faqs, audit_logs');
  admin = await makePanelUser('ADMIN');
  viewer = await makePanelUser('VIEWER');
});
afterAll(closeDatabase);

const course = (title: string, over: object = {}) =>
  post(admin, '/cms/courses', { title, description: `About ${title}`, icon: 'code', tags: ['A', 'B'], ...over });
const faq = (question: string, over: object = {}) =>
  post(admin, '/cms/faqs', { question, answer: `Answer to ${question}`, ...over });
const landing = () => request('get', '/landing');

describe('who may call what', () => {
  it('has exactly these endpoints', () => {
    const declared = cmsApis.flatMap((a) => a.endpoints).map((e) => [e.method, e.path, e.auth]);
    expect(declared).toHaveLength(ENDPOINTS.length);
    for (const e of ENDPOINTS) expect(declared).toContainEqual([...e]);
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth !== 'public'))(
    '%s %s is refused without a panel session',
    async (method, path) => {
      for (const token of [undefined, student.token, 'not-a-token']) {
        const res = await request(method, path.replace(':id', NOBODY), token);
        expect(res.status).toBe(401);
      }
    },
  );

  it.each(ENDPOINTS.filter(([, , auth]) => auth === 'admin'))('%s %s is refused to a VIEWER', async (method, path) => {
    const res = await request(method, path.replace(':id', NOBODY), viewer.token).send({ title: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(VIEW_ONLY);
    expect(await audits('%')).toEqual([]);
  });

  it.each(ENDPOINTS.filter(([, , auth]) => auth === 'panel'))('%s %s is answered to a VIEWER', async (method, path) => {
    const res = await request(method, path, viewer.token);
    expect(res.status).toBe(200);
  });
});

describe('the public landing page', () => {
  it('starts from the defaults, readable from any origin', async () => {
    const res = await landing().set('Origin', 'https://landing.example.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body.data).toEqual({ content: DEFAULT_CONTENT, courses: [], faqs: [], logo: null, updated_at: null });
  });

  it('shows only the active courses and FAQs, in order', async () => {
    await course('Zeta', { display_order: 5 });
    const hidden = (await course('Hidden')).body.data.id as string;
    await course('Alpha', { display_order: 20, registration_open: false, short_title: 'A' });
    await patch(admin, `/cms/courses/${hidden}`, { is_active: false });
    await faq('Second?', { display_order: 20 });
    await faq('First?', { display_order: 10, answer_kind: 'COURSES', answer: '' });
    const off = (await faq('Hidden?')).body.data.id as string;
    await patch(admin, `/cms/faqs/${off}`, { is_active: false });

    const { body } = await landing();
    expect(body.data.courses.map((c: { title: string }) => c.title)).toEqual(['Zeta', 'Alpha']);
    expect(body.data.courses[1]).toMatchObject({ short_title: 'A', registration_open: false, tags: ['A', 'B'] });
    expect(Object.keys(body.data.courses[0]).sort()).toEqual(
      ['description', 'icon', 'id', 'registration_open', 'short_title', 'tags', 'title'].sort(),
    );
    expect(body.data.faqs.map((f: { question: string }) => f.question)).toEqual(['First?', 'Second?']);
    expect(body.data.faqs[0]).toMatchObject({ answer_kind: 'COURSES', answer: '' });
  });
});

describe('the page document', () => {
  it('is saved whole by an ADMIN, shown on the page and audited', async () => {
    const content = clone(DEFAULT_CONTENT);
    content.hero.title_line1 = 'NEW TITLE';
    content.about.enabled = false;
    content.header.register = { ...content.header.register, label: 'Apply', action: 'url', url: 'https://apply.example.test/' };
    const res = await put(admin, '/cms/landing', { content });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Landing page saved');
    expect(res.body.data).toMatchObject({ content, defaults: DEFAULT_CONTENT, logo: null, updated_by: admin.name });

    expect((await landing()).body.data.content).toEqual(content);
    expect((await get(viewer, '/cms/landing')).body.data.content).toEqual(content);
    expect(await audits('edp.cms.%')).toEqual([
      expect.objectContaining({ action: 'edp.cms.landing.update', resource: 'cms', resource_id: 'landing', actor_id: admin.id }),
    ]);
  });

  it('refuses links that are not web addresses and buttons without text', async () => {
    const content = clone(DEFAULT_CONTENT);
    content.links.register_url = 'javascript:alert(1)';
    content.hero.primary = { ...content.hero.primary, label: '' };
    content.final_cta.primary = { ...content.final_cta.primary, action: 'url', url: '' };
    (content.benefits.items[0] as { icon: string }).icon = 'not-an-icon';
    const problems = issues(await put(admin, '/cms/landing', { content }));
    expect(problems).toMatchObject({
      'body.content.links.register_url': 'Registration page must be a full address starting with https://',
      'body.content.hero.primary.label': 'Button text is required',
      'body.content.final_cta.primary.url': 'Link is required',
      'body.content.benefits.items.0.icon': 'Choose an icon from the list',
    });
    expect((await landing()).body.data.content).toEqual(DEFAULT_CONTENT);
  });

  it('reads a stored part that no longer passes as its default, keeping the other parts', async () => {
    const stored = { hero: { title_line1: 'Kept', stats: 'broken' }, links: { register_url: 'ftp://x' }, extra: 1 };
    await pool.query(`INSERT INTO cms_documents (key, value) VALUES ('landing', $1)`, [JSON.stringify(stored)]);
    const { content } = (await landing()).body.data;
    expect(content.hero).toEqual(DEFAULT_CONTENT.hero);
    expect(content.links).toEqual(DEFAULT_CONTENT.links);
    expect(content).not.toHaveProperty('extra');

    await pool.query(`UPDATE cms_documents SET value = $1`, [JSON.stringify({ hero: { title_line1: 'Kept' } })]);
    expect((await landing()).body.data.content.hero).toEqual({ ...DEFAULT_CONTENT.hero, title_line1: 'Kept' });
  });
});

describe('courses', () => {
  it('are added, changed, hidden and deleted', async () => {
    const res = await course('Cyber Security', { short_title: 'Cyber', tags: ['Network Security'] });
    expect(res.status).toBe(201);
    const id = res.body.data.id as string;
    expect(res.body.data).toMatchObject({
      title: 'Cyber Security',
      short_title: 'Cyber',
      icon: 'code',
      tags: ['Network Security'],
      registration_open: true,
      display_order: 10,
      is_active: true,
    });
    expect((await course('Second')).body.data.display_order).toBe(20);

    const changed = await patch(admin, `/cms/courses/${id}`, { short_title: '', registration_open: false, icon: 'shield' });
    expect(changed.body.data).toMatchObject({ short_title: null, registration_open: false, icon: 'shield' });

    refused(await course('cyber security'), 409, 'A course with this title already exists');
    expect(issues(await course('X', { icon: 'nope', tags: ['A', 'a'] }))).toMatchObject({
      'body.icon': 'Choose an icon from the list',
      'body.tags': 'Each tag only once',
    });
    expect(issues(await patch(admin, `/cms/courses/${id}`, {}))).toBeTruthy();

    expect((await del(admin, `/cms/courses/${id}`)).body.message).toBe('Course deleted');
    expect((await get(admin, '/cms/courses')).body.data.map((c: { title: string }) => c.title)).toEqual(['Second']);
    refused(await patch(admin, `/cms/courses/${id}`, { is_active: true }), 404, 'Course not found');
    refused(await del(admin, `/cms/courses/${NOBODY}`), 404, 'Course not found');
    /* A deleted title can be used again. */
    expect((await course('Cyber Security')).status).toBe(201);
    expect((await audits('edp.cms.course.%')).map((a) => a.action)).toEqual([
      'edp.cms.course.create',
      'edp.cms.course.create',
      'edp.cms.course.update',
      'edp.cms.course.delete',
      'edp.cms.course.create',
    ]);
  });
});

describe('FAQs', () => {
  it('need an answer unless they list the courses', async () => {
    expect(issues(await faq('Empty?', { answer: ' ' }))).toEqual({ 'body.answer': 'Answer is required' });
    const listing = await faq('Which courses?', { answer: '', answer_kind: 'COURSES' });
    expect(listing.status).toBe(201);
    const id = listing.body.data.id as string;
    expect(issues(await patch(admin, `/cms/faqs/${id}`, { answer_kind: 'TEXT' }))).toEqual({
      'body.answer': 'Answer is required',
    });
    expect((await patch(admin, `/cms/faqs/${id}`, { answer_kind: 'TEXT', answer: 'All of them.' })).body.data).toMatchObject({
      answer_kind: 'TEXT',
      answer: 'All of them.',
    });
    refused(await faq('which courses?'), 409, 'This question is already in the list');
    expect((await del(admin, `/cms/faqs/${id}`)).status).toBe(200);
    expect((await get(admin, '/cms/faqs')).body.data).toEqual([]);
  });
});

describe('the logo', () => {
  const upload = (file: Buffer, name: string, by: TestPanelUser = admin) =>
    request('put', '/manage/cms/landing/logo', by.token).attach('logo', file, name);

  it('is uploaded, served to any page with its version, and removed', async () => {
    const res = await upload(FILES.png, 'logo.png');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mime_type: 'image/png', size_bytes: FILES.png.length, path: '/landing/logo' });
    const version = res.body.data.version as string;
    expect((await landing()).body.data.logo).toEqual({ path: '/landing/logo', version });

    const image = await request('get', '/landing/logo');
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(image.headers['etag']).toBe(`"${version}"`);
    expect(Buffer.compare(image.body as Buffer, FILES.png)).toBe(0);
    expect((await request('get', '/landing/logo').set('If-None-Match', `"${version}"`)).status).toBe(304);

    expect((await upload(SVG, 'logo.svg')).body.data.mime_type).toBe('image/svg+xml');
    const svg = await request('get', '/landing/logo');
    expect(svg.headers['content-security-policy']).toContain('sandbox');

    expect((await del(admin, '/cms/landing/logo')).body.message).toBe('Logo removed');
    expect((await landing()).body.data.logo).toBeNull();
    refused(await request('get', '/landing/logo'), 404, 'There is no logo');
    refused(await del(admin, '/cms/landing/logo'), 404, 'There is no logo to remove');
    expect((await audits('edp.cms.logo.%')).map((a) => a.action)).toEqual([
      'edp.cms.logo.update',
      'edp.cms.logo.update',
      'edp.cms.logo.delete',
    ]);
  });

  it('must be a PNG, JPG, WebP or a plain SVG of at most 1 MB', async () => {
    expect(issues(await upload(FILES.pdf, 'logo.pdf'))).toEqual({ logo: 'The logo must be a PNG, JPG, WebP or SVG image' });
    const scripted = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(issues(await upload(scripted, 'logo.svg'))).toEqual({
      logo: 'The SVG contains scripts or event handlers; export it again as a plain image',
    });
    const handler = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect((await upload(handler, 'logo.svg')).status).toBe(422);
    const big = Buffer.concat([FILES.png, Buffer.alloc(1024 * 1024)]);
    expect(issues(await upload(big, 'logo.png'))).toEqual({ logo: 'The logo must be at most 1 MB' });
    expect(issues(await request('put', '/manage/cms/landing/logo', admin.token))).toEqual({ logo: 'Choose an image' });
    expect((await landing()).body.data.logo).toBeNull();
  });
});
