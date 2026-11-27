import type { Response } from 'express';
import { Api } from '../../http/api';
import { AppError } from '../../http/errors';
import { created, ok } from '../../http/respond';
import { idParams } from '../masters/common.schemas';
import { by } from '../masters/common.service';
import { newCourseBody, newFaqBody, saveLandingBody, updateCourseBody, updateFaqBody } from './cms.schemas';
import { cmsService } from './cms.service';
import { LOGO_FIELD, logoImage, receiveLogo, uploadedLogo } from './logo';

/*
 * The public landing page reads GET /landing without signing in, from its own address: those two answers may be read by
 * any origin (they hold only what the page shows anyway) and the logo may be drawn on any page. Everything under /manage
 * is the panel's Manage → CMS: any panel user reads it, an ADMIN changes it.
 */
const anyOrigin = (res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
};

export const landingApi = new Api('Landing page');

landingApi.get(
  '/landing',
  {
    auth: 'public',
    summary: 'What the landing page shows: its texts and switches, the shown courses and FAQs in order, the logo',
    returns: 'Landing { content, courses[], faqs[], logo: { path, version } | null, updated_at }',
  },
  async ({ res }) => {
    anyOrigin(res);
    res.setHeader('Cache-Control', 'public, max-age=60');
    ok(res, await cmsService.publicPage());
  },
);

landingApi.get(
  '/landing/logo',
  { auth: 'public', summary: "The landing page's logo (its address changes with ?v= when it changes)", file: 'image/*' },
  async ({ req, res }) => {
    const logo = await cmsService.logoFile();
    if (!logo) throw AppError.notFound('There is no logo');
    anyOrigin(res);
    const etag = `"${logo.version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    /* An SVG opened on its own can only be drawn. */
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', logo.mime_type);
    res.setHeader('Content-Length', String(logo.size_bytes));
    res.end(logo.data);
  },
);

export const cmsApi = new Api('CMS: landing page');
const COURSE =
  'Course { id, title, short_title, description, icon, tags[], registration_open, display_order, is_active, updated_at }';
const FAQ = 'Faq { id, question, answer, answer_kind, display_order, is_active, updated_at }';
const LANDING = 'Landing { content, defaults, logo: { mime_type, size_bytes, version, path } | null, updated_at, updated_by }';

cmsApi.get(
  '/manage/cms/landing',
  { auth: 'panel', summary: "The landing page's texts, links, buttons and switches, with the defaults", returns: LANDING },
  async ({ res }) => ok(res, await cmsService.landing()),
);

cmsApi.put(
  '/manage/cms/landing',
  {
    auth: 'admin',
    summary: "Saves the landing page's texts, links, buttons and switches (the whole document)",
    returns: LANDING,
    body: saveLandingBody,
  },
  async (c) => ok(c.res, await cmsService.saveLanding(by(c), c.body.content), 'Landing page saved'),
);

cmsApi.put(
  '/manage/cms/landing/logo',
  {
    auth: 'admin',
    summary: 'Replaces the logo: one PNG, JPG, WebP or SVG of at most 1 MB in the field "logo"',
    returns: 'Logo { mime_type, size_bytes, version, path }',
    multipart: { receive: receiveLogo, description: `One image in the field "${LOGO_FIELD}".` },
  },
  async (c) => ok(c.res, await cmsService.saveLogo(by(c), logoImage(uploadedLogo(c.req))), 'Logo saved'),
);

cmsApi.delete(
  '/manage/cms/landing/logo',
  { auth: 'admin', summary: 'Removes the logo: the page shows its title text instead', returns: 'null' },
  async (c) => {
    await cmsService.removeLogo(by(c));
    ok(c.res, null, 'Logo removed');
  },
);

cmsApi.get(
  '/manage/cms/courses',
  { auth: 'panel', summary: 'Every course of the landing page, also the hidden ones, in order', returns: `${COURSE}[]` },
  async ({ res }) => ok(res, await cmsService.courses()),
);

cmsApi.post(
  '/manage/cms/courses',
  { auth: 'admin', summary: 'Adds a course', returns: COURSE, body: newCourseBody, status: 201 },
  async (c) => created(c.res, await cmsService.createCourse(by(c), c.body), 'Course added'),
);

cmsApi.patch(
  '/manage/cms/courses/:id',
  {
    auth: 'admin',
    summary: 'Changes a course, shows or hides it, opens or closes its registration button',
    returns: COURSE,
    params: idParams,
    notFound: 'Course not found',
    body: updateCourseBody,
  },
  async (c) => ok(c.res, await cmsService.updateCourse(by(c), c.params.id, c.body), 'Course saved'),
);

cmsApi.delete(
  '/manage/cms/courses/:id',
  { auth: 'admin', summary: 'Deletes a course', returns: 'null', params: idParams, notFound: 'Course not found' },
  async (c) => {
    await cmsService.removeCourse(by(c), c.params.id);
    ok(c.res, null, 'Course deleted');
  },
);

cmsApi.get(
  '/manage/cms/faqs',
  { auth: 'panel', summary: 'Every FAQ of the landing page, also the hidden ones, in order', returns: `${FAQ}[]` },
  async ({ res }) => ok(res, await cmsService.faqs()),
);

cmsApi.post(
  '/manage/cms/faqs',
  { auth: 'admin', summary: 'Adds a question', returns: FAQ, body: newFaqBody, status: 201 },
  async (c) => created(c.res, await cmsService.createFaq(by(c), c.body), 'Question added'),
);

cmsApi.patch(
  '/manage/cms/faqs/:id',
  {
    auth: 'admin',
    summary: 'Changes a question or its answer, shows or hides it',
    returns: FAQ,
    params: idParams,
    notFound: 'Question not found',
    body: updateFaqBody,
  },
  async (c) => ok(c.res, await cmsService.updateFaq(by(c), c.params.id, c.body), 'Question saved'),
);

cmsApi.delete(
  '/manage/cms/faqs/:id',
  { auth: 'admin', summary: 'Deletes a question', returns: 'null', params: idParams, notFound: 'Question not found' },
  async (c) => {
    await cmsService.removeFaq(by(c), c.params.id);
    ok(c.res, null, 'Question deleted');
  },
);
