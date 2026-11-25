# ipp_backend

Backend of the **3 Month Internship Placement Program** portal: the student form (sign-up, OTP, three steps, documents, submission) and the
Auditor panel `/manage` (students, document verification, approval, batches, masters, users, settings).

Node.js 20+, TypeScript, Express, PostgreSQL 14+. Plan and analysis: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md),
[docs/analysis](docs/analysis).

## Run locally

1. `npm ci`
2. `cp .env.example .env` and fill it in (database, `SESSION_SECRET`, the two Aadhaar keys; `PANEL_ADMIN_EMAIL` and `PANEL_ADMIN_PASSWORD`
   for the first Auditor account). For the tests: `.env.test` with a database whose name contains `test` and `STORAGE_DIR=storage/test`.
3. `npm run db:create` makes the role and the databases of `.env` / `.env.test` (superuser password in `PGPASSWORD`), once.
4. `npm run db:migrate` and `npm run db:seed` (tables; then states, districts, dropdowns, documents, form fields).
5. `npm run dev` starts the API on port 5101. Documentation: <http://localhost:5101/api/docs>.

The portal uses it with `VITE_API_PROXY_TARGET=http://localhost:5101` in the portal's `.env`.

`STATIC_OTP=666666` in `.env` fixes the OTP on a developer's own machine: no SMS is sent. It works only with `NODE_ENV=development` and
`PORTAL_URL` on localhost; every other environment ignores it.

## Commands

|                                                            |                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev` / `npm run build` / `npm start`              | develop / compile to `dist` / run the compiled server              |
| `npm run typecheck` · `npm run lint` · `npm test`          | checks; the tests run on the database of `.env.test`               |
| `npm run db:status` · `db:migrate` · `db:seed`             | database (`db:migrate:prod`, `db:seed:prod` run the compiled ones) |
| `PANEL_PASSWORD=… npm run panel:admin -- <email> "<name>"` | make a panel ADMIN, or give one a new password                     |
| `npm run import:legacy -- --dry-run` / `-- --yes`          | copy the earlier system's data into an empty database (below)      |

## Layout

```
src/config      environment                     src/program   the program's rules (masters, form, approval, checks, filters)
src/http        endpoints, guards, errors       src/modules   student · panel · masters · health
src/lib         tokens, passwords, Aadhaar, …   src/import    copy of the earlier system's data
src/db          pool, migrations, seeds         src/services  storage, SMS, e-mail, audit
```

Every endpoint is declared once with `Api` (`src/http/api.ts`): who may call it, what it accepts, its handler. The routes and the
documentation come from the same declaration. A change of the database is a new file in `src/db/migrations` (a file that has been run must
not be edited).

## Roles

|                           |                                                                 |
| ------------------------- | --------------------------------------------------------------- |
| Student                   | own form and documents only; a submitted form cannot be changed |
| Panel ADMIN (the Auditor) | everything in the panel                                         |
| Panel VIEWER              | views and downloads; every change is refused (403)              |

Approval: every document verified → approved by the Auditor → in a batch (exactly the batch size, one district) → with the Divisional
Officer. The officers' part (Divisional Officer, COEP, Head Office, Admin) is not in this backend yet; its stages are stored from the start.

## Security notes

- Checks an ADMIN writes for own fields (regular expressions, JavaScript functions) run in a sandbox (`src/program/sandbox.ts`): no access to
  this server, 4 MB of memory, 50 ms.
- `npm audit` names zod 3 (memory while validating oversized collections). Requests are limited to 100 kB of JSON before they are validated,
  so it cannot be used here; zod 4 changes every message definition and is a step of its own.
- `npm ci` may skip install scripts (npm 11): bcrypt brings its prebuilt binaries, nothing needs to be built.

## Deploy

1. PostgreSQL role and database; `.env` with `NODE_ENV=production`, `PORTAL_URL` and `CORS_ORIGINS` of the portal's domain, real secrets,
   SMS and SMTP settings, storage. `TRUST_PROXY` = the number of reverse proxies in front.
2. `npm ci && npm run build && npm run db:migrate:prod && npm run db:seed:prod`
3. Run `node dist/server.js` under a process manager (PM2, systemd). It starts only when no migration is pending and stops cleanly on SIGTERM.
4. nginx: proxy `/api/` to the port, `client_max_body_size 120m` (videos up to 50 MB), `proxy_read_timeout 300s` for ZIP downloads,
   `X-Forwarded-For` and `X-Forwarded-Proto`.
5. Checks: `GET /api/v1/health` (process) and `GET /api/v1/health/ready` (process and database).

Back up the database **and** the two Aadhaar keys: without the keys the stored numbers cannot be read or matched.

Files in S3: `STORAGE_DRIVER=s3`, `AWS_REGION`, `AWS_BUCKET_NAME` (private bucket; block all public access). Without access keys the server's
instance role is used; it needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the bucket's objects and `s3:ListBucket` on the bucket.

## Copying the earlier system's data

Into an empty database (migrated and seeded, no students): put the `LEGACY_*` settings into `.env.legacy` (never committed):

```
LEGACY_DB_HOST=
LEGACY_DB_PORT=5432
LEGACY_DB_USER=
LEGACY_DB_PASSWORD=
LEGACY_DB_NAME=
# the earlier system's STUDENT_DATA_KEY
LEGACY_DATA_KEY=
# local + LEGACY_STORAGE_DIR, or s3 + LEGACY_AWS_REGION, LEGACY_AWS_BUCKET_NAME, LEGACY_AWS_KEY_PREFIX
LEGACY_STORAGE_DRIVER=local
LEGACY_STORAGE_DIR=
```

The earlier database is only read. `--dry-run` shows the numbers and everything that cannot be copied (for example a
form without a valid Aadhaar number, a file that is missing) and keeps nothing. `--yes` copies in one transaction: students (same password),
forms, files, document checks, approvals, batches, follow-ups, masters, panel users, settings.
