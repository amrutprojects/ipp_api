# 02 – Auditor panel (`/manage`)

Specification for the backend of the tracking panel used by the Auditor: sign-in, student list, one student, document
verification, approval, Edit form, batches, follow-ups, settings and panel users.

**Sources (read-only analysis).** Frontend `D:\Sarthi\EDP-Candidates-Registration` at commit `4a5d910` (25 Nov 2026):
`src/pages/manage/*` (without `masters/` and `Centre*`), `src/api.ts`, `src/session.tsx`, `src/types.ts`, `src/form.ts`,
`src/validation.ts`, `src/components/*`, and the tests `approval`, `manage`, `batches`, `applicant-detail`, `edit-form`,
`student-filters`, `settings`, `users`, `validation*`. Server behaviour: `D:\Sarthi\amrut-kalash-api` at commit `d9f3638`,
`src/modules/students/edp`, its migrations and `tests/e2e/edp-portal.e2e.test.ts` (the uncommitted work there is OTP-only
and does not touch this part).

**Not here.** Masters pages and Center Master (other document); the student portal and the form's masters (other document).
Two endpoints of those parts are used by these pages and are listed as S1 and S2.

**How to read it.** "Today" = what the current API does; unless section (g) says otherwise it is the contract to keep.
"Recommended" = not in the current API. Endpoint numbers (E1…E30) point to section 5.

---

## 1. Conventions

### 1.1 Addressing

- Base = `${VITE_API_BASE_URL}` (default `/api/v1`, trailing slash removed) + **`/edp`** (hard-coded in `src/api.ts`). So the
  backend must answer at `<base>/edp/...`, e.g. `/api/v1/edp/manage/me`. All paths below are relative to `/api/v1/edp`.
- Same origin by default. If the API is on another origin: allow the portal origin, the methods
  GET POST PUT PATCH DELETE OPTIONS, the request headers `Authorization, Content-Type, Accept`, and **expose
  `Content-Disposition`** (see g-1), otherwise downloads get the fallback name.
- Requests are JSON (`Content-Type: application/json`), except E13 (multipart). E7 is a POST **without a body**.
- Empty or undefined query values are never sent by the pages; the server must still treat a blank value as "not given".

### 1.2 Response envelope

```ts
interface Success<T> { success: true; status: number; message: string; data: T; meta?: PageMeta & Record<string, unknown> }
interface Failure    { success: false; status: number; message: string; data: null;
                       error: { code: string; details?: { field?: string; message: string }[]; requestId?: string } }
interface PageMeta   { page: number; limit: number; total: number; totalPages: number }   // totalPages >= 1 ALWAYS (see 1.7)
```

The pages read `data`, `meta`, `message`, `error.code`, `error.details[].field`, `error.details[].message`. A body that is not
JSON is tolerated (message becomes `Request failed (<status>)`).

### 1.3 Errors

| HTTP | `error.code` | When | What the pages do |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | malformed JSON, multipart error | show `message` |
| 401 | `UNAUTHORIZED` | no / expired / foreign token, inactive or deleted account | token removed from the browser, user sent to `/manage/login` (any JSON call; not file downloads). On E1: login error |
| 403 | `FORBIDDEN` | a VIEWER calls a change endpoint: `Your account can only view. Ask an administrator to make this change.` | show `message` in place |
| 404 | `NOT_FOUND` | unknown or deleted student, batch, user, file | student page: "This student was not found."; elsewhere `message` |
| 409 | `CONFLICT` | the state does not allow it, duplicate name / email | show `message` in place |
| 413 | `PAYLOAD_TOO_LARGE` | body too large (JSON limit today 100 kB) | show `message` |
| 422 | `VALIDATION_ERROR` | `message` "Validation failed", one `details` entry per problem | field errors at their boxes |
| 429 | `RATE_LIMITED` | limits of 1.8 | login page: "Too many attempts…"; elsewhere `message` |
| 500 / 503 | `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` | never with SQL, stack or config in it | show `message` |
| 0 | `NETWORK` (made by the client) | no connection | "Could not reach the server. Check your internet connection and try again." |

- `details[].field` = `body.<key>`, `body.data.<key>`, `query.<key>`, `params.<key>` or `files.<DOC_CODE>`. The client removes
  a leading `body.` or `body.data.`, nothing else; the **first** message per field wins. Nested: `body.fields.0.label`.
- Outside the login page the pages never look at `error.code`, only at the HTTP status, `message` and `details`.
- Request bodies are strict today: an unknown key is a 422 (field `body`). Unknown query parameters are ignored.
- Order of checks today: token (401) → role (403) → shape (422) → state (404 / 409 / 422).
- Text is trimmed. Control characters (except tab, CR, LF) are refused with 422 (`… contains characters that cannot be saved`),
  never a 500 from the database.

### 1.4 Sign-in and session

- Bearer token in `localStorage` key `edp.manage.token` (the student portal uses `edp.token`: a separate sign-in). Sent as
  `Authorization: Bearer <token>` on every call with realm `manage`.
- Today: JWT HS256, own signing key and audience (`edp-admin`), subject = account id, 12 h (`EDP_SESSION_HOURS`), no refresh,
  no server-side session. A student token is refused here and the reverse (401).
- On a page load with a token: E2. Any failure of E2 → treated as signed out (the token is removed only on 401).
- Logout is local only (token removed; other tabs of the browser follow). No server call.
- The account is read from the database on **every** request (active, not deleted, current role), so deactivation and role
  changes apply at the next request. The page itself keeps the role it got from E1/E2 until it is reloaded.

### 1.5 Roles

Two kinds of panel account. **ADMIN = the Auditor** (may change things). **VIEWER** = may only view and download. UI text:
`Admin` / `Viewer`.

| | ADMIN | VIEWER |
| --- | --- | --- |
| Student list, filters, search, tiles, paging, Refresh | yes | yes |
| Checkboxes, "Approve selected", "Waiting for a batch" button, "Create batch", batch bar, Approve buttons, "First verify all documents…" | yes | **not shown** (`GET /manage/settings/batch` is not called by the list) |
| Student page: form, documents, approvals, changes, follow-ups | yes | yes |
| View / Download a document, Download all (ZIP) | yes | yes |
| Verify / Undo a document | yes | not shown (sees Verified / Not verified, who, when) |
| Approve, Edit form | yes | not shown; `/manage/applicants/:id/edit` redirects to `/manage` |
| Follow-up icon | "Add a follow-up" | opens the history only ("Follow-up history") |
| Batches list, one batch, member histories | yes | yes |
| Batch details form (name, centre) | yes | not shown |
| Settings page | edit + Save | values read-only + "View only: your account can see these settings but not change them."; no Save / Reset |
| Users, Add user | yes | nav link not shown; `/manage/users`, `/manage/users/new` redirect to `/manage`; E28–E30 answer 403 (also the GET) |
| Header | – | badge "View only" beside the email |

Hiding is cosmetic: the server must enforce every row (403 for a VIEWER on E7, E8, E9, E12, E13, E15, E17, E19, E21, E23, E25,
E27, E28, E29, E30). A VIEWER sees email and mobile in full; the Aadhaar is masked for everyone.

### 1.6 Ids, dates, masking

- Every `:id` under `/manage/applicants` is the **student account id** (UUID), also in `ids` of E8 and E17. Batch, user, centre,
  district, caste ids are UUIDs.
- Timestamps: ISO 8601 with zone (UTC `Z`); the panel prints them in the browser's zone as `25 Nov 2026, 03:30 pm`.
- Aadhaar: never sent in full; `aadhaar_masked` = `XXXX-XXXX-1234`; `form.aadhaar_number` and the view field's `value` are `''`.

### 1.7 Paging

`page` (≥1, default 1), `limit` (1–100, default 10; the pages send 25). `totalPages = max(1, ceil(total / limit))`. The list
page jumps to `totalPages` when `meta.page > meta.totalPages`; a `totalPages` of 0 would make it request `page=0` forever.
A page beyond the end answers 200 with `data: []` and the real `totalPages`.

### 1.8 Rate limits (today)

Whole API 300 requests / 15 min / IP; sign-up, OTP and both sign-ins together 30 / 15 min / IP. The list makes 2 requests per
filter change, so several people behind one office address can meet the first limit (g-24).

---

## 2. Codes and labels

### 2.1 How far the form got (`stage`), first match wins

| Code | Condition | `stage_label` and tile label (from the server) | Label in the "Stage of application" filter (E4) | Badge on the student page (fixed in the frontend) |
| --- | --- | --- | --- | --- |
| `OTP_PENDING` | OTP not verified | Account created – OTP not verified | OTP pending | OTP pending |
| `SUBMITTED` | application status SUBMITTED | Form submitted | – (split into the codes of 2.2) | Submitted |
| `MAIN_DONE` | step 2 completed | Step 2 filled (Main Form) | Step 2 filled | Step 2 filled (Main Form) |
| `BASIC_DONE` | step 1 completed | Step 1 filled (Basic Details) | Step 1 filled | Step 1 filled (Basic Details) |
| `VERIFIED` | otherwise | OTP verified – form not started | Account verified | OTP verified |

### 2.2 Whom a submitted form is with

Stored as the application's approval stage; **no value = with the Auditor**.

| Filter code (`application_stage`) | Stored stage | Filter label | `approval.stage_label` | Name in events (`from.name`, `to.name`) | Count in E3 `approvals` |
| --- | --- | --- | --- | --- | --- |
| `AUDITOR` | none | Submitted: with the Auditor | `null` | Auditor (code `AUDITOR`) | `AWAITING` |
| `RETURNED` (part of AUDITOR) | none, latest event is a rejection | Sent back to the Auditor | `null` | – | `RETURNED` |
| `BATCH` | BATCH | Approved: waiting for a batch | same | Batch | `BATCH` |
| `DIVISION` | DIVISION | With Divisional Officer | same | Divisional Officer | `DIVISION` |
| `COEP` | COEP | With COEP | same | COEP | `COEP` |
| `HEAD_OFFICE` | HEAD_OFFICE | With Head Office | same | Head Office | `HEAD_OFFICE` |
| `ADMIN` | ADMIN | With Admin (final approval) | same | Admin | `ADMIN` |
| `APPROVED` | APPROVED | Final approved | same | Final approval | `APPROVED` |

### 2.3 Follow-up statuses (in this order)

`PENDING` Pending follow-up · `CALLED` Follow-up call · `SECOND_CALL` Second follow-up · `FORM_FILLED` Form filled ·
filter only: `NONE` Not followed up yet. Labels are fixed in the frontend for the dropdowns; the history shows the server's
`status_label`.

---

## 3. Types

`// unread` = sent today but no page of this part reads it.

```ts
type UUID = string; type ISO = string;
type ManageRole = 'ADMIN' | 'VIEWER';
type Stage = 'OTP_PENDING' | 'VERIFIED' | 'BASIC_DONE' | 'MAIN_DONE' | 'SUBMITTED';
type ApprovalStage = 'BATCH' | 'DIVISION' | 'COEP' | 'HEAD_OFFICE' | 'ADMIN' | 'APPROVED';
type StagePoint = 'AUDITOR' | ApprovalStage;
type ApplicationStage = 'OTP_PENDING' | 'VERIFIED' | 'BASIC_DONE' | 'MAIN_DONE' | 'AUDITOR' | 'RETURNED' | ApprovalStage;
type FollowUpStatus = 'PENDING' | 'CALLED' | 'SECOND_CALL' | 'FORM_FILLED';

interface Admin { id: UUID; name: string; email: string; role: ManageRole }

interface FollowUp { status: FollowUpStatus; status_label: string; note: string | null; at: ISO; by: string | null /* name of who recorded it */ }

interface ApprovalEvent {
  action: 'APPROVE' | 'REJECT';
  from: { stage: StagePoint; name: string };
  to: { stage: StagePoint; name: string };
  reason: string | null;            // a rejection always has one
  by: string | null;                // name of the panel account or officer
  at: ISO;
}

interface Approval {
  stage: ApprovalStage | null;      // null = with the Auditor (never approved, or sent back)
  stage_label: string | null;
  stage_updated_at: ISO | null;     // unread
  approved_at: ISO | null;          // unread – the Auditor's latest approval; null again after a return to the Auditor
  approved_by: string | null;       // unread
  last_event: ApprovalEvent | null; // the latest move
  register_id: string | null;       // student register code (REG-000123) once finally approved
  batch: { id: UUID; name: string } | null;
}

interface Applicant {               // one row of E5
  id: UUID;                         // account id
  name: string;                     // account: first + middle + last name
  email: string; mobile_number: string;          // the account's, in full
  stage: Stage; stage_label: string;
  account_created_at: ISO; otp_verified_at: ISO | null; last_login_at: ISO | null /* unread */;
  basic_completed_at: ISO | null; main_completed_at: ISO | null; submitted_at: ISO | null;
  registration_id: string | null;   // IPP-000001
  registration_number: string | null;            // unread in the list
  district_id: UUID | null; district: string | null;   // the form's District; its current name
  category: string | null;          // the form's caste, by its Marathi name
  centre: string | null;            // the form's Center Name (not the batch's centre)
  documents: { uploaded: number; verified: number };
  documents_verified: boolean;      // unread in the list (used for the `documents` filter)
  final_verified: boolean;          // unread in the list (= stage APPROVED)
  last_activity_at: ISO;
  follow_up: FollowUp | null;       // latest
  can_approve: boolean;             // SUBMITTED, stage null, uploaded > 0 and verified === uploaded
  can_batch: boolean;               // stage BATCH and in no batch
  approval: Approval | null;        // today always an object, also for drafts; the page accepts both
}

interface Summary {
  total: number;
  counts: Record<Stage, number>;
  stages: { code: Stage; label: string; count: number }[];        // order of 2.1: OTP_PENDING, VERIFIED, BASIC_DONE, MAIN_DONE, SUBMITTED
  follow_ups: Record<FollowUpStatus | 'NONE', number>;
  approvals: Record<'AWAITING' | 'RETURNED' | ApprovalStage, number>;   // without it the pages leave the counts out
}

interface ListFilterOptions {
  districts: { id: UUID; name: string }[];       // active, A–Z
  categories: { id: UUID; name: string }[];      // caste master, switched-off ones included, master order, Marathi names
  centres: { id: UUID; name: string }[];         // not deleted, inactive included, A–Z
  stages: { code: ApplicationStage; label: string }[];  // the 12 codes in the order of the type
}

type FieldType = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'DATE' | 'DROPDOWN';
interface ViewField {
  key: string; step: 1 | 2; label_en: string; label_mr: string | null;
  type: FieldType;
  value: string;                    // as stored ('' = none; aadhaar_number always '')
  text: string;                     // as people read it: choice names, dates as stored, Aadhaar masked
  custom: boolean;                  // an own field (x_…)
}
interface StoredFile { doc_type: string; name: string; original_name: string; mime_type: string; size_bytes: number; uploaded_at: ISO }
interface DocumentCheck { verified: boolean; at: ISO | null; by: string | null }

interface ApplicantDetail {
  account: { id: UUID; name: string; email: string; mobile_number: string; created_at: ISO; email_verified_at: ISO | null; last_login_at: ISO | null };
  status: 'DRAFT' | 'SUBMITTED';
  steps: { basic_completed_at: ISO | null; main_completed_at: ISO | null; submitted_at: ISO | null };
  registration: { registration_id: string; registration_number: string | null } | null;   // null before submission
  aadhaar_masked: string | null;
  form: Record<string, string>;     // every known field and own field, '' when empty; aadhaar_number always ''; email falls back to the account's
  display: Partial<Record<'caste' | 'course_centre' | 'education' | 'centre' | 'district' | 'taluka' | 'religion' | 'technology' | 'gender' | 'marital_status', string | null>>;
  view_fields: ViewField[];         // every active field in the form's order, plus a switched-off one that has a value
  documents: {                      // the active documents in order, then any other one that has a file
    code: string; name: string; name_mr: string | null /* unread */; required: boolean; kind: 'DOCUMENT' | 'VIDEO';
    file: StoredFile | null;        // read: original_name, size_bytes, uploaded_at
    verified: DocumentCheck | null; // today {verified:false, at:null, by:null} when unchecked or without a file
  }[];
  documents_verified: DocumentCheck;             // unread by the panel (officers read it)
  edits: FormEdit[];                // newest first
  can_edit: boolean;                // ADMIN, submitted, not finally approved
  locked_fields: string[];          // ['email'] or ['email','district_id']
  approval: Approval | null;        // null before submission
  history: ApprovalEvent[];         // newest first, [] when none
}
interface FormEdit { at: ISO; by: string | null; changes: { key: string; label: string; from: string | null; to: string | null }[] }
// key = field key, or document code for a replaced / added file (from / to = file names)

type BatchPlace = 'AUDITOR' | 'DIVISION' | 'COEP' | 'HEAD_OFFICE' | 'ADMIN' | 'APPROVED';
interface Batch {
  id: UUID; name: string;
  centre: { id: UUID; name: string | null; code: string | null };
  district: { id: UUID; name: string } | null;   // null only for batches older than the district rule
  students: number; size: number /* unread; size it was made with */;
  stages: Record<BatchPlace, number>;            // where its students are now; AUDITOR = sent back
  rejected: number;                 // students whose latest event is a rejection
  created_at: ISO; created_by: string | null; updated_at: ISO; updated_by: string | null;
}
interface BatchMember {
  id: UUID /* account id */; name: string; email: string; mobile_number: string;
  registration_id: string | null; register_id: string | null /* unread */;
  district: string | null; district_id: UUID | null /* unread */; category: string | null; centre: string | null;
  documents_verified: boolean; final_verified: boolean /* unread */;
  approval: Approval | null;
}
interface BatchDetail extends Batch { members: BatchMember[] }   // by first name, last name, id

interface SavedMeta { updated_at: ISO | null; updated_by: string | null }   // null = never saved, defaults in use
interface BatchSettings extends SavedMeta { size: number }
interface SupportSettings extends SavedMeta { message: string; email: string | null; mobile: string | null }
interface WelcomeSettings extends SavedMeta { enabled: boolean; title: string; message: string; button_label: string }
interface HelpSettings extends SavedMeta { enabled: boolean; title: string; intro: string; fields: { label: string; value: string }[] }
interface ManageUser { id: UUID; name: string; email: string; role: ManageRole; is_active: boolean; last_login_at: ISO | null; created_at: ISO }
```

---

## 4. Pages and dialogs

Except the sign-in page (English / मराठी) the panel is English only.

### 4.1 Sign-in – `/manage/login` (`ManageLoginPage`)

- Purpose: sign in to the panel. Anyone; a signed-in account is sent to `/manage`.
- Frame: program panel, language toggle; calls S1 `GET /options` in the background (result not used here; a failure is ignored).
- Fields: Email ID, Password (show / hide eye, at most 72 characters). Sent as typed (no trimming of the email).
- Client check: both filled, else "Email ID and password are required."
- Button "Login" → E1; busy "Logging in…" (disabled). Success: token stored, user = `data.admin`, go to `/manage`.
- Errors shown: `RATE_LIMITED` "Too many attempts. Please try again later."; `NETWORK`; 401 and 403 the server's message in
  English (fixed Marathi texts); 404 likewise; anything else the server's `message`. Field details of a 422 are not shown (g-20).

### 4.2 Frame and guards (`ManageLayout`, `session.tsx`)

- Header: program name; "Tracking panel", the account's email, "View only" for a VIEWER; Logout.
- Nav: Applicants (`/manage`), Batches, Masters, Users (ADMIN only), Settings.
- Guards: no session → `/manage/login`. ADMIN-only routes: `/manage/applicants/:id/edit`, `/manage/users`, `/manage/users/new`
  (a VIEWER → `/manage`). While E2 runs: "Loading…".

### 4.3 Student list – `/manage` (`ManagePage`)

**Purpose.** Every portal account, newest first, how far it got and where its approval is; approve, pick for a batch, follow up.

**Calls.** On load and after each change of filter / page / Refresh / save: E3 **and** E5 together (both must succeed, else the
error is shown and the rows stay as they were). Once: E4. ADMIN only, once and on Refresh: E20. Only the newest answer is used.

**URL parameter.** `?application_stage=<code of 2.2 or 2.1 without SUBMITTED>` opens the list on that stage (read once; unknown
values ignored). Used by links: `BATCH` (Batches page), `RETURNED` (batch page).

**Buttons above the list**

| Button | Who | Rule |
| --- | --- | --- |
| `Approve selected (n)` | ADMIN | n = ticked forms of the shown page; disabled when 0. Opens ApproveDialog (selected) |
| `Waiting for a batch (n)` | ADMIN | n = `approvals.BATCH`; toggles the stage filter BATCH (pressed state) |
| `Create batch (k of size)` | ADMIN | enabled only when the batch size is loaded and k = size exactly. Opens CreateBatchDialog |
| `Refresh` | all | reloads E3+E5, E4 if it had failed, E20; disabled "Refreshing…" while loading |

If E20 failed (ADMIN): warning "Could not load the batch size, so no batch can be created. Choose Refresh to try again."

**Batch bar** (ADMIN, when k > 0): "`k of size selected` – select n more. / – ready: choose Create batch. / – unselect n.",
"A batch has one district: <name>", `Clear selection`.

**Tiles.** "All students" (`total`) and one per `stages[]` (label, count). A tile sets the stage filter; pressed when active. The
counts are of all students, never narrowed by the filters.

**Filters** – see 4.4. **Search**: placeholder "Search name, email, mobile or registration ID" → `search` (trimmed, applied 400 ms
after typing stops). **Follow-up** dropdown → `follow_up`: All follow-ups, Not followed up yet (n) `NONE`, the four statuses (n).
Text "n student(s)" = `meta.total`.

**Columns.** (checkbox, ADMIN) · # (`(page-1)*25 + i`) · Student (name, email) · Mobile · Details (District, Category, Centre,
Documents `v/u verified`, green when equal, `—` when none uploaded) · Stage (badge) · Approval stage (4.8, plus why a student
cannot be picked) · Account created · OTP verified · Step 1 · Step 2 · Submitted · Registration (`registration_id`) ·
Last activity · Follow-up (actions).

**Row actions.** `View` → student page. ADMIN: `Approve` when `can_approve`; a **blurred, disabled** `Approve` plus the link
"First verify all documents, then approve" (to the student page) when `stage === 'SUBMITTED'`, `approval.stage` is null and
`can_approve` is false; nothing otherwise. Follow-up icon (all). Latest follow-up: status badge, note, date, or "Not followed up".

**Checkbox rules (ADMIN).** One checkbox per row, or none:
- `can_approve` → tick for approval. Ticks live on the shown page only: after every load the ticks not on the page or no longer
  `can_approve` are dropped; all are dropped after an approval.
- else `can_batch` → tick for a batch (4.6). These ticks stay while paging and filtering; one is dropped only when a loaded row
  says `can_batch: false`; all are dropped after a batch was created. Leaving the page forgets them.
- Heading checkbox: when the page has approvable rows, ticks / unticks all of them ("Select every form on this page that can be
  approved"); otherwise ticks the page's students for a batch, one district, up to the size, or takes this page's out again;
  disabled when nothing can be added and none of the page is ticked.

**Sort.** None offered; server default: account created, newest first, then id. **Paging.** 25 per page, ← Previous / Next →,
"Page x of y", shown when `totalPages > 1`; every filter change goes to page 1.

**States.** Loading: "Loading…" in the empty table, rows stay during a reload. Empty: "No students match." Error: red notice with
the message. Success notices: 4.5, 4.6. After closing the follow-up dialog the focus returns to the row's icon.

### 4.4 Filters (`StudentFilters`), in this order

| Label | Parameter | Options | What it matches |
| --- | --- | --- | --- |
| Name (≤100) | `name` | text, applied after 400 ms | part of "first middle last" or "first last" of the account, any case |
| District | `district_id` | All districts; E4 `districts` | the form's District |
| Category | `caste_id` | All categories; E4 `categories` | the form's caste |
| Stage of application | `application_stage` (or `stage=SUBMITTED`, below) | All stages; E4 `stages` with the count of E3 | 2.1 / 2.2 |
| Documents | `documents` | All / `VERIFIED` / `NOT_VERIFIED` | form mark "every uploaded document verified"; NOT_VERIFIED = everyone else, drafts and accounts without a form too |
| Mobile no. | `mobile` | digits only, last 10 of a pasted number; 400 ms | part of the account's mobile |
| Centre | `centre_id` | All centres; E4 `centres` | the form's Center Name |
| Final verification | `final` | All / `VERIFIED` / `NOT_VERIFIED` | finally approved, or everyone else |

- Counts beside the stage names: `counts[code]` for the first four, `approvals.AWAITING` for `AUDITOR`, else `approvals[code]`.
- The tile "Form submitted" sends **`stage=SUBMITTED`** (all approval stages) instead of `application_stage`, and shows as an extra
  option of the dropdown while it is on. The dropdown then takes over from the tile and the reverse.
- All parameters combine with AND. `Clear filters` empties every filter, the search and the follow-up filter, page 1.
- E4 failed: "Could not load the filter choices. Choose Refresh to try again." (the list still works).

### 4.5 Approve dialog (`ApproveDialog`)

- Opened from a row, from "Approve selected", from the student page. ADMIN. A yes / no alert; Cancel is focused; it cannot be closed
  while saving.
- One form: title "Approve <name>'s form?". Text: not in a batch → "The submitted form (IPP-…) will be approved and wait for a
  batch. Put it into a batch to send it to the Divisional Officer."; already in a batch (`approval.batch`) → "…will go straight back
  to the Divisional Officer, in the same batch (<name>)." Always "This cannot be undone."
- Selected: title "Approve n selected form(s)?", the same split (wait / back), the list of names with registration id and "back to
  <batch>".
- `Yes, approve` → E7; `Yes, approve selected` → E8 with the ticked ids. Busy "Approving…".
- Success, one: "<name>'s form approved. Put it into a batch to send it to the Divisional Officer." or "…approved and sent back to
  the Divisional Officer in batch <name>." Selected: built from `approved` and `skipped`: "n forms approved. …", "None of the
  selected forms was waiting for approval.", " k selected forms were skipped (already approved or not submitted)." (g-14).
  Then the list (or the student) is reloaded.
- Error (404, 409, 403, network): message in the dialog, which stays open.

### 4.6 Batch selection (`batchPicks`) and Create batch (`CreateBatchDialog`)

**Who can be ticked** (`can_batch` rows), checked in this order; the reason is the checkbox's tooltip, and the two marked * are also
written in the row:
1. batch size not loaded: "The batch size is not loaded"; 2. no district: "The form has no district" *; 3. another district than the
first tick: "A batch has one district: <name>" *; 4. `size` already ticked: "n of n are selected". A ticked one can always be unticked.

**Dialog** (ADMIN): title "Create a batch of n student(s)". Calls S2. Text: "When it is created, the batch is sent to the
Divisional Officer of <district>. Its students cannot be changed after that." Lists the students (name, registration id), also those
of other pages.
- Batch name (required, ≥2 after trimming, ≤120): "Enter a batch name (at least 2 characters)".
- Centre (required): S2's active centres as `name (code) – district`, any district (g-12): "Choose a centre". "Loading…" until S2
  answers; S2 failed: its message; none: "No active centre yet: add one in Center Master first." and Create disabled.
- `Create batch` → E17 `{ name, centre_id, ids }`. Busy "Creating…"; not closable while busy.
- Success: "Batch "<name>" created with n students and sent to the Divisional Officer of <district>."; ticks cleared; list reloaded.
- Error: `name`, `centre_id` at their boxes; `ids` message on top; 422 with a box error "Please correct the highlighted fields.";
  otherwise `message` on top. The dialog stays; on Cancel after a refusal the list and the batch size are reloaded and the ticks kept.

### 4.7 Follow-up dialog (`FollowUpDialog`)

- From the list (all) or the student page ("Add follow-up", ADMIN). Any student at any stage, finally approved ones too.
- Head: stage badge, `tel:` and `mailto:` links. E14 on open; the status starts at the latest one (else Pending follow-up).
- ADMIN form: Follow-up status (4 options), Note (optional, ≤1000, counter). `Save follow-up` → E15; the answer is the whole history.
  "Follow-up saved."; the list is reloaded. Errors: `message` on top, details at `status` / `note`. Each save adds an entry; none is
  changed or deleted.
- VIEWER: no form, only Close and the history.
- History, newest first: status badge, date, who, note (line breaks kept). "Loading…", "No follow-up recorded yet.",
  "Could not load the history. Close and open the follow-up again."

### 4.8 Approval stage cell and history (`ApprovalStageCell`, `ApprovalHistory`)

- Cell: no approval, or stage null without a rejection → "Not approved yet" (submitted) or "—". Else badge = `stage_label`, or
  "Sent back to Auditor" when stage is null; if `last_event` is a rejection "Rejected by <from.name>: <reason>"; "Batch: <link>"
  (not on the batch's own page); "Student register: <register_id>" when APPROVED; last line "<move> (<by>) · <date>" (for a rejection
  date and who).
- Move wording: REJECT → "Rejected by <from.name>"; APPROVE from BATCH → "Put into a batch"; else "Approved by <from.name>".
- History (student page and batch page): newest first, move, where to ("sent back to X", "waiting for a batch", "finally approved",
  "sent to X"), date, who, "Reason: …". Empty: "No approval or rejection yet."

### 4.9 One student – `/manage/applicants/:id` (`ApplicantDetailPage`)

**Calls.** E6; then E14. After an approval E6 again. Files E10, E11. Verify E9.

**Head.** "← Back to Applicants". Name = `form.first_name` + `form.last_name`, else the account's name. Stage badge (2.1). "Registration
ID … · Registration Number …" or "Not submitted yet". Mobile and email of the account as links. If submitted: approval stage cell.
Dates: Account created, OTP verified, Last login, Step 1 completed, Step 2 completed, Submitted.

- `Edit form` (ADMIN and `can_edit`) → 4.10.
- `Approve` (ADMIN, submitted and `approval.stage` null): enabled only when at least one document is uploaded and every uploaded one
  is verified; otherwise blurred, disabled, with "First verify all documents, then approve (v of u verified)." or "No document is
  uploaded yet, so the form cannot be approved." Computed in the page from `documents`, and enforced by E7.

**Cards.** Approval history (submitted). Changes (submitted and `edits` not empty): date, who, "<label>: from → to", `—` for empty.
Basic Details; Address (current_address, permanent_address, landmark, district_id, taluka, pin_code); Course & Center (region_id,
centre_id, technology); Qualification (other step 2 fields); Additional details (own / unknown fields). A card without lines is not
shown. Lines come from `view_fields` in order with `label_en` and `text`: dates as dd/mm/yyyy; score `72.50%` or `8.2 / 10` (from
`grading_type`, `cgpa_scale` values); `disability_type` and `disability_certificate_number` only when `disability_status` is `Yes`;
`cgpa_scale` only for `CGPA`; empty email / mobile → the account's; empty → `—`.

**Documents.** "v of u documents verified" (submitted), "u of n documents uploaded", `Download all documents (ZIP)` (shown when a
file exists; busy "Preparing ZIP…") → E11. Table: Document (`*` = required) · File (name, size, or "Not uploaded") · Uploaded ·
Verification (submitted only) · View → E10 in a new tab · Download → E10 `?download=1`. "* Mandatory."
Verification cell: badge Verified / Not verified, who and when; ADMIN and not finally approved: `Verify` or `Undo` → E9 (busy
"Saving…"; an error under the cell, state unchanged). Also offered after the approval, until the final one.
File errors: "Could not open <name>.", "Could not download <name>.", "Could not download the documents."

**Follow-ups.** `Add follow-up` (ADMIN) → 4.7. List as in 4.7; "Could not load the follow-ups."

**States.** "Loading…"; 404 "This student was not found."; other errors the message. Drafts can be opened too (no approval parts, no
verification). Green notice from Edit form ("Changes saved.") or the approval.

### 4.10 Edit form – `/manage/applicants/:id/edit` (`EditFormPage`)

**Who.** ADMIN. **Purpose.** Correct a submitted form until the final approval. **Calls.** S1, E6; E12 to save; E13 per document, then
E6 again; E10 to view.

- "← Back to the student". Not editable (`can_edit` false): "This form cannot be changed (it is not submitted, or it is finally
  approved)." 404: "This student was not found."
- Fields: exactly the active fields of S1, steps 1 and 2, in order, with the English labels, help and choices; own fields under
  "Additional details". Prefilled with `view_fields[].value` then `form`.
- Locked fields: `locked_fields` + `email`: disabled with the reason ("The student signs in with this email ID; it cannot be
  changed.", "The student is in a batch: the district cannot be changed.", else "This field cannot be changed.").
- Aadhaar: empty box, placeholder `aadhaar_masked`, optional ("Leave it empty to keep the number on record; enter all 12 digits to
  change it.").
- A saved choice no longer offered stays selectable as "<text> (no longer offered)".
- Rules between fields: "Permanent address is the same as the current address"; disability details cleared when not Yes; CGPA scale
  cleared when not CGPA; technology cleared with a warning when the new district does not offer it.
- `Save changes (n)`: nothing changed → "Nothing to save: nothing was changed." Checks only the changed fields and those depending on
  them (disability_status → its two details; grading_type → cgpa_scale, score; cgpa_scale → score; district_id → technology;
  mobile_number → alternate_mobile_number). Sends **only the changed keys** (cleared ones as `''`). Success → student page, "Changes
  saved." (the answer's body is not read).
- 422: each `body.<key>` at its box and "Please correct the highlighted fields: <labels>."; 409 / other: `message` on top.
- Documents card: one drop area per `documents[]` entry (name, `*`, file name, size, formats, limit). Replace or add only (no Remove);
  saved as soon as chosen; checked first by extension and size (DOCUMENT: PDF, JPG, JPEG, PNG ≤ 5 MB; VIDEO: MP4 ≤ 50 MB). Success:
  "<name> saved. It has to be verified again." Errors at the document: `files.<CODE>` message, else `message`, else "Upload failed".
- No unsaved-changes warning, no version check (last save wins, field by field).

**Value rules of the form** (same as the student's form; own labels in messages):

| Field | Rule when filled |
| --- | --- |
| first_name, last_name / father_name, mother_name | ≤100 / ≤150; starts with a letter; letters (any script), spaces, `. ' -` |
| date_of_birth | real date, not future, age 14–100 |
| current_address, permanent_address / landmark / taluka | ≤500 / ≤150 / ≤100 |
| pin_code | `^[1-9]\d{5}$` |
| aadhaar_number | 12 digits starting 2–9, Verhoeff; spaces and hyphens ignored; not used by another submitted form |
| mobile_number, alternate_mobile_number | 10 digits starting 6–9 (+91 / 0 / spaces / brackets / hyphens allowed); the two differ |
| alternate_email | valid, ≤254, not the account's email |
| disability_status | Yes / No; details only when Yes: type ≤100, certificate `^[A-Za-z0-9/-]{4,50}$` |
| dropdowns (religion, caste_id, gender, marital_status, region_id, education_id, educational_status, grading_type, cgpa_scale, qualification_class) | an active choice, or unchanged |
| district_id, centre_id | active, or unchanged |
| technology | active and offered in the form's district (no selection for the district = all), or unchanged while the district is unchanged |
| qualification_name, _stream / _board | ≤150 / ≤200 |
| qualification_completed_on | real date, not future (server: not before 1940) |
| score | ≤2 decimals; PERCENTAGE 0–100; CGPA 0–scale |
| own fields | TEXT ≤250; TEXTAREA ≤2000; NUMBER `^-?\d{1,12}(\.\d{1,4})?$`; DATE real; DROPDOWN an active choice, or unchanged |
| any | ≤2000 characters, no control characters, at most 200 keys; required per the Form fields master |

### 4.11 Batches – `/manage/batches` (`BatchesPage`)

- All accounts. Calls E16 (`page`, `limit=25`, `search`).
- Hint: "To create a batch, select students in Applicants (waiting for a batch) and choose Create batch." + "A batch has exactly
  n students of one district (Settings → Batch size)." (`meta.size`).
- Search "Search batch or centre" (400 ms, page 1). "n batch(es)". Refresh. Newest first, no sort choice.
- Columns: # · Batch · District · Centre (name, code) · Students · Where it is now (e.g. "Divisional Officer 2 · COEP 27 · Sent back 1";
  order Divisional Officer, COEP, Head Office, Admin, Final approved, Sent back; zero left out) · Rejected (badge or —) · Created
  (date, who) · Actions: View.
- States: "Loading…", "No batches yet.", "No batches match." (when searching), error notice. Pager as in 4.3.
- No create, delete or member buttons here.

### 4.12 One batch – `/manage/batches/:id` (`BatchDetailPage`)

- All accounts. Calls E18 and S2 (S2 also for a VIEWER); E19 to save; E6 of a member when its history is opened (reads `history`).
- Head: name, "n rejected", "n students", Where it is now, District, Centre (code), Created … by, Last changed … by.
- ADMIN: Batch details form: name (≥2, ≤120), centre (S2's list; the current centre, if not in it, as "<name> (inactive)"). `Save
  details` sends only what changed; nothing changed → "Nothing to save: the name and centre are unchanged."; success "Batch details
  saved."; errors as in 4.6. Allowed at any time, also after the final approval.
- Members: # · Student (name, email) · Mobile · Details (District, Category, Centre, Documents Verified / Not verified) · Approval
  stage · Registration · View, History / Hide history (loading and "Could not load the history. Close and open it again.").
- Members cannot be added or removed. Hint with a link to the list filtered on `RETURNED`.
- Error (404 "Batch not found", others): the message and "← Batches".

### 4.13 Settings – `/manage/settings` (`SettingsPage`)

All accounts read, ADMIN saves. Four independent cards, each its own GET on load and PUT on Save (a failing one shows its error
alone). Each shows "Last updated <date> by <name>" or, never saved, "Not saved yet: …". Save checks first ("Please correct the
highlighted fields."), then PUT; the answer fills the form again. 422 details are shown at the boxes.

| Card | Endpoint | Fields and checks | PUT body |
| --- | --- | --- | --- |
| Batch size – "Every new batch has exactly this many students, all of one district. Existing batches are not changed." | E20 / E21 | whole number 1–100 | `{ size: number }` |
| Support contact (shown after a submission and in emails) | E22 / E23 | message 10–500, may hold `{email}` `{mobile}`; email optional, valid ≤254, required if `{email}` is used; mobile optional `^\+?\d[\d ()-]{5,18}\d$`, required if `{mobile}` is used; "Reset to default text"; live preview | `{ message, email: string\|null, mobile: string\|null }` |
| Welcome message (popup after the account is created) | E24 / E25 | "Show this popup to students"; title 3–120; message 10–1000 (line breaks kept); button label ≤60, blank = portal's own; preview | `{ enabled, title, message, button_label }` |
| Help button | E26 / E27 | "Show the Help button to students"; title 2–120; intro ≤300; 4 rows name ≤60 / value ≤200, both halves or neither; at least one complete row while enabled; preview | `{ enabled, title, intro, fields: [4 rows, blank ones included] }` |

### 4.14 Users – `/manage/users` (`UsersPage`)

- ADMIN. E28, no search, filter, sort or paging (newest first). Refresh, "+ Add user".
- Columns: # · Name ("(you)" on one's own) · Email · Role · Status (Active / Inactive) · Last login · Created · Actions.
- Deactivate / Activate on everybody else (nothing on one's own row) → confirmation "Deactivate <name>?" ("The user will no longer be
  able to log in to the tracking panel. Their follow-ups are kept.") / "Activate <name>?" → E30; row replaced by the answer; "<name>
  deactivated." Errors in the dialog. No edit, delete, role change or password reset (g-18).
- "Loading…", "No users yet.", error notice.

### 4.15 Add user – `/manage/users/new` (`UserFormPage`)

- ADMIN. Name 2–150; Email valid (≤254); Password 8–72 with a letter and a digit (show / hide); Role radio: Viewer (default) / Admin.
- `Add user` → E29, busy "Adding…"; success → Users, "User <name> added."; 422 details at the boxes; 409 (duplicate email) as a notice.

---

## 5. API reference

`:id` = account id unless stated. Auth: `P` = public, `V` = any panel account, `A` = ADMIN. Every `V`/`A` endpoint: 401 without a valid
panel token, every `A` endpoint: 403 for a VIEWER. Common errors are not repeated.

### E1 `POST /manage/auth/login` – P
Body `{ email: string; password: string }` – email trimmed, lower-cased, valid ≤254; password 1–200 (existing password, no strength rule).
200 `data: { token: string; expires_at: ISO /* unread */; admin: Admin }`.
Side effect: `last_login_at = now`. 401 `Incorrect email or password` for an unknown email, wrong password, inactive or deleted account
(same answer and same time: compare against a dummy hash). 422 field errors. 429 `RATE_LIMITED`.

### E2 `GET /manage/me` – V
200 `data: Admin`.

### E3 `GET /manage/summary` – V
200 `data: Summary`. Counts every not-deleted account; not affected by filters.

### E4 `GET /manage/filters` – V
200 `data: ListFilterOptions`.

### E5 `GET /manage/applicants` – V
Query: `page, limit, search (≤100), name (≤100), mobile (^\d{1,15}$), district_id, caste_id, centre_id (UUID), documents, final
('VERIFIED'|'NOT_VERIFIED'), application_stage (2.2 + 2.1 without SUBMITTED), stage (2.1), follow_up (2.3 + NONE)`. Also accepted today,
not sent by the pages: `approval ('AWAITING'|'RETURNED'|ApprovalStage)`, `sortBy=createdAt`, `sortOrder=ASC|DESC`.
Meaning: 4.4. `search`: part, any case, of the full name, email, mobile, registration id (IPP-…) or register code (REG-…); LIKE
wildcards in the text are literal. Order: account created DESC, id. 200 `data: Applicant[]`, `meta: PageMeta`. 422 on a bad value
(`query.<key>`, shown as the list's error message).

### E6 `GET /manage/applicants/:id` – V
200 `data: ApplicantDetail` (any stage, drafts too; an account without an application reads as an empty DRAFT). `can_edit` is false for
a VIEWER. 404 `Student not found`. Malformed id: today 422 (see g-8).

### E7 `POST /manage/applicants/:id/approve` – A
No body. 200 `data: { approved: 1 }` (unread; success is enough). 404 `Student not found`. 409 (in this order):
`Verify every document first (7 of 10 verified).` / `No document has been uploaded for this form, so it cannot be approved.` /
`This form is already approved.` / `Only a submitted form can be approved.`

### E8 `POST /manage/applicants/approve-selected` – A
Body `{ ids: UUID[] }` 1–500, unique (422 `body.ids`: `Select at least one student`, `At most 500 students at a time`, `Each student may
be selected only once`). 200 `data: { approved: number; skipped: number }`, `skipped = ids.length - approved`. Never 404 / 409: a student
who is not submitted, not with the Auditor, unknown, or with an unverified document is skipped.

### E9 `POST /manage/applicants/:id/documents/:docType/verify` – A
`docType` `^[A-Za-z0-9_]{1,40}$`, any case. Body `{ verified: boolean }`. 200
`data: DocumentCheck & { documents: { uploaded: number; verified: number } }` (read: `verified, at, by`). Idempotent: verifying again
keeps the first who / when. 404 `Student not found` / `No file has been uploaded for this document` (unknown document too). 409
`Only a submitted form's documents can be verified.` / `This form is finally approved and can no longer be changed.` 422 `body.verified`.

### E10 `GET /manage/applicants/:id/documents/:docType/file` – V (also `?download=1`)
The raw file, any stage, drafts too. Headers: `Content-Type` = stored type, `Cache-Control: private, no-store`, `Content-Disposition`:
- without `download`: `inline; filename="<URL-encoded original name>"` (the page opens it as a blob in a new tab);
- `download=1`: `attachment; filename="<ASCII>"; filename*=UTF-8''<percent-encoded>` with
  `<registration id>_<First>_<Last>_<Document_Label>.<ext>`, e.g. `IPP-000001_Kavya_Jadhav_PAN_Card.pdf`; `DRAFT_First_Last_…` before
  submission. Folder part: first and last name of the form (else the account's); only `A–Z a–z 0–9 . _ -` stay, every other run of characters becomes one
  `_`, none at the end, at most 100 characters (so a name in Marathi letters drops out). Label = the document's English name, runs of other characters → `_`.
404 `No file has been uploaded for this document`. The page reads `filename*` first, then `filename`, else the original name.

### E11 `GET /manage/applicants/:id/documents.zip` – V
`application/zip`, streamed, `Cache-Control: private, no-store`, `Content-Disposition: attachment; filename="IPP-000001_Kavya_Jadhav.zip"; filename*=…`
(`DRAFT_First_Last.zip` before submission). One folder of that name; entries `NN_<Document_Label>.<ext>`, `NN` = the document's place in
the form's document order, active documents first (01…), e.g. `IPP-000001_Kavya_Jadhav/06_PAN_Card.pdf`. 404 `No documents have been uploaded yet`. Fallback name
`documents.zip`.

### E12 `PUT /manage/applicants/:id/form` – A
Body `{ data: Record<string, string> }`, only the changed fields. 200 `data: ApplicantDetail` (unread). Server rules:
- an unknown key → 422 `body.<key>` `Unknown field`; a switched-off field → ignored; a value equal to the stored one (trimmed) → ignored
  (also for a locked field);
- `aadhaar_number`: spaces and hyphens removed; empty, the mask, or 4 digits = not given;
- `email` different → 422 `… is the sign-in and cannot be changed`; `district_id` different while in a batch → 422 `… cannot be changed:
  the student is in a batch`;
- the changed fields and their dependents (4.10) are checked on the whole form with the rules of 4.10; a stored choice no longer offered
  is accepted while unchanged (technology: only while the district is unchanged too); dependents that no longer apply become `''`;
- duplicate Aadhaar → 422 `body.aadhaar_number` `A registration with this Aadhaar number already exists`;
- a changed first or last name also changes the account's name; nothing changed → 200, nothing recorded.
404 `Student not found`. 409 `Only a submitted form can be changed here.` / `This form is finally approved and can no longer be changed.`
422 keys `body.<key>` (or `body.data.<key>`).

### E13 `POST /manage/applicants/:id/documents` – A
multipart/form-data, one file per field, field name = document code (the page sends one file). Accepted codes: the active documents and
any other document that has a file. Type by content (magic bytes) **and** extension; DOCUMENT: PDF, JPG / JPEG, PNG ≤ 5 MB; VIDEO: MP4
(`ftyp` box, not `qt  `) ≤ 50 MB. 200 `data: ApplicantDetail` (unread; the page calls E6). A replaced document loses its verification.
422 details: `files` `Choose a file to upload`; `files.<CODE>`: `Unknown or inactive document type`, `Only one <name> file may be uploaded`,
`<name>: file is larger than 5 MB`, `<name>: only PDF, JPG, JPEG or PNG files are accepted`, `<name>: only MP4 videos are accepted`. 404, 409
as E12. A reverse proxy must allow the 50 MB request.

### E14 `GET /manage/applicants/:id/follow-ups` – V
200 `data: FollowUp[]`, newest first. 404 `Student not found`.

### E15 `POST /manage/applicants/:id/follow-ups` – A
Body `{ status: FollowUpStatus; note?: string }` (note trimmed ≤1000, blank = none, line breaks allowed). **201** `data: FollowUp[]`, the whole
history newest first. 404. 422 `body.status` `Choose a follow-up status`, `body.note` `Note must be at most 1000 characters` / `Note contains
characters that cannot be saved`.

### E16 `GET /manage/batches` – V
Query `page, limit, search (≤100)`; also `sortBy=createdAt|name`, `sortOrder` (unsent). Search: part of the batch name, centre name, centre
code or district name. Order: newest first. 200 `data: Batch[]`, `meta: PageMeta & { size: number }` (the current batch size).

### E17 `POST /manage/batches` – A
Body `{ name: string; centre_id: UUID; ids: UUID[] }`. **201** `data: BatchDetail` (read: `name`, `students`). 422: `body.name` (`Batch name must be
at least 2 / at most 120 characters`), `body.centre_id` (`Centre not found` / `This centre is inactive. Choose an active centre.`),
`body.ids` (`Select at least one student`, `At most 100 students at a time`, `Each student may be listed only once`, `A batch must have exactly 30
students (Settings → Batch size); 28 selected.`, `All students of a batch must be from one district. Selected: Nashik, Pune.`). 409 `A batch with
this name already exists. Choose another name.` / `n student(s) of the selected cannot be added: only approved forms waiting for a batch can be.`
Nothing is saved when refused. Checked today in this order: shape, size, centre, district, name, members. Rules: section (c).

### E18 `GET /manage/batches/:id` – V
`:id` = batch. 200 `data: BatchDetail`. 404 `Batch not found` (shown as is).

### E19 `PATCH /manage/batches/:id` – A
Body `{ name?: string; centre_id?: UUID }`, at least one (422 `Nothing to change`); any other key, e.g. members, → 422. A new centre must be
active (422 `body.centre_id`). 200 `data: BatchDetail`. 404 `Batch not found`. 409 duplicate name.

### E20 `GET /manage/settings/batch` – V → 200 `data: BatchSettings` (default `{ size: 30, updated_at: null, updated_by: null }`)
### E21 `PUT /manage/settings/batch` – A
Body `{ size: number }` integer 1–100, a JSON number (422 `body.size`). 200 `data: BatchSettings`. Existing batches keep their size.

### E22 `GET /manage/settings/support` – V → 200 `data: SupportSettings`
Default message: `If you have any query related to your registration, you can contact us on email ID {email} or mobile number {mobile}.`, email and
mobile from configuration (else null).
### E23 `PUT /manage/settings/support` – A
Body of 4.13 (email lower-cased, blank = null). 200 `data: SupportSettings`. 422 `body.message`, `body.email`, `body.mobile`.

### E24 `GET /manage/settings/welcome` – V → 200 `data: WelcomeSettings`
Default: enabled, title `Congratulations! Your account is created`, message `Your mobile number is verified and your 3 Month Internship Placement
Program account is ready. Fill in the form in three steps, upload your documents and submit it — you can see your application any time.`, button `''`.
### E25 `PUT /manage/settings/welcome` – A
Body of 4.13. 200 `data: WelcomeSettings`. 422 `body.title`, `body.message`, `body.button_label`.

### E26 `GET /manage/settings/help` – V → 200 `data: HelpSettings`
Default: enabled, title `Need help?`, intro `For any query about your registration, you can contact the programme office.`, rows Contact Number / Email
ID from configuration (missing ones left out). At most 4 rows, only complete ones.
### E27 `PUT /manage/settings/help` – A
Body of 4.13; at most 4 rows; checked **as sent** (row numbers in the errors are the rows on screen), then blank rows are dropped. 200 `data:
HelpSettings`. 422 `body.title`, `body.intro`, `body.fields`, `body.fields.<i>.label`, `body.fields.<i>.value`.

The values of E22–E27 reach the students in S1 (`support`, `welcome`, `help`, without `updated_*`). A settings read that fails must fall back to the
defaults there, not break the portal.

### E28 `GET /manage/users` – A
200 `data: ManageUser[]`, not deleted, newest first (no paging, no `meta`).

### E29 `POST /manage/users` – A
Body `{ name, email, password, role }`. **201** `data: ManageUser`. 422 `body.name|email|password|role`. 409 `A user with this email already exists`
(inactive users count, email compared lower-cased).

### E30 `PATCH /manage/users/:id/status` – A
`:id` = panel user. Body `{ is_active: boolean }`. 200 `data: ManageUser`. 404 `User not found`. 409 `You cannot deactivate your own account`.

### Used from the other parts
- **S1 `GET /options`** (public): read by Edit form (`fields`, `lists`, `districts`, `centres`, `technologies`, `district_technologies`, the older lists as
  fallback); loaded but unused on the sign-in page. Its failure leaves Edit form on "Loading…" (g-21).
- **S2 `GET /manage/centres?page=1&limit=100&isActive=true&sortBy=name&sortOrder=ASC`** (V): read `id, name, code, districtName, isActive`. Used by Create batch
  and the batch page (also for a VIEWER). Only the first 100 are offered.

---

## (a) All endpoints of this part

| # | Method and path | Who | Used by | Success |
| --- | --- | --- | --- | --- |
| E1 | POST /manage/auth/login | public | sign-in | 200 |
| E2 | GET /manage/me | V | session | 200 |
| E3 | GET /manage/summary | V | list | 200 |
| E4 | GET /manage/filters | V | list | 200 |
| E5 | GET /manage/applicants | V | list | 200 + meta |
| E6 | GET /manage/applicants/:id | V | student, Edit form, batch history | 200 |
| E7 | POST /manage/applicants/:id/approve | A | Approve | 200 |
| E8 | POST /manage/applicants/approve-selected | A | Approve selected | 200 |
| E9 | POST /manage/applicants/:id/documents/:docType/verify | A | student | 200 |
| E10 | GET /manage/applicants/:id/documents/:docType/file[?download=1] | V | student, Edit form | 200 file |
| E11 | GET /manage/applicants/:id/documents.zip | V | student | 200 ZIP |
| E12 | PUT /manage/applicants/:id/form | A | Edit form | 200 |
| E13 | POST /manage/applicants/:id/documents | A | Edit form | 200 |
| E14 | GET /manage/applicants/:id/follow-ups | V | list, student | 200 |
| E15 | POST /manage/applicants/:id/follow-ups | A | list, student | 201 |
| E16 | GET /manage/batches | V | Batches | 200 + meta.size |
| E17 | POST /manage/batches | A | Create batch | 201 |
| E18 | GET /manage/batches/:id | V | one batch | 200 |
| E19 | PATCH /manage/batches/:id | A | one batch | 200 |
| E20 / E21 | GET / PUT /manage/settings/batch | V / A | list, Settings | 200 |
| E22 / E23 | GET / PUT /manage/settings/support | V / A | Settings | 200 |
| E24 / E25 | GET / PUT /manage/settings/welcome | V / A | Settings | 200 |
| E26 / E27 | GET / PUT /manage/settings/help | V / A | Settings | 200 |
| E28 | GET /manage/users | A | Users | 200 |
| E29 | POST /manage/users | A | Add user | 201 |
| E30 | PATCH /manage/users/:id/status | A | Users | 200 |
| S1, S2 | GET /options, GET /manage/centres | P, V | (other parts) | 200 |

30 endpoints of this part.

---

## (b) State machine

### b.1 The form (student's side; the panel only shows it)

```
account created ──OTP verified──▶ VERIFIED ──step 1 completed──▶ BASIC_DONE ──step 2 completed──▶ MAIN_DONE ──submit──▶ SUBMITTED
 OTP_PENDING                                                                                                         (final for the student)
```
Recorded: account created_at; OTP verified_at; basic_completed_at and main_completed_at (first time only, never cleared); submitted_at, registration
id `IPP-000001` (sequence) and registration number (16 digits), Aadhaar blind index and last four. There is no way back to DRAFT: the Auditor cannot
return a form to the student, only correct it (E12, E13).

### b.2 Approval (per student)

```
approve   AUDITOR (stage null) ─▶ BATCH ─▶ DIVISION ─▶ COEP ─▶ HEAD_OFFICE ─▶ ADMIN ─▶ APPROVED (final, student register)
          AUDITOR ──────────────────────▶ DIVISION          when the student is already in a batch (was sent back)
reject    DIVISION ─▶ AUDITOR     COEP ─▶ DIVISION     HEAD_OFFICE ─▶ COEP     ADMIN ─▶ HEAD_OFFICE
Head Office optional:  approve  COEP ─▶ ADMIN          reject  ADMIN ─▶ COEP
```
While "Head Office approval optional" is on (default off): COEP approves straight to ADMIN, ADMIN rejects to COEP.

| # | Move | Who | Precondition | Recorded (one transaction) |
| --- | --- | --- | --- | --- |
| M1 | AUDITOR → BATCH | ADMIN account (E7, E8) | SUBMITTED; stage null; in no batch; ≥1 uploaded document and all verified | stage BATCH, stage_updated_at, approved_at, approved_by; event APPROVE AUDITOR→BATCH |
| M2 | AUDITOR → DIVISION | ADMIN account (E7, E8) | as M1 but already in a batch (sent back) | stage DIVISION, stage_updated_at, approved_at, approved_by; event APPROVE AUDITOR→DIVISION |
| M3 | BATCH → DIVISION | ADMIN account (E17) | section (c) | batch row; batch_id, stage DIVISION, stage_updated_at per student; event APPROVE BATCH→DIVISION per student |
| M4 | DIVISION → COEP | Divisional Officer of the form's district (later part) | stage DIVISION | stage, stage_updated_at; event APPROVE by the officer |
| M5 | DIVISION → AUDITOR | same | stage DIVISION; reason 3–500 | stage null, stage_updated_at, approved_at and approved_by cleared, **batch_id kept, document checks kept**; event REJECT with reason |
| M6 | COEP → HEAD_OFFICE (ADMIN if optional) | COEP | stage COEP | event APPROVE |
| M7 | COEP → DIVISION | COEP | reason | event REJECT |
| M8 / M9 | HEAD_OFFICE → ADMIN / → COEP | Head Office (not while optional) | reason for M9 | event |
| M10 | ADMIN → APPROVED | Admin | stage ADMIN | event APPROVE; student register record created or linked (register id); if that fails the move is undone |
| M11 | ADMIN → HEAD_OFFICE (COEP if optional) | Admin | reason | event REJECT |
| M12 | HEAD_OFFICE → ADMIN, all waiting | whoever makes Head Office optional | setting switched on | event APPROVE per student, reason `Head Office approval was made optional` |

- Every move is conditional on the stage it was read at (`WHERE stage = <expected>`); zero rows → 409. A student is approved alone or with
  the batch (all its students at that stage now); a rejection is always one student, the rest goes on.
- "Sent back" (RETURNED) = SUBMITTED, stage null, latest event REJECT. Such a student is `can_approve` at once if the documents are still
  verified, is never `can_batch`, and after M2 rejoins the batch at DIVISION without any size or district check.
- The history is the list of events, newest first; events are never changed or deleted (except undoing a failed M10).

### b.3 What is possible at each stage (panel)

| | Draft | AUDITOR (incl. RETURNED) | BATCH | DIVISION … ADMIN | APPROVED |
| --- | --- | --- | --- | --- | --- |
| View, download, follow-up | yes | yes | yes | yes | yes |
| Verify / Undo a document | 409 | yes | yes | yes | 409 |
| Edit form, replace / add documents | 409 | yes | yes | yes | 409 |
| ↳ email | – | locked | locked | locked | – |
| ↳ district | – | free (locked when in a batch) | free | locked | – |
| Approve (E7) | 409 | when all verified | 409 | 409 | 409 |
| Put into a batch (E17) | refused (422 / 409) | 409 | yes | 409 | 409 |

None of verify, undo, edit, upload, follow-up or batch rename moves a student. Undoing a verification or replacing a document after the approval
leaves the stage as it is (g-2).

### b.4 Documents verified

Per uploaded document: a check (who, when) or none. The form mark (`documents_verified_at`, `_by`) = every uploaded document of the program has a check
and there is at least one; it is recomputed in the same transaction by E9 and E13 (set on the last verify, cleared by an undo or a replaced / added
file). Counted documents: the form's files whose code is a program document, also one switched off or deleted since. Not required for approval: that every
mandatory document is uploaded (submission guarantees it for the documents required at that time; one made mandatory later does not block).

---

## (c) Batch rules

1. **Exact size.** `ids.length` must equal the batch size set now (E20, default 30, 1–100); the size is stored on the batch and never changes.
   Read the size and create the batch consistently.
2. **Members.** Each is SUBMITTED, at stage BATCH, in no batch, not deleted; otherwise the whole batch is refused (409). A student is in at most one
   batch, for ever.
3. **One district.** All forms have the same District, none without one (422); stored on the batch. The district of a member is locked from then on
   (E12), so it cannot drift.
4. **Centre.** A Center Master centre that is active and not deleted at creation, and at a change (E19). An unchanged centre that became inactive may stay.
   Any district's centre is accepted (g-12). A batch's centre is not the students' Center Name and changes nothing on the forms.
5. **Name.** Trimmed, 2–120, unique among batches not deleted, ignoring case and outer spaces; enforced by a unique index, not only by a check (409).
6. **Sent on creation.** One transaction: insert batch; set batch_id, stage DIVISION, stage_updated_at on every member; one event BATCH→DIVISION each.
   Lock the member rows first, then check district and state, so a parallel edit or a second batch cannot interleave.
7. **Fixed members.** No endpoint adds, removes or replaces members, or deletes / dissolves a batch. Only name and centre change (ADMIN, any time).
8. **Sent-back students stay** in the batch (`students` does not change; `stages.AUDITOR` and `rejected` count them) and rejoin by M2.
9. **Progress.** `stages` counts the members per place (stage null = AUDITOR), all six keys present; `rejected` = members whose latest event is a
   rejection.
10. After creation the officers decide batch by batch (b.2); a batch never has a stage of its own: it is always the sum of its students.

---

## (d) Business rules the server must enforce

1. Panel tokens only; a student token or any other system's token is 401. Token of a deactivated / deleted account: 401 at the next request.
2. Every change is ADMIN only (403 with the fixed message); VIEWER reads everything except users.
3. Approve only SUBMITTED forms with the Auditor, with ≥1 uploaded document and all uploaded documents verified, counted **after** locking the row (a
   document replaced meanwhile counts as it ends up). One event per approval.
4. Selected approval skips what cannot be approved; single approval answers why (409).
5. Verification: ADMIN; SUBMITTED and not APPROVED; the document must have a file; idempotent; the form mark follows in the same transaction.
6. Replacing or adding a file removes that document's check; the old file is deleted only after commit and never overwritten in place; files written by a
   failed request are removed.
7. Edits: SUBMITTED and not APPROVED; unknown fields refused; email never; district not while in a batch; Aadhaar only by a full valid number, unique among
   submitted forms (lock per Aadhaar); only changed fields and their dependents checked, with the masters as they are now; unchanged old choices accepted;
   every change recorded with label and readable from / to (Aadhaar masked); nothing recorded when nothing changed.
8. All batch rules of (c), in one transaction.
9. Follow-ups: append-only; status from 2.3; note ≤1000; any student.
10. Settings: rules of 4.13; batch size an integer 1–100.
11. Users: email unique (lower case) among not deleted; password 8–72 with a letter and a digit, stored as a slow hash (bcrypt); nobody deactivates
    themself; make sure at least one active ADMIN always remains, also with two parallel requests (g-19).
12. Moves are conditional on the stage (409 on a race); every move writes its event in the same transaction.
13. The Aadhaar leaves the server only masked; it is stored encrypted (plus blind index and last four). Names of masters stay resolvable after they are
    switched off or deleted (soft delete), so old forms still read correctly.
14. Deleted accounts are invisible everywhere (404, not counted).
15. Dates in UTC, ids are UUIDs, lists stable (id as the last sort key).

---

## (e) Audit events

Recorded today in the audit log (action, resource, resource id, request id, IP, outcome, details). The acting panel account is in `details` (its id);
never passwords, notes, reasons, names or form values (only field names, document codes, counts).

| Action | Trigger | Resource / id | Details |
| --- | --- | --- | --- |
| `edp.application.approve` | E7 | account | applicationId, admin id |
| `edp.application.approve_selected` | E8, when ≥1 approved | application / – | count, selected, admin id |
| `edp.document.verify` / `edp.document.unverify` | E9 | account | applicationId, docType, admin id |
| `edp.application.edit` | E12, when something changed (in the transaction) | account | applicationId, changed field keys, stage, admin id |
| `edp.application.documents` | E13 (in the transaction) | account | applicationId, docType + size + sha256 each, stage, admin id |
| `edp.follow_up.create` | E15 | account | followUpId, status, hasNote, admin id |
| `edp.batch.create` / `edp.batch.update` | E17 / E19 | batch | students, centreId / renamed, centreChanged; admin id |
| `edp.settings.batch` / `.support` / `.welcome` / `.help` | E21, E23, E25, E27 | setting key | admin id |
| `edp.user.create` / `edp.user.status` | E29 / E30 | panel user | role / isActive; admin id |
| `edp.stage.approve` / `edp.stage.reject` (officers) | M4–M11 | account | applicationId, from, to, hasReason, register record |
| `edp.stage.view_unmasked` / `edp.stage.list_unmasked` (officers) | contact data shown in full | account / batch | count |
| `program.settings.update` (officers) | M12 | settings | value, moved |

Besides the log, kept as data and shown to people: approval events (history), form edits (from / to), document checks, follow-ups.
**Recommended, not recorded today:** E1 success and failure (without the password), logout if added, refused changes (403), E10 / E11 (who opened or
downloaded which document), E6 (who opened which student), E9–E13 refusals. Run the records of approvals and batches in the same transaction as the change
(today E7, E8, E15, E17, E19, the settings and the users are logged after commit, best effort).

---

## (f) What a portal-only backend must store now

So that the officers' part can be added later without changing data. Column names are suggestions.

1. **Full stage vocabulary from the start**: `approval_stage` ∈ {null, BATCH, DIVISION, COEP, HEAD_OFFICE, ADMIN, APPROVED}; the panel only writes null,
   BATCH and DIVISION, but must read, count, filter and show all of them. Constraints: stage set ⇒ SUBMITTED; `(approved_at IS NULL) = (approval_stage IS
   NULL)`; stage BATCH ⇒ no batch; stage DIVISION or later ⇒ batch; batch ⇒ SUBMITTED.
2. **`applications`**: account_id (unique), status, current_step, data (form values, jsonb), aadhaar_enc / _bidx (unique among submitted) / _last4,
   basic_completed_at, main_completed_at, submitted_at, registration_code (unique), registration_number (unique), approval_stage, **stage_updated_at**
   (officers' queues are ordered by it), approved_at, approved_by, **batch_id**, documents_verified_at, documents_verified_by, register_id / register_code
   (nullable until the student register exists), created / updated, is_deleted. Store the form's **district_id, caste_id, centre_id also as columns** (or an
   expression index): officers are scoped by the form's district, and every list filters by them.
3. **`approval_events`** (append-only): id, a monotonic sequence (ties in time), application_id, action, from_stage, to_stage (vocabulary of 1 + AUDITOR),
   reason varchar(500) (required for REJECT), actor type (panel account / officer / system) and actor id, created_at. Index (application_id, created_at).
   Every panel move is written here from day one, with M3 as its own event.
4. **`batches`**: name (unique, case-insensitive), centre_id, **district_id**, **size**, created_by / updated_by, created_at (= when it was sent),
   updated_at, is_deleted. Index applications(batch_id), applications(approval_stage, stage_updated_at).
5. **`document_checks`** (application_id, doc code, verified_at, verified_by; unique pair) and the form-level mark: officers show both.
6. **`application_edits`**: application_id, admin_id, at, changes [{key, label, from, to}] (keep `key`, so contact values can be masked for officers);
   recommended: also the stage at the time.
7. **`follow_ups`**, **`settings`** (key, value jsonb, updated_at, updated_by): keys `batch`, `support`, `welcome`, `help`; reserve `program.head_office`
   `{ optional: false }`.
8. **People**: one account table for the panel now (ADMIN, VIEWER); officers later need their own roles (Divisional Officer, COEP, Head Office, Program
   Admin) and **assigned districts** (user ↔ district). Actor references must be able to point to either; deleting an account must never remove its name
   from the history (soft delete; today a hard delete leaves `by: null`).
9. **Masters by id, soft-deleted**: districts, castes, centres, form fields, documents keep their ids and names, so officers see the same texts.
10. **Full contact data** (email, mobile) stored; masking (`ka***@example.com`, `+91XXXXXX1234`) is done when read by officers, and each unmasked view audited.
11. Stored files keyed per application and document with original name, type, size, sha256; the candidate folder name is derived, not stored.
12. Keep account ids as the public id of a student: officers' endpoints use the same ids.
13. The officers read, per batch: name, centre, district, size, sent at, per-stage counts, rejected; per student: the form, checks (who, when), edits, history,
    reason. All of that comes from 1–6.

---

## (g) Unclear or inconsistent – decide before building

1. **Download names cross-origin.** The current API does not expose `Content-Disposition` to other origins, so on a separate API domain every download gets the
   fallback name (`documents.zip`, the original name). Expose it.
2. **Verification after approval.** A document can be unverified or replaced at BATCH … ADMIN; the stage stays and neither E17 nor the officers check the mark. Pull the
   student back, block, or keep?
3. **Edits after approval.** A form can be changed while officers decide; approvals already given are not reset and the officer is only shown the change. Intended?
4. **Mobile.** Editing `mobile_number` in the form does not change the account's mobile, which the list, search, filter and `tel:` links use.
5. **Name.** The list, search and batch show the account's name (with middle name); the student page heading and download names use the form's name. They differ when the
   student typed another name; E12 aligns only first and last name.
6. **Three label sets for the same stage** (2.1): tile / list, filter, student page badge.
7. **`approval` for drafts**: an object with null stage in E5, `null` in E6. Harmless; keep one.
8. **Malformed ids**: 422 "Validation failed" today, so `/manage/applicants/abc` and `/manage/batches/abc` show that text; the pages expect 404. Recommended: 404.
9. **Duplicate batch name**: 409 without details, shown on top. With `details: [{ field: 'body.name' }]` the page would also mark the box (recommended).
10. **Leftover students**: fewer waiting students of a district than the batch size can never be batched unless an ADMIN lowers the size for everyone.
11. **No undo**: no way to take back an approval, or to remove a student from a batch, or to delete a batch. Confirm.
12. **Batch centre's district** is not checked against the batch's district. Intended?
13. **First 100 centres only** (S2): with more active centres the rest cannot be chosen, and an active centre outside the first 100 is shown as "(inactive)" on the batch page.
14. **"skipped" wording** of Approve selected says "already approved or not submitted", but unverified documents are skipped too.
15. **`last_activity_at`** = the latest change of the account or application row, so it also moves by the panel's edits and by logins. Define what it should mean.
16. **`uploaded_at`** of a file is the row's last update; moving the files at submission resets it to the submission time.
17. **Final verification / documents filters** count drafts and empty accounts as NOT_VERIFIED.
18. **Panel users**: no password change or reset, no edit, role change or delete. Needed?
19. **Last ADMIN**: only self-deactivation is refused; two ADMINs can deactivate each other at the same time.
20. **Login 422** (e.g. an invalid email) shows only "Validation failed"; the details are ignored.
21. **Edit form without options**: if S1 fails the page stays on "Loading…" for ever. After a successful upload whose re-read (E6) fails, the page says "Upload failed".
22. **Search box** has no length limit; more than 100 characters is a 422 shown as "Validation failed".
23. **Stale role in the browser**: a role change is enforced at once by the server, but the buttons change only after a reload.
24. **Rate limit**: 300 requests / 15 min / IP is low for several auditors behind one address.
25. **Two auditors editing one form**: no version check; the last save wins per field.
26. **Users page text** says a Viewer sees the applicants and the Center Master; a Viewer also sees Batches, the other masters and Settings.
27. **Settings/batch read**: a VIEWER may read it but the list does not ask for it (no batch buttons). The batch size appears to everyone in `meta.size` of E16.
28. **Legacy only, not needed in a new backend**: `EDP-` registration prefix shown as `IPP-`, forms kept in the student register, batches without district or size,
    "Not in a batch" students, `documents` fallback to register files.
29. **E5 `approval` parameter** is a leftover of a former dropdown; the pages no longer send it.
30. **Auditor vs ADMIN vs Admin**: the panel role ADMIN is "the Auditor"; the approval stage ADMIN is another person (the final approver). Keep the names apart in the new code.
