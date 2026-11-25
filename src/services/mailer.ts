import crypto from 'node:crypto';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../config';
import { env } from '../config/env';
import { AppError } from '../http/errors';
import { today } from '../lib/dates';
import { logger } from '../lib/logger';
import { ORGANISATION, PROGRAM_TITLE } from '../program/constants';
import { supportForStudents, type SupportValue } from '../program/settings';

const unavailable = () =>
  AppError.unavailable('Email could not be sent right now. Please try again in a few minutes.', 'EMAIL_UNAVAILABLE');
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* The logo goes inside the e-mail (cid): inline images show without the "load images" prompt that remote ones get. */
const LOGO = { path: path.join(__dirname, '..', 'assets', 'sumago-logo-96.png'), cid: 'sumago-logo@ipp' } as const;
/* The sender's display name when SMTP_FROM is not set: a bare address is a strong spam signal. */
const SENDER_NAME = `${PROGRAM_TITLE} – Sumago Infotech`;
/* A mail server that does not answer must not keep the student waiting for minutes. */
const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

/* The portal's colours. E-mail clients drop <style>, so every colour is inline. */
const P = {
  page: '#f7f1ea',
  card: '#ffffff',
  border: '#ead9c6',
  header: '#ffffff',
  rule: '#e88c2c',
  maroon: '#a63f17',
  text: '#2f2419',
  muted: '#77685b',
  noteBg: '#fff8ec',
  noteBorder: '#f1c98a',
  footBg: '#fbf7f2',
} as const;
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "'Segoe UI',Arial,Helvetica,sans-serif";

/* The footer's help line: the support message, with the e-mail and the mobile number as links. */
function supportLine({ message, email, mobile }: SupportValue): string {
  if (!message.trim() && !email && !mobile) return '';
  const mail = email
    ? `<a href="mailto:${escapeHtml(email)}" style="color:${P.maroon};text-decoration:underline">${escapeHtml(email)}</a>`
    : '';
  const phone = mobile
    ? `<a href="tel:${escapeHtml(mobile.replace(/[^\d+]/g, ''))}" style="color:${P.maroon};text-decoration:none"><b>${escapeHtml(mobile)}</b></a>`
    : '';
  const given = [mail, phone].filter(Boolean);
  if (!message.trim()) return `<p style="margin:0 0 8px">Need help? ${given.join(' or ')}.</p>`;
  const html = escapeHtml(message.trim())
    .replace(/\{email\}/g, () => mail)
    .replace(/\{mobile\}/g, () => phone);
  const extra = [!message.includes('{email}') && mail, !message.includes('{mobile}') && phone].filter(Boolean);
  return `<p style="margin:0 0 8px">${html}${extra.length ? ` ${extra.join(' / ')}` : ''}</p>`;
}

/*
 * The frame of every e-mail: a hidden preview line, the header (logo, program, organisation), the body rows, and the footer.
 * Built for e-mail clients: tables and inline styles only, a white header (the logo shows on its own white background, also
 * in dark mode), a fixed 560px table for Outlook on Windows (which ignores max-width), and padding for a 320px phone.
 */
function frame(title: string, preview: string, bodyRows: string, support: SupportValue): string {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${P.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${P.page}">${escapeHtml(preview)}&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${P.page}" style="background:${P.page}">
  <tr><td align="center" style="padding:24px 10px">
    <!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${P.card};border:1px solid ${P.border};border-radius:14px;font-family:${SANS};color:${P.text}">
      <tr><td bgcolor="${P.header}" style="background:${P.header};border-bottom:3px solid ${P.rule};border-radius:14px 14px 0 0;padding:20px 24px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="48" valign="middle" style="width:48px"><img src="cid:${LOGO.cid}" width="48" height="48" alt="Sumago Infotech" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none"></td>
          <td valign="middle" style="padding-left:14px">
            <div style="font-family:${SERIF};font-size:18px;font-weight:bold;color:${P.maroon};line-height:1.25">${PROGRAM_TITLE}</div>
            <div style="font-family:${SANS};font-size:13px;color:${P.muted};margin-top:3px">by ${ORGANISATION}</div>
          </td>
        </tr></table>
      </td></tr>
${bodyRows}
      <tr><td bgcolor="${P.footBg}" style="background:${P.footBg};border-top:1px solid ${P.border};border-radius:0 0 14px 14px;padding:18px 24px;font-size:12px;line-height:1.6;color:${P.muted}">
        ${supportLine(support)}
        <p style="margin:0 0 8px">This is an automated email from the ${PROGRAM_TITLE} portal.</p>
        <p style="margin:0">&copy; ${today().slice(0, 4)} ${ORGANISATION}</p>
      </td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}

/* A highlighted security note. */
const note = (html: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr>
          <td bgcolor="${P.noteBg}" style="background:${P.noteBg};border-left:4px solid ${P.noteBorder};border-radius:6px;padding:12px 14px;font-size:13px;line-height:1.5;color:${P.text}">${html}</td>
        </tr></table>`;

/*
 * Subject, plain text and HTML of the "Forgot password" e-mail. `link` carries the one-time token. The HTML has one button
 * and no link written out; the button is a VML shape for Outlook on Windows (which ignores padding on links, so only the
 * words would be clickable) and a padded link everywhere else. The plain text has no button, so it carries the link.
 */
function passwordResetEmail(name: string, link: string, minutes: number, support: SupportValue) {
  const href = escapeHtml(link);
  const subject = `Reset your password – ${PROGRAM_TITLE}`;
  const text = [
    `Dear ${name},`,
    '',
    `We received a request to reset the password of your ${PROGRAM_TITLE} account (${ORGANISATION}).`,
    'To set a new password, open this link:',
    '',
    link,
    '',
    `This link is valid for ${minutes} minutes and can be used once.`,
    '',
    PROGRAM_TITLE,
    ORGANISATION,
  ].join('\n');
  const html = frame(
    subject,
    `Set a new password for your account. The link is valid for ${minutes} minutes.`,
    `      <tr><td style="padding:28px 24px 10px;font-size:15px;line-height:1.6">
        <h1 style="margin:0 0 16px;font-family:${SERIF};font-size:22px;line-height:1.3;color:${P.text}">Reset your password</h1>
        <p style="margin:0 0 12px">Dear ${escapeHtml(name)},</p>
        <p style="margin:0 0 20px">We received a request to reset the password of your <b>${PROGRAM_TITLE}</b> account. To set a new password, click the button below.</p>
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 18px"><tr>
          <td align="center" bgcolor="${P.maroon}" style="background:${P.maroon};border-radius:8px">
            <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:210px" arcsize="17%" stroke="f" fillcolor="${P.maroon}"><w:anchorlock/><center style="color:#ffffff;font-family:${SANS};font-size:15px;font-weight:bold">Reset password</center></v:roundrect><![endif]-->
            <!--[if !mso]><!--><a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 32px;font-family:${SANS};font-size:15px;font-weight:bold;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;border:1px solid ${P.maroon};background:${P.maroon}">Reset password</a><!--<![endif]-->
          </td>
        </tr></table>
        <p style="margin:0 0 22px;text-align:center;font-size:13px;color:${P.muted}">This link is valid for <b style="color:${P.maroon}">${minutes} minutes</b> and can be used once.</p>
        ${note('If you did not ask to reset your password, your password has not been changed and no action is needed.')}
      </td></tr>`,
    support,
  );
  return { subject, text, html };
}

/* The mail server's answer may hold the recipient's address: only what kind of failure it was is logged. */
const failure = (err: unknown) => {
  const { code, command, responseCode } = (err ?? {}) as { code?: string; command?: string; responseCode?: number };
  return { code, command, responseCode };
};

/*
 * E-mails the link to the portal's page for a new password, through the SMTP server (SMTP_*). Without one, a development or
 * test run writes the link to the log, so the flow can be tried locally; any other environment refuses (503).
 */
async function sendPasswordReset(to: string, name: string, link: string, minutes: number): Promise<void> {
  const { host, port, secure, user, pass } = config.smtp;
  if (!host) {
    if (!env.isLocal) {
      logger.error('password reset e-mail NOT sent: SMTP_HOST is not set');
      throw unavailable();
    }
    logger.warn({ link }, 'password reset e-mail NOT sent: SMTP_HOST is not set (development only, logged instead)');
    return;
  }
  const support = await supportForStudents();
  try {
    await nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined, ...TIMEOUTS }).sendMail({
      from: env.SMTP_FROM ?? { name: SENDER_NAME, address: user ?? '' },
      /* Replies reach the support team when one is set. */
      ...(support.email ? { replyTo: support.email } : {}),
      to,
      ...passwordResetEmail(name, link, minutes, support),
      /* Each e-mail its own thread in Gmail. */
      headers: { 'X-Entity-Ref-ID': crypto.randomUUID() },
      attachments: [{ filename: 'sumago-logo.png', path: LOGO.path, cid: LOGO.cid, contentDisposition: 'inline' }],
    });
  } catch (err) {
    logger.error(failure(err), 'password reset e-mail could not be sent');
    throw unavailable();
  }
}

export const mailer = { sendPasswordReset };
