# Implementation plan: backend of the 3 Month Internship Placement Program portal

Analysis (what the frontend needs, page by page): `docs/analysis/01-student-portal.md`, `02-auditor-panel.md`, `03-masters-and-gaps.md`.
This file says how the backend is built, and what was decided where the analysis left a question.

## 1. Scope

| In | Not in (later) |
|---|---|
| Student portal (`/login` … `/application`), Auditor panel (`/manage`), every master, batches | Officers' approval (Divisional Officer, COEP, Head Office, Admin), today in the admin panel (5174). The stages, events and constraints are stored from the start |
| The 5174 masters and batch data the program needs, also in the 5176 frontend: **States**, **Talukas**, center delete, batch code / dates / delivery mode / technology | Other programmes' masters (departments, colleges, training centres, LMS, …) |
| A database of its own, starting with the masters only | – |
| A command that copies students, files and masters of the old system later (`npm run import:legacy`) | – |

The portal runs unchanged on it: same paths (`/api/v1/edp/...`), same answers, same error codes and messages. The same API is also
served under `/api/v1/ipp/...`.

## 2. Architecture

```
src/
  config/        environment (checked at start), settings
  http/          api.ts (one declaration = route + documentation), auth guards, errors, answers, uploads, limits
  lib/           tokens, passwords, Aadhaar, dates (Asia/Kolkata), text rules, paging, file types
  db/            pool, transactions, numbered SQL migrations, seeds
  services/      storage (local / S3), SMS, e-mail, audit log
  program/       the program's own rules, used by every module: masters, form check, approval, document checks, filters
  modules/
    health/
    student/     accounts (sign-up, OTP, sign-in, reset), options, application (steps, documents, submission)
    panel/       sign-in, users, students, approval, document checks, edits, follow-ups, files, batches, settings
    masters/     dropdown lists, technologies, documents, fields, states, districts, talukas, centers, geography
```

A module is split into `*.routes.ts` (endpoints: who, what is accepted, answer), `*.schemas.ts` (zod), `*.service.ts` (rules,
transactions, audit) and, where the SQL is long, `*.repository.ts`. Modules never import each other; what two need is in `program/`.

Stack: Node 20+, TypeScript (strict), Express, PostgreSQL (`pg`, parameterised SQL only), zod, JWT, bcrypt, multer, nodemailer, S3 SDK,
pino, vitest + supertest. Port 5101.

## 3. Database (`src/db/migrations/0001_schema.sql`)

| Table | Holds |
|---|---|
| `student_accounts` | sign-in, OTP, reset link, failed sign-ins |
| `panel_users` | Auditor panel accounts (ADMIN, VIEWER) |
| `applications` | one form per account: values (`data`), encrypted Aadhaar + blind index, steps, submission, approval stage, batch |
| `application_files`, `document_checks` | uploaded documents, and the Auditor's check of each (gone with its file) |
| `approval_events`, `application_edits`, `audit_logs` | append-only history (a trigger refuses changes) |
| `follow_ups` | calls to students |
| `batches` | code, name, district, center, size, dates, delivery mode, technology |
| `states` → `districts` → `talukas`, `centres` | geography and Center Master |
| `program_options`, `district_technologies`, `program_documents`, `program_fields` | dropdowns, technologies per district, documents, form fields |
| `settings` | batch size, support, welcome, help |

Constraints keep impossible states out (a draft with a stage, a stage past BATCH without a batch, a submitted form without its Aadhaar
index, two submitted forms of one Aadhaar, a deleted master that is active, …). `district_id`, `caste_id` and `centre_id` of a form are
generated columns, so the filters never differ from the form.

## 4. Endpoints (83)

| Module | Endpoints |
|---|---|
| Student (16) | `POST /auth/register, verify-otp, resend-otp, otp-status, login, forgot-password, reset-password/check, reset-password` · `GET /options, /me, /application` · `PUT /application/steps/:step` · `POST /application/documents` · `DELETE` and `GET …/documents/:docType[/file]` · `POST /application/submit` |
| Panel (30) | E1–E30 of analysis 02 (a) |
| Masters (24 + 3) | 1–24 of analysis 03 A (lists, technologies, documents, fields, districts, centers) and `GET /geography/states[/…]` (3) |
| New (10) | `POST /manage/fields/test-validation` · `DELETE /manage/centres/:id` · `GET/POST/PATCH/DELETE /manage/states[/:id]` · the same for `/manage/talukas[/:id]`; new keys on the batch endpoints |
| Service | `GET /api/v1/health`, `/health/ready`, `/api/docs`, `/api/openapi.json` |

## 5. Security

- Sessions: signed tokens, 12 h, a key per audience (a student's token never works in the panel); a password change ends every session;
  roles are read from the database on every request (a role change or deactivation works at once).
- Passwords: bcrypt; the same time for a known and an unknown account; after 10 wrong passwords in 15 minutes an account waits (429).
- OTP and reset tokens: only an HMAC is stored; 5 tries, counted before comparing; per account: 10 OTPs / hour, 5 links / hour; used once.
- Aadhaar: AES-256-GCM, blind index for uniqueness, only the last four digits shown after submission, never in logs or the form's JSON.
- Files: type by content **and** extension, size per document, private storage, only through the API to their owner or the panel,
  `nosniff` and a strict CSP on previews.
- Requests: zod on everything (unknown keys refused), 100 kB JSON, rate limits per client, CORS only for the portal, helmet, request ids,
  no SQL / stack traces in answers, no personal data in logs or the audit log.
- Audit: every change of a panel user and every sign-up / reset / submission, in the same transaction as the change.

## 6. Decisions on the open points

| # | Point | Decision |
|---|---|---|
| 1 | Verified documents changed after approval (02 g-2) | A batch can only be made of forms whose documents are all verified at that moment (409 names how many are not) |
| 2 | Form's mobile / name edited by the Auditor (g-4, g-5) | The account's follow (first name, last name, mobile), so lists, search and calls match |
| 3 | `approval` of a draft (g-7) | `null` in E5 and E6 |
| 4 | Malformed ids (g-8) | 404 |
| 5 | Duplicate batch name (g-9) | 409 with `details: [{ field: 'body.name' }]` |
| 6 | Center's district in a batch (g-12, 03 Q6) | Not checked (as today); the dialog says how many students chose another center |
| 7 | Centers list for the batch dialog (g-13) | The API accepts `limit` up to 100 as today; the dialog searches on the server |
| 8 | `last_activity_at` (g-15) | The student's own last activity: account made, verified, sign-in, or a change of the form |
| 9 | `uploaded_at` (g-16) | When the file was uploaded; submission does not change it |
| 10 | Last ADMIN (g-19) | One active ADMIN always remains (checked under a lock) |
| 11 | Rate limit (g-24) | 600 / 15 min per client, 30 for sign-in and OTP |
| 12 | Autosave | `complete: false` never fails on content: unknown and switched-off keys are ignored, wrong values are stored as typed |
| 13 | Dates | "Today" is the date in Asia/Kolkata |
| 14 | Declaration (01 F-10) | The time of acceptance is stored |
| 15 | Longest names of masters (03 Q2) | 150 everywhere (states, districts, talukas 100) |
| 16 | Delete guards (03 Q7) | state ← districts; district ← talukas, centers, students' forms, batches; taluka ← centers; center ← students' forms, batches. 409 says what holds it and to deactivate instead |
| 17 | `HSC_DIPLOMA` (03 Q4) | Seeded switched off, as the portal shows it today; Masters → Documents switches it on |
| 18 | Course District (03 Q3) | Stays its own list (no frontend change) |
| 19 | Castes, religions (03 Q8, Q9) | Seeded as today; the Auditor adds more in Masters |
| 20 | `/geography` (03 Q10) | Public, as the frontend calls it |
| 21 | Batch fields (03 Q5) | All optional; end after start; delivery mode Offline by default; code `IPP-B-0001`; no cancel |
| 22 | Last active choice of a required dropdown (03 Q11) | Allowed, as today |
| 23 | Two editors of one form (g-25) | The edit compares with the stored values under a row lock; only changed fields are written |
| 24 | E-mail of a student | Cannot be changed (as today) |

## 7. Own fields: types and checks (added on request)

An own field (Masters → Form fields) is one of 15 types: text, long text, email, mobile number, web address, number, date, time, month and
year, year, dropdown, radio buttons, checkboxes (several answers), yes / no, tick box (declaration). It can have ready-made checks with their
limits (characters, value, digits, date, age, time, number of choices, letters only, PAN, …) and up to five checks of its own, each a regular
expression or a JavaScript function with its own message in both languages.

Own checks run only on the server, in QuickJS (WebAssembly): no files, network, environment or database, 4 MB of memory, 50 ms; a runaway
expression or function is cut off and the answer is then not accepted. A function's source never leaves the server; an expression is also
checked in the student's browser. Checks are compiled and tried when they are saved, and can be tried on a value before that.

## 8. Steps

1. Foundation, schema, seeds, shared rules, test helpers.
2. Student module · Panel module · Masters module (in parallel, each with its tests).
3. Frontend 5176: States and Talukas pages, center delete / filter, batch fields (existing style, with tests).
4. Whole-workflow tests through the API (sign-up → submission → verification → approval → batch), contract check against the portal's types.
5. Import command, README and deployment notes.
6. Portal connected (`VITE_API_PROXY_TARGET=http://localhost:5101`), checked in the browser page by page.

Done means: every endpoint of section 4 answers as the analysis says, the portal's own tests pass unchanged, lint / typecheck / tests are
green, and each page of 5176 works in the browser on the new backend.
