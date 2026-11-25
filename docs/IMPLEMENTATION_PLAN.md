# Implementation plan: backend of the 3 Month Internship Placement Program portal

Analysis (what the frontend needs, page by page): `docs/analysis/01-student-portal.md`, `02-auditor-panel.md`, `03-masters-and-gaps.md`.
This file says how the backend is built, and what was decided where the analysis left a question.

## 1. Scope

| In | Not in (later) |
|---|---|
| Student portal (`/login` … `/application`), Auditor panel (`/manage`), every master, batches | Officers' approval (Divisional Officer, COEP, Head Office, Super Admin): in Sarthi, linked by `docs/SARTHI_LINK.md` (section 8) |
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
| `settings` | batch size, support, welcome, help (`districts.batch_size` = a district's own batch size) |
| `link_outbox`, `link_inbound` | messages to Sarthi; its decisions that are done |

Constraints keep impossible states out (a draft with a stage, a stage past BATCH without a batch, a submitted form with a part of its Aadhaar
only, two submitted forms of one Aadhaar, a deleted master that is active, …). `district_id`, `caste_id` and `centre_id` of a form are
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

### No field is fixed (25 Nov 2026, on request; replaces the "core" fields of analysis 01 and 03)

Each of the program's 36 fields is changed like an own field: labels, help texts, order, step, required, on / off, checks and type. They are not
deleted (off does the same and can be undone). Which types a field can have (`src/program/built-in.ts`, sent as `types`):

- name, mobile number, e-mail (the account has the same), Aadhaar number (stored apart) and Person with Disability: only their own;
- a field of a list of the Masters, districts or centers: dropdown or radio buttons;
- any other: all 15. Given another type than it comes with, it is checked by that type alone (`by_type`), with choices of its own.

What the rest of the program does without a field's value: the account's name and mobile number are used; a form without an Aadhaar number has no
index, so a second form of the same person is not noticed; while District is off or optional, a batch of students without one is of its center's
district; every technology is offered without a district.

## 8. The officers' approval in Sarthi (25 Nov 2026, on request)

The officers decide in Sarthi (`sarthi-api`, `sarthi-admin`); the contract of the two servers is `docs/SARTHI_LINK.md`.

- **Outbox.** A new or changed batch, a student approved again after being sent back, and a correction of a student in a batch each add a row to
  `link_outbox` in the transaction of the change. `seq` is the order of the changes within a batch: the batch's row is locked while one is added
  (after the applications, several batches in one order). What a message says is read when it is sent, so a late message is never old.
- **Worker** (`program/link/worker.ts`): the first message of each batch that is not sent; one after the other; one worker at a time (session
  lock); 15 s polling and a kick after each commit. Retries and FAILED as in the contract. A message that cannot be made is tried again too.
- **Inbound** (`modules/link`): signature over the raw body before it is understood, own rate limit, each decision in its own transaction under
  the application's row lock, done once per id. Only the moves of the contract, only from the stage the form is at. `SUPER_ADMIN` there is
  stage `ADMIN` here. The event has the officer's name, role and time; nothing of it goes to the audit log.
- **Batch size per district**: `districts.batch_size`, else the default. It is checked after the students' district is known.
- The browser never calls the other system, and the two share no login and no database.

## 9. Steps

1. Foundation, schema, seeds, shared rules, test helpers.
2. Student module · Panel module · Masters module (in parallel, each with its tests).
3. Frontend 5176: States and Talukas pages, center delete / filter, batch fields (existing style, with tests).
4. Whole-workflow tests through the API (sign-up → submission → verification → approval → batch), contract check against the portal's types.
5. Import command, README and deployment notes.
6. Portal connected (`VITE_API_PROXY_TARGET=http://localhost:5101`), checked in the browser page by page.

Done means: every endpoint of section 4 answers as the analysis says, the portal's own tests pass unchanged, lint / typecheck / tests are
green, and each page of 5176 works in the browser on the new backend.
