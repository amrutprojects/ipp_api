# 03 — Masters of the Auditor panel, and the gaps against the 5174 admin panel

Status: read-only analysis, 25 Nov 2026. Nothing was changed in the frontend, the reference API or the admin panel.

| Source | Path |
|---|---|
| Frontend (5176) | `D:\Sarthi\EDP-Candidates-Registration`, commit `4a5d910` (`src/pages/manage/masters/*`, `src/pages/manage/Centre*.tsx`, `ManageLayout.tsx`, `CreateBatchDialog.tsx`, `Batch*Page.tsx`, `src/types.ts`, `src/api.ts`, `src/form.ts`, `src/validation.ts`, `src/components/ui.tsx`; tests `masters.test.tsx`, `centres.test.tsx`, `validation.extra.test.ts`, `form-fields.test.tsx`, `batches.test.tsx`) |
| Reference API (5001) | `D:\Sarthi\amrut-kalash-api`, commit `d9f3638` (`src/modules/students/edp/program*.ts`, `edp.routes.ts`, `edp-batch.service.ts`; `src/masters/centre`; `src/cms/masters/*`; migration `1799300000000-ProgramMasters.ts`; seeds; `tests/e2e/edp-portal.e2e.test.ts` from line 2575) |
| Admin panel (5174) | `D:\Sarthi\amrut-kalash-admin`, commit `bf827d7` (`src/constants/navigation.ts`, `src/features/cms/**`, `src/modules/masters`, `src/modules/users`) |

The seed values in section 10 were extracted from the source files by script and compared with the running local API
(`GET /api/v1/edp/options`): identical, except `HSC_DIPLOMA` (question Q4).

Contents: [1 Conventions](#1-conventions-of-every-call) · [2 Shared UI](#2-shared-ui-behaviour) · [3 Dropdown lists](#3-dropdown-lists) ·
[4 Technologies](#4-technologies-and-district-wise-technologies) · [5 Documents](#5-documents) · [6 Form fields](#6-form-fields) ·
[7 Districts](#7-districts) · [8 Center Master](#8-center-master) · [9 Where the masters are used; data model](#9-where-the-masters-are-used-and-data-model) ·
[10 Seed data](#10-seed-data-for-an-empty-database) · [A Endpoints](#a-table-of-endpoints) · [B Business rules](#b-business-rules) ·
[C Gap analysis and recommendations](#c-gap-analysis-and-recommendations) · [D Unclear](#d-unclear-decisions-needed)

---

## 1. Conventions of every call

- **Base path**: `${VITE_API_BASE_URL || '/api/v1'}/edp`. All paths below are relative to it (`/manage/masters` = `/api/v1/edp/manage/masters`).
- **Auth**: `Authorization: Bearer <token>` from `localStorage['edp.manage.token']` on every `/manage/*` call. The `/geography/*` calls are made
  **without any token** (`useRemoteList(path)` is called without a realm), so they must stay public (or the frontend must change).
- **Roles**: `GET /manage/me` → `role: 'ADMIN' | 'VIEWER'`. `useCanEdit()` = `role === 'ADMIN'`. The UI hides every write control from a VIEWER;
  the API must still refuse every write with **403** `Your account can only view. Ask an administrator to make this change.` A student token or
  no token on `/manage/*` → **401**.
- **Success envelope**: `{ success: true, status, message, data, meta? }`; the UI reads `data`, `meta`, `message`.
  Any 2xx is accepted; the reference uses 200 (GET/PATCH/PUT/DELETE, DELETE with `data: null`) and 201 (POST).
- **Error envelope**: `{ success: false, status, message, data: null, error: { code, details?: { field?, message }[], requestId? } }`.
  The UI turns `details` into field errors: a leading `body.` (or `body.data.`) is removed from `field`, the first message per field wins
  (`body.name_en` → `name_en`, `districtId` → `districtId`, `body.options.0.name_en` → `options.0.name_en`).
- **Paging**: `meta = { page, limit, total, totalPages }`. `meta.page` must echo the requested page (not a clamped one): when
  `meta.page > meta.totalPages > 0` the list itself moves to the last page. `totalPages` is at least 1. `limit` must accept 100.
- **Validation errors are 422** (`VALIDATION_ERROR`, message `Validation failed`). Wrong references of centers, districts and talukas are **400** with a field
  (`districtId`, `talukaId`, `stateId`, without the `body.` prefix). Duplicates and refused deletes are **409**. Unknown ids are **404**.
  Path ids that are not UUIDs → 422 (`params.id`, `Must be a valid UUID`).
- **401** on any `/manage` call: the UI removes the token and goes to `/manage/login`. Network failure: `Could not reach the server. Check your internet connection and try again.`
- **Unknown body keys are refused** (422, `.strict()`); unknown query keys are ignored.
- **Text clean-up on the server** for names, labels, help texts: Unicode NFC, inner whitespace collapsed to one space, trimmed; control characters
  refused (`<Label> contains characters that cannot be saved`); blank optional text (`''`) means `null` (cleared).
- **Audit**: every write is logged with the panel user's id. Actions: `edp.master.create|update|delete`, `edp.master.district_technologies`,
  `edp.document.create|update|delete`, `edp.field.create|update|delete`, `edp.district.create|update|delete`, `cms.centre.create|update|status|delete`.
- **Concurrency**: creates and updates of one list are serialised (advisory lock per kind / fields / documents) so that order numbers, codes and
  duplicate checks cannot race; unique indexes are the last guard (violation → 409).

> **Message rule worth adding.** Only the dialogs show field errors. The Active switch, the delete confirmation and "Save technologies" show
> `message` only, so a 422 there reads `Validation failed`. Recommended: when a 422 has exactly one detail, send that detail's text as `message`.

---

## 2. Shared UI behaviour

- **Navigation** (`MastersNav`, inside `ManageNav` → *Masters*): Dropdown lists `/manage/masters/lists` · Technologies `/manage/masters/technologies` ·
  Documents `/manage/masters/documents` · Form fields `/manage/masters/fields` · Districts `/manage/masters/districts` · Center Master `/manage/centres`.
  `/manage/masters` redirects to `/manage/masters/lists`. The *Masters* tab is also active under `/manage/centres*`.
- **Route guards**: all master pages need a signed-in panel user; `/manage/centres/new` and `/manage/centres/:id/edit` need ADMIN (a VIEWER is sent to `/manage/centres`).
- **Status switch** (`role="switch"`, name `<row name>: active`, text Active / Inactive): sends `PATCH … { is_active }` at once, **no confirmation**; disabled
  while the request runs; on success only the local row changes (the response body is not read); on failure the message is shown above the table and
  the switch stays as it was. VIEWER (or a core field) sees a badge instead.
- **"Used" column** (`InUse`): falsy → `—`; `true` → badge `In use`; a number → `Used on N form(s)`. Informational only.
- **Add / Edit dialog** (`FormDialog`): local checks first; then the request. On failure, field errors go to their fields and on top appears
  `Please correct: <all field messages>` for a 422 with fields, else the API's `message` (fallback `Could not save`). Cancel / Escape / backdrop close it (not while saving). Button text while busy: `Saving…`.
- **Edit sends only what changed.** Nothing changed → no request at all, and the success notice is still shown.
- **Delete** (`ConfirmDelete`, alert dialog `Delete <name>?`, buttons Cancel / `Yes, delete`, busy `Deleting…`); a refusal (409 …) is shown inside the dialog and it stays open.
- **Order field**: text input; blank allowed on add (= at the end) and on edit (= unchanged); otherwise `^\d{1,5}$`, else `Order must be a whole number`. Sent as a JSON number. Server: integer 0–100000. Seeds use steps of 10; equal orders are ordered by English name.
- **After a save**: the dialog closes, a green notice (`<name> added.` / `<name> saved.` / `<name> deleted.`), the list is loaded again.
- **View-only notice** `View only: your account can see the masters but not change them.` is shown on Dropdown lists, Form fields and Districts; it is
  **missing** on Technologies, Documents and Center Master (the header still shows the badge `View only`).

---

## 3. Dropdown lists

**Route** `/manage/masters/lists/:kind?` (`ListsPage` + `MasterList`). No kind → the first list. Unknown kind (also `TECHNOLOGY`) → notice `There is no such list.`

Left: one link per list (`GET /manage/masters`, without `TECHNOLOGY`, in the API's order): list name and `<active> of <count> active`. Right: the open list.

### 3.1 List of one kind (`MasterList`)

| Item | Detail |
|---|---|
| Columns | Order · Name (English) (bold; under it, when `is_system`: `Built in: can be renamed and switched off, not deleted.`) · Name (Marathi) (`—` when empty) · Status (switch) · Used · Actions (ADMIN only) |
| Filters | Search box (placeholder `Search`, sent 400 ms after typing stops, trimmed); Status: All statuses / Active / Inactive. Both go back to page 1 |
| Paging | 25 per page, `← Previous` `Page x of y` `Next →` (hidden with one page); `<total> in the list` |
| Order | server: `order`, then English name |
| Empty | `Loading…` / `Nothing matches.` (search or status set) / `Nothing in the list yet.` |
| Buttons | `+ Add` (ADMIN and `can_add`) · `Edit` · `Delete` (only when `can_delete` and not `is_system`) |
| Delete note | `It is no longer offered to students. Forms that already use it keep showing its name.` |
| VIEWER | no Add, no Actions column, status as a badge, view-only notice |

### 3.2 Dialog (Add to *list* / Edit *name*)

| Field | Key | Type | Required | Limits in the UI | UI message | Hint |
|---|---|---|---|---|---|---|
| Name (English) | `name_en` | text | yes | maxlength 200 | `English name is required`; `English name must be at most 200 characters` | |
| Name (Marathi) | `name_mr` | text, `lang=mr` | no | 200 | `Marathi name must be at most 200 characters` | `Left blank: the English name is shown in Marathi too.` |
| Order | `order` | digits | no | `\d{1,5}` | `Order must be a whole number` | `Its place in the list; left blank: at the end.` |

`is_active` is not in the dialog (new rows are active; the switch changes it). The code is never typed or shown.

### 3.3 Calls

```ts
interface MasterKind {            // GET /manage/masters → MasterKind[]
  kind: string;                   // see 3.4, in this order
  name: string;                   // the form field's CURRENT English label (renaming the field renames the list)
  count: number;                  // not deleted
  active: number;
  can_add: boolean;               // false for GRADING_TYPE
  can_delete: boolean;            // false for GRADING_TYPE
  stored_as: 'code' | 'master';   // 'master' for CASTE, EDUCATION, REGION; not read by the UI
}
interface MasterOption {          // one choice
  id: string;                     // uuid of the row (used in PATCH / DELETE)
  value: string;                  // what a form stores: see 3.4; never changes
  code: string;
  name_en: string;
  name_mr: string | null;
  order: number;
  is_active: boolean;
  is_system: boolean;             // cannot be deleted
  in_use: boolean | number;
}
```

| Call | Request | Success | Errors (text as in the reference API) |
|---|---|---|---|
| `GET /manage/masters` | — | 200 `MasterKind[]` (includes TECHNOLOGY) | UI fallback `Could not load the lists` |
| `GET /manage/masters/:kind` | query `page`, `limit` (25; 100 from Technologies), `search?` (≤ 100 characters, matches English name, Marathi name or code, case-insensitive, literal), `status?` = `ACTIVE`\|`INACTIVE` (also supported, unused by the UI: `sortBy=order\|name`, `sortOrder`) | 200 `MasterOption[]` + `meta` | 404 `List not found` (well-formed but unknown kind, or a `FIELD:` kind whose field is deleted or no longer a dropdown); 422 `params.kind` `Unknown list` (not `^([A-Z]+(_[A-Z]+)*\|FIELD:x_[a-z0-9_]{1,40})$`); UI fallback `Could not load the list` |
| `POST /manage/masters/:kind` | `{ name_en, name_mr?, order?, is_active? }` (UI never sends `is_active`) | 201 `MasterOption` | 409 `"<name>" is already in this list.`; 409 linked lists `"<name>" is already in this list as "<english name>".`; 409 fixed list `This list is fixed: its entries can be renamed and switched on or off, not added or deleted.`; 422 `body.name_en` `Name is required` / `Name must be at most <max> characters` (per kind, 3.4; same text for `name_mr`) / CGPA scale `Enter the scale as a whole number from 1 to 100`; `body.order` `Order must be a number` / `Order must be a whole number` / `Order must be 0 or more` / `Order must be at most 100000` |
| `PATCH /manage/masters/:kind/:id` | any of `{ name_en, name_mr (null or '' clears), order, is_active }` | 200 `MasterOption` | 404 `Entry not found in this list`; 409 duplicate; 422 as above, or `Nothing to change` (empty body) |
| `DELETE /manage/masters/:kind/:id` | — | 200 `null` | 404; 409 fixed list (system entry) |

`:kind` arrives URL-encoded (`FIELD%3Ax_shift`).

### 3.4 The kinds

| Kind (this order) | List name today | Form field | Stored value | Longest name (server) | Add / delete | Shown to students |
|---|---|---|---|---|---|---|
| `CASTE` | Caste | `caste_id` | row id | 80 | yes | Marathi name in both languages |
| `EDUCATION` | Education Qualification | `education_id` | row id | 150 | yes | chosen language |
| `REGION` | Course District | `region_id` | row id | 150 | yes | chosen language |
| `RELIGION` | Religion | `religion` | code | 60 | yes | Marathi name in both languages |
| `GENDER` | Gender | `gender` | code | 20 | yes | chosen language |
| `MARITAL_STATUS` | Marital Status | `marital_status` | code | 20 | yes | chosen language |
| `EDUCATIONAL_STATUS` | Educational Status | `educational_status` | code | 100 | yes | chosen language |
| `GRADING_TYPE` | Grading Type | `grading_type` | code | 60 | **no** (system) | chosen language |
| `CGPA_SCALE` | CGPA Scale | `cgpa_scale` | code (the number) | 60 | yes | `Out of 10` / `10 पैकी` when the name is a number |
| `QUALIFICATION_CLASS` | Class / Division | `qualification_class` | code | 40 | yes | chosen language |
| `TECHNOLOGY` | Technology | `technology` | code `T01`… | 120 | yes | chosen language |
| `FIELD:<key>` | Choices of *label* (inline on Form fields) | own dropdown | code | 100 | yes | chosen language |

Generated on create (never typed, never changed by a rename):

- **Code lists**: code = the English name as entered; if that code is taken by a not-deleted row, `"<name> (2)"`, `(3)`…
- **CGPA_SCALE**: `String(Number(name))`; taken → 409. Only create checks the number; a rename may be any text (the code keeps the number).
- **TECHNOLOGY**: next `T<nn>` after the highest number ever used, deleted rows included (T13, T14 …).
- **CASTE / EDUCATION / REGION**: reference API makes an inactive row in `castes` / `educations` / `regions` with code `IPP_C<n>` / `IPP_E<n>` / `IPP_R<n>`, or re-uses the row of the same name (so a deleted caste added again gets its old value back). With its own database the new backend needs no linked tables: an ordinary row, `value = id`, a generated code. Keep the **re-use of a deleted row with the same name** so that old forms and new ones hold the same value.

---

## 4. Technologies and district-wise technologies

**Route** `/manage/masters/technologies` (`TechnologiesPage`): section *Technologies* (= `MasterList` of kind `TECHNOLOGY`, all of section 3) and below it the card *District-wise technologies*.

Text: `The technologies a student can choose depend on the student's district only. A district with nothing selected offers every active technology.`

| Element | Detail |
|---|---|
| District (select) | `Select district`, then every district of the response as `<district> – All technologies` or `<district> – <n> selected` (n = number of `codes`) |
| After choosing | fieldset `Technologies of <district>`: radio `All technologies` / `Only the ticked ones`; with the second, one checkbox per technology: code (grey) and English name, ` (inactive)` for an inactive one. Offered = active ones, plus inactive ones still selected |
| Save (ADMIN) | nothing ticked with "Only the ticked ones" → `Tick at least one technology, or choose All technologies.` (no request). "All technologies" sends `codes: []`. Done: `Technologies of <district> saved.` and the option text of the select changes locally |
| VIEWER | radios and boxes disabled, no Save |
| Reload | both lists are loaded again after any change in the Technologies list above |

```ts
interface DistrictTechnologies { district_id: string; district: string; all: boolean; codes: string[] }
```

| Call | Request | Success | Errors |
|---|---|---|---|
| `GET /manage/technologies/districts` | — | 200 `DistrictTechnologies[]`: **active** districts, A–Z. `codes` = selected, not deleted (also inactive) technologies in master order; `all` = none of them is active | UI fallback `Could not load the district-wise technologies` |
| `GET /manage/masters/TECHNOLOGY?page=1&limit=100` | — | as 3.3 (so more than 100 technologies would not all be shown) | same |
| `PUT /manage/technologies/districts/:districtId` | `{ codes: string[] }` — upper-cased, ≤ 200, no duplicates; replaces the selection; `[]` = all | 200 the district's `DistrictTechnologies` (body not read by the UI) | 404 `District not found` (deleted or unknown); 422 `body.codes` `Choose technologies of the Technology master only` (inactive ones are allowed) / `Each technology may be listed only once` / `At most 200 technologies`; UI fallback `Could not save the technologies` |

Rule for a student: active selected technologies of the district; if the district has none selected, or none of the selected ones is active any more, every active technology. `GET /options` sends `district_technologies: Record<district id, code[]>` with only the districts that have an active selection.

---

## 5. Documents

**Route** `/manage/masters/documents` (`DocumentsMasterPage`) — what students upload in step 3. Text: `What students upload in step 3, in this order. A document that is switched off is no longer asked; files already uploaded stay.`

| Item | Detail |
|---|---|
| Columns | Order · Name (English) · Name (Marathi) · File (`Document` / `Video`) · Required (`Required` / `Optional`) · Status (switch) · Used · Actions (ADMIN) |
| Filters, paging | none: the whole list, sorted by `order` in the browser |
| Buttons | `+ Add document`, `Edit`, `Delete` (not for `is_system`) |
| Empty | `No documents yet.` |
| Delete note | `It is no longer asked. Files already uploaded stay with their forms.` |

| Field | Key | Type | Required | Limits / messages | Add | Edit |
|---|---|---|---|---|---|---|
| Name (English) | `name_en` | text | yes | UI 200 (server 150); `English name is required` | ✓ | ✓ |
| Name (Marathi) | `name_mr` | text | no | UI 200 (server 150) | ✓ | ✓ (blank sends `null`) |
| File | `kind` | select `Document (PDF, JPG, PNG)` = `DOCUMENT`, `Video (MP4)` = `VIDEO` | yes | default DOCUMENT | ✓ | never changes |
| Required: the form cannot be submitted without it | `required` | checkbox | — | default on | ✓ | ✓ |
| Order | `order` | digits | no | as section 2 | ✓ | ✓ |

```ts
type DocumentKind = 'DOCUMENT' | 'VIDEO';
interface MasterDocument { id: string; code: string; name_en: string; name_mr: string | null; required: boolean;
  is_active: boolean; is_system: boolean; kind: DocumentKind; order: number; in_use: boolean | number }
```

| Call | Request | Success | Errors |
|---|---|---|---|
| `GET /manage/documents` | — | 200 `MasterDocument[]` (also switched-off ones; by order, creation, code) | UI fallback `Could not load the documents` |
| `POST /manage/documents` | `{ name_en, name_mr?, required, kind, order? }` (server also `is_active?`; defaults required true, kind DOCUMENT, active) | 201 `MasterDocument`, code `IPP_DOC_<n>` (next number, deleted included), `is_system: false` | 409 `A document named "<name>" already exists.` (case-insensitive, not deleted); 422 `Name is required`, `Name must be at most 150 characters`, `Choose Document or Video` |
| `PATCH /manage/documents/:id` | any of `{ name_en, name_mr, required, order, is_active }` (`kind` refused: 422) | 200 `MasterDocument` | 404 `Document not found`; 409; 422 |
| `DELETE /manage/documents/:id` | — | 200 `null` | 404; 409 `This document is part of the program and cannot be deleted. Switch it off instead.` |

`in_use` = any stored file of this document's code. It blocks nothing: an own document in use may be deleted, its files stay and are still shown with their last name. Upload rules follow `kind`: DOCUMENT = PDF / JPG / JPEG / PNG ≤ 5 MB, VIDEO = MP4 ≤ 50 MB (content checked, not the name).

---

## 6. Form fields

**Route** `/manage/masters/fields` (`FormFieldsPage`). Text: `Labels, help texts and own fields appear in every login.` then a lock icon and `Core field: the program needs it, so it is always asked. It can be renamed, reordered and given a help text.`

Two tables, *Step 1 – Basic Details* and *Step 2 – Main Form*, each with `+ Add field` (ADMIN). No search, no paging; sorted by step, order in the browser.

| Item | Detail |
|---|---|
| Columns | Order · Label (English) (with `Core` + lock and the reason as title, or badge `Own field`; help text under it) · Label (Marathi) · Type (Text / Long text / Number / Date / Dropdown) · Required · Status (switch; **core**: badge with the reason) · Actions (the column stays for a VIEWER) |
| Edit | ADMIN, every field |
| Delete | ADMIN, only own fields (`custom`). Note: `It is no longer asked or shown. Answers already given stay stored.` |
| Choices (dropdowns, also for a VIEWER) | `district_id` → `/manage/masters/districts`; `centre_id` → `/manage/centres`; `TECHNOLOGY` → `/manage/masters/technologies`; other kind → `/manage/masters/lists/<kind>`; own dropdown → opens `MasterList` of `FIELD:<key>` inline (`Choices of <label>`); `disability_status` (no list) → no button |

### 6.1 What each kind of field allows

| | Core (16) | Built in, not core (20) | Own (`custom`) |
|---|---|---|---|
| Labels, help texts, order | ✓ | ✓ | ✓ |
| Required, Active | never (always required and active) | ✓ | ✓ |
| Step, Type, choices | never | never | ✓ |
| Delete | never | never (switch off) | ✓ |

### 6.2 Add a field (own field)

| Field | Key | Required | Limits / messages |
|---|---|---|---|
| Label (English) | `label_en` | yes | 150; `English label is required` |
| Label (Marathi) | `label_mr` | no | 150; hint `Left blank: the English label is shown in Marathi too.` |
| Step | `step` (number 1 or 2) | yes | preset to the table's step; hint `It is asked at the end of the step, under "Additional details".` |
| Type | `type` | yes | `TEXT` (default), `TEXTAREA`, `NUMBER`, `DATE`, `DROPDOWN` |
| Choices (dropdown only) | `options: { name_en, name_mr? }[]` | ≥ 1 | 2 blank rows, `+ Add a choice`, `Remove` (last row stays); each name ≤ 100; blank rows ignored; `Every choice needs an English name` / `Add at least one choice` |
| Required: the step cannot be completed without it | `required` | — | default off |

### 6.3 Edit a field

Label (English) `label_en`, Label (Marathi) `label_mr`, Help text (English) `help_en` ≤ 300 (`Shown under the field.`), Help text (Marathi) `help_mr` ≤ 300, Order `order` (`Its place within the step.`); own: Step, Type (`Answers already given are kept as they are.`), and Choices when an own field **becomes** a dropdown; not core: Required, `Active: asked in the form`. Cleared Marathi label / help → `null`. Only changed keys are sent.

```ts
type FieldType = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'DATE' | 'DROPDOWN';
interface MasterField { id: string; key: string; step: number; label_en: string; label_mr: string | null; required: boolean;
  is_active: boolean; order: number; core: boolean; custom: boolean; type: FieldType;
  options_kind: string | null;   // kind of its list; FIELD:<key> for an own dropdown; null otherwise (also district_id, centre_id, disability_status)
  help_en: string | null; help_mr: string | null }
```

| Call | Request | Success | Errors |
|---|---|---|---|
| `GET /manage/fields` | — | 200 `MasterField[]` (all not deleted, active or not) | UI fallback `Could not load the fields` |
| `POST /manage/fields` | `{ step, label_en, label_mr?, type, required, options? }` (server also `order?`, `is_active?`, `help_en?`, `help_mr?`) | 201 `MasterField`, at the end of the step (highest order + 10) | 422 `body.label_en` `Label is required`; `body.step` `Choose step 1 or 2`; `body.type` `Choose a type`; `body.options` `Add at least one choice` / `Only a dropdown has choices` / `Each choice may be listed only once` / `At most 200 choices`; `body.options.<i>.name_en` `Name must be at most 100 characters` |
| `PATCH /manage/fields/:id` | any of `{ label_en, label_mr, help_en, help_mr, order, required, is_active, step, type, options }` | 200 `MasterField` | 404 `Field not found`; 409 core `This field is part of every form: only its labels, help text and order can be changed.`; 409 built in `Only the labels, help text, order, required and active of this field can be changed.` (both only when the sent value **differs**); 422 `body.options` `Add at least one choice` (the type becomes DROPDOWN without any choice) / `Only a dropdown has choices`; 422 `Nothing to change`; 409 `A choice with this name is already in the list.` (race) |
| `DELETE /manage/fields/:id` | — | 200 `null` | 404; 409 core (text above) or `This field is part of the form and cannot be deleted. Switch it off instead.` |

Own field key: `x_` + label in a–z, 0–9, `_` (NFKD, ≤ 36 characters; nothing left, e.g. a Marathi label → `x_field`), `_2`, `_3`… when the key was ever used (deleted keys are never given again). `options` on PATCH adds the choices the list does not have yet. Changing a dropdown to another type keeps its choices stored; its list then answers 404 until it is a dropdown again. Answer limits of own fields: TEXT 250, TEXTAREA 2000, NUMBER `^-?\d{1,12}(\.\d{1,4})?$`, DATE real `YYYY-MM-DD`, DROPDOWN one of the active choices.

---

## 7. Districts

**Route** `/manage/masters/districts` (`DistrictsPage`).

| Item | Detail |
|---|---|
| Columns | # (running number) · Name · Code (mono) · State · Status (switch) · Used · Actions (ADMIN) |
| Filter | search `Search name or code`, in the browser only; `<n> district(s)`. No status filter, no paging |
| Order | as the API sends: name A–Z |
| Buttons | `+ Add district`, `Edit`, `Delete` (every row, also one in use) |
| Delete note | `It is no longer offered. A district that is in use cannot be deleted; switch it off instead.` |
| Empty | `No districts match.` / `No districts yet.` |
| Notices | `District <name> added.` / `saved.` / `deleted.` |

| Field | Key | Required | UI rule | Server rule |
|---|---|---|---|---|
| Name | `name` | yes | maxlength 100; `Name is required` | 2–100 (`Must be at least 2 characters` / `Must be at most 100 characters`), `^[\p{L}\p{M}][\p{L}\p{M}\d .,'’()/-]*$` (`Use letters, digits, spaces and . , ( ) - / only`) |
| Code | `code` | no | upper-cased; `^[A-Za-z0-9-]{2,20}$`, else `Code: 2–20 characters, A–Z, 0–9 and hyphen`; hint `A–Z, 0–9 and hyphen; left blank: made from the name.` | 2–20, `^[A-Z][A-Z0-9-]*$` (`Use A–Z, 0–9 and hyphen, starting with a letter`) |
| State (Add only, only when more than one state) | `state_id` | no | `Maharashtra (default)` + the states; error read from `state_id` or `stateId` | active state; none → `MH`, else the state with the most districts; no state at all → 422 `body.state_id` `Choose a state` |

```ts
interface District { id: string; name: string; code: string; state: string; is_active: boolean; in_use: boolean }  // + state_id in the API
```

| Call | Request | Success | Errors |
|---|---|---|---|
| `GET /manage/districts` | — | 200, every not-deleted district (inactive too), by name | UI fallback `Could not load the districts` |
| `POST /manage/districts` | `{ name, code?, state_id? }` (server also `is_active?`) | 201 row | 409 `A district with this name already exists in the selected state` / `… with this code …`; 400 `The selected state does not exist` / `… is inactive` (field `stateId`); 422 |
| `PATCH /manage/districts/:id` | any of `{ name, code, is_active }` | 200 row | 404 `District not found`; 409; 422 |
| `DELETE /manage/districts/:id` | — | 200 `null` | 404; 409 `This district cannot be deleted while <n> taluka(s) reference it. Deactivate it instead, or move or delete the talukas first.` / `… while 1 center … reference it. Deactivate it instead, or remove those records first.` |
| `GET /geography/states` (Add dialog, no token) | — | 200 `{ id, name, code }[]` active, A–Z | list stays empty, so no State field |

Generated code: the name's A–Z letters (NFKD, upper case), first 6 (`Dharashiv` → `DHARAS`), fewer than 2 letters → `DIST`; taken in the state → `DHARAS2`, `3`…

Reference behaviour that must be decided (see rule B-21 and Q7): `in_use` = a student's form names the district; the delete checks talukas, colleges, training centres, centers and documents, **not** student forms, batches or officers, although the note says a used district cannot be deleted. Edit with the code emptied sends `code: ''`, which the reference treats as "not sent" (alone: 422 `Nothing to change`). The reference saves name/code and status in two transactions; do it in one.

---

## 8. Center Master

Shape is camelCase (unlike the other masters).

```ts
interface Centre {
  id: string; name: string; code: string;
  stateId: string; stateName: string; stateCode: string; stateIsActive: boolean;      // derived from the district
  districtId: string; districtName: string; districtCode: string; districtIsActive: boolean;
  talukaId: string | null; talukaName: string | null; talukaCode: string | null; talukaIsActive: boolean | null;
  address: string | null; pinCode: string | null; contactPerson: string | null; contactNumber: string | null; email: string | null;
  technologies: { code: string; name: string; usable: boolean }[];   // no longer shown: send []
  isActive: boolean; createdAt: string; updatedAt: string;           // ISO
}
```

### 8.1 List — `/manage/centres` (`CentresPage`)

| Item | Detail |
|---|---|
| Columns | # (continues over pages) · Name · Code · District · Status (badge) · Actions |
| Filters | search `Search name, code or district` (400 ms); status All statuses / Active (`true`) / Inactive (`false`); `<n> center(s)` |
| Paging | 25, `← Previous / Next →`; order name A–Z (server default `sortBy=name`, `ASC`) |
| Buttons | `Refresh`; ADMIN: `+ Add center`, per row `Edit`, `Deactivate` / `Activate`; everybody: `View`. **No delete** |
| Flash | text from the previous page (`Center created.` is shown on the detail page) |
| Empty | `Loading…` / `No centers match.` |
| Footer text | `Centers are shared with the Amrut admin panel (Center Master). Only active centers are offered to students in the registration form. The technologies a student can choose depend on the student's district (Technologies).` → wrong once the portal has its own database (C.4, R4) |

### 8.2 Status dialog (list and detail)

Title `Activate <name>?` / `Deactivate <name>?`; text `The center will be offered to students again in the registration form.` / `Students will no longer be able to choose this center in the registration form. Existing registrations are kept.`; buttons Cancel, `Yes, activate` / `Yes, deactivate`. → `PATCH /manage/centres/:id/status { isActive }`.

### 8.3 Detail — `/manage/centres/:id` (`CentreDetailPage`)

Name, Code, State, District, Taluka (each with ` (inactive)` when its master is), PIN Code, Address, Contact Person, Contact Number, Email, Status, Created, Last updated (`—` when empty). ADMIN: `Edit`, `Deactivate`/`Activate` (notice `Center activated.` / `Center deactivated.`). Link `← Back to Center Master`.

### 8.4 Form — `/manage/centres/new`, `/manage/centres/:id/edit` (`CentreFormPage`, ADMIN)

| Field | Key | Required | UI rule and message | Server rule |
|---|---|---|---|---|
| Center Name | `name` | yes | 2–150 after collapsing spaces; `Name is required`, `Name must be 2–150 characters`, `Use letters, digits, spaces and . , ( ) - / & only` (first character a letter or digit) | same; unique in the district (case-insensitive) |
| Code | `code` | yes | upper-cased; `^[A-Z][A-Z0-9-]{1,19}$`; `Code is required`, `Code: 2–20 characters, A–Z, 0–9 and hyphen, starting with a letter`; hint `A–Z, 0–9 and hyphen, starting with a letter (e.g. PUN-01).` | same; unique overall |
| State | `stateId` | yes | `State is required`; select from `/geography/states`; changing it clears District and Taluka | only cross-checks the district |
| District | `districtId` | yes | `District is required`; from `/geography/states/:id/districts`; changing it clears Taluka | must exist and be active (unchanged: not re-checked) |
| Taluka | `talukaId` | no | from `/geography/districts/:id/talukas`; hint `No talukas in this district.` when empty | active, of that district |
| PIN Code | `pinCode` | no | digits, 6; `Enter a 6-digit PIN code` | `^\d{6}$` |
| Address | `address` | no | ≤ 300; `Address must be at most 300 characters` | ≤ 300 |
| Contact Person | `contactPerson` | no | ≤ 120; `Contact person must be at most 120 characters`; `Contact person may contain only letters, spaces and . ' -` | same |
| Contact Number | `contactNumber` | no | `^(?:[6-9]\d{9}\|0\d{2,4}-?\d{6,8})$` after removing spaces; `Enter a 10-digit mobile number or a landline with STD code` | spaces removed, same |
| Email | `email` | no | ≤ 254; `Enter a valid email address` | lower-cased, ≤ 254 |
| Status (Add only) | `isActive` | — | Active / Inactive, default Active | boolean |

A saved state / district / taluka that is no longer active stays selectable as `<name> (inactive)`. Buttons: Cancel, `Create center` / `Save changes` (`Saving…`). Local errors → `Please correct the highlighted fields.`; 422 with fields → same text; other errors → the API's message, with fields highlighted when given; fallback `Could not save the center`. Success → detail page with `Center created.` / `Center updated.`

| Call | Request | Success | Errors |
|---|---|---|---|
| `GET /manage/centres` | `page`, `limit=25`, `search?`, `isActive?` (`true`/`false`); from Create batch and the batch page: `page=1, limit=100, isActive=true, sortBy=name, sortOrder=ASC` (more than 100 active centers would not all be offered). Server also: `sortBy` code, districtName, createdAt, updatedAt; `stateId`, `districtId`, `technologyCode` | 200 `Centre[]` + meta | 400 `The selected district does not exist`; UI fallback `Could not load the centers` |
| `GET /manage/centres/:id` | — | 200 `Centre` | 404 `Center not found` |
| `POST /manage/centres` | `{ stateId?, districtId, talukaId?, name, code, address?, pinCode?, contactPerson?, contactNumber?, email?, isActive }` (blank ones left out; `technologyCodes` no longer sent) | 201 `Centre` (its `id` is used to navigate) | 409 `A center with this name already exists in the selected district` / `A center with this code already exists`; 400 `The selected district does not belong to the selected state` (`districtId`), `The selected taluka does not belong to the selected district` (`talukaId`), `The selected district is inactive` / `does not exist` (same for taluka); 422 |
| `PATCH /manage/centres/:id` | the same keys; blank optional ones as `null`; no `isActive` (the form always sends all of them, also `stateId` and `talukaId`) | 200 `Centre` | as POST; 404; 400 `Choose a taluka of the new district, or none, when moving the center` (district changed without `talukaId`) |
| `PATCH /manage/centres/:id/status` | `{ isActive: boolean }` | 200 `Centre` | 404 |
| `GET /geography/states` | no token | 200 `GeoRef[]`, active, A–Z | hint `Could not load the states.` |
| `GET /geography/states/:stateId/districts` | no token | 200 `GeoRef[]` (+ `stateId`), active, A–Z; an inactive state still lists its districts | 404 `State not found`; hint `Could not load the districts.` / `No districts in this state.` |
| `GET /geography/districts/:districtId/talukas` | no token | 200 `GeoRef[]` (+ `districtId`; `code` may be null) | 404 `District not found`; hint `Could not load the talukas.` |

In the reference API and **not** called by the frontend: `DELETE /manage/centres/:id` (409 `This center is used by student applications or registrations. Deactivate it instead.`), `GET /manage/technology-options`, `GET /districts/:id/talukas`, `GET /centres/:id/technologies`. Only the first is recommended (R4).

---

## 9. Where the masters are used, and data model

- **Student form and Auditor's Edit form**: `GET /options` (public) → `fields` (active, by step and order; `label_mr` falls back to English), `lists` (kind → `{ value, name_en, name_mr }[]`, active, in order; also `FIELD:<key>`), `districts` / `centres` (`{ id, name, code, district_name }`, active, A–Z), `document_types` (active, in order: `id, code, name, name_mr, is_mandatory, kind, barcode: null, formats, max_mb`), `technologies`, `district_technologies`, and the older plain lists (`regions`, `castes`, `educations`, `religions`, `tracks`, `genders`, `marital_statuses`, `educational_statuses`, `grading_types`, `cgpa_scales`, `qualification_classes`). The browser caches it per page load, so a change in a master appears after a reload. `lists.CASTE[].value` must equal `castes[].id` (same for regions and educations). Always send `fields` and `lists`: without them the portal falls back to built-in fields and English labels (`src/form.ts`).
- **How `src/form.ts` labels choices**: district = its name; center = `<name> (<district_name>)`; `disability_status` = fixed Yes / No (होय / नाही), not a master; CGPA scale `Out of <n>`; caste and religion always Marathi; any other choice in the chosen language, else English. A dropdown without `options_kind` that the portal does not know takes `FIELD:<key>`.
- **Sign-in page**: the caste list. **Footer "Keep these documents ready"**: the documents.
- **Lists of the panel**: district, category (= caste, Marathi name, also switched-off ones), centre; filters; batches (district, centre).
- **Labels, names and documents as people read them** always come from the masters now, including switched-off and deleted entries, for forms that hold them.

Data model of the reference (constraints the new tables should keep):

| Table | Columns beyond id, created/updated, is_active, deleted | Constraints |
|---|---|---|
| states | name ≤ 100, code ≤ 10 | not deleted: unique `lower(name)`, unique `code`; code `^[A-Z][A-Z0-9]{1,9}$` |
| districts | state_id, name ≤ 100, code ≤ 20 | unique (state, lower(name)), (state, code); code `^[A-Z][A-Z0-9-]{1,19}$` |
| talukas | district_id, name ≤ 100, code ≤ 20 null | unique (district, lower(name)), (district, code) when given |
| centres | district_id, taluka_id null, name ≤ 150, code ≤ 20, address ≤ 300, pin char 6, contact_person ≤ 120, contact_number ≤ 15, email ≤ 254 | unique code; unique (district, lower(name)) |
| program_options | kind ≤ 60, code ≤ 120, name_en ≤ 150, name_mr ≤ 150 null, display_order, is_system | not deleted: unique (kind, lower(code)), (kind, lower(name_en)) |
| program_district_technologies | district_id, option_id | primary key both |
| program_documents | code ≤ 40 `^[A-Z][A-Z0-9_]*$`, name_en ≤ 150, name_mr, required, display_order, is_system, kind | code unique for ever; unique lower(name_en) not deleted |
| program_fields | key ≤ 60 `^[a-z][a-z0-9_]*$`, step 1/2, label_en ≤ 150, label_mr, required, display_order, is_core, is_custom, type, help_en/mr ≤ 300 | key unique for ever; is_custom ⇔ key starts `x_`; core ⇒ required, active, not deleted, not custom |

All deletes are soft (a deleted row is inactive too). Uniqueness looks only at not-deleted rows unless stated.

---

## 10. Seed data for an empty database

Numbers of `order` run 10, 20, 30 … All rows active. Fields: `custom false`, `help_en`/`help_mr` null. Text is Unicode NFC. Sources: migration `1799300000000-ProgramMasters.ts` (`OPTIONS`, `DOCUMENTS`, `STEP_1`, `STEP_2`), `seed-edp.ts` (`EDP_PROGRAM_CASTES`), `seed-masters.ts` (`EDUCATIONS`, sorted A–Z by name as the portal shows them), `student.constants.ts` (`CENTRES` = the regions), `seed-contact-directory.ts` (`STATE`, `DISTRICTS`).

```json
{
  "states": [ { "code": "MH", "name": "Maharashtra", "is_active": true } ],
  "options": {
    "CASTE": [
      {"code":"SAR01","name_en":"Maratha","name_mr":"मराठा","order":10},
      {"code":"SAR02","name_en":"Maratha-Kunbi","name_mr":"मराठा-कुणबी","order":20},
      {"code":"SAR03","name_en":"Kunbi-Maratha","name_mr":"कुणबी-मराठा","order":30}
    ],
    "EDUCATION": [
      {"code":"BA","name_en":"B.A.","name_mr":null,"order":10},
      {"code":"BCOM","name_en":"B.Com","name_mr":null,"order":20},
      {"code":"BE_BTECH","name_en":"B.E. / B.Tech","name_mr":null,"order":30},
      {"code":"BSC","name_en":"B.Sc","name_mr":null,"order":40},
      {"code":"BBA","name_en":"BBA","name_mr":null,"order":50},
      {"code":"BCA","name_en":"BCA","name_mr":null,"order":60},
      {"code":"DIPLOMA","name_en":"Diploma","name_mr":null,"order":70},
      {"code":"HSC","name_en":"HSC (12th)","name_mr":null,"order":80},
      {"code":"ITI","name_en":"ITI","name_mr":null,"order":90},
      {"code":"MA","name_en":"M.A.","name_mr":null,"order":100},
      {"code":"MCOM","name_en":"M.Com","name_mr":null,"order":110},
      {"code":"ME_MTECH","name_en":"M.E. / M.Tech","name_mr":null,"order":120},
      {"code":"MSC","name_en":"M.Sc","name_mr":null,"order":130},
      {"code":"MBA","name_en":"MBA","name_mr":null,"order":140},
      {"code":"MCA","name_en":"MCA","name_mr":null,"order":150},
      {"code":"GRAD_OTHER","name_en":"Other Graduate","name_mr":null,"order":160},
      {"code":"PG_OTHER","name_en":"Other Post Graduate","name_mr":null,"order":170},
      {"code":"SSC","name_en":"SSC (10th)","name_mr":null,"order":180}
    ],
    "REGION": [
      {"code":"AHL","name_en":"Ahilyanagar","name_mr":null,"order":10},
      {"code":"AKO","name_en":"Akola","name_mr":null,"order":20},
      {"code":"AMR","name_en":"Amravati","name_mr":null,"order":30},
      {"code":"BEE","name_en":"Beed","name_mr":null,"order":40},
      {"code":"BHA","name_en":"Bhandara","name_mr":null,"order":50},
      {"code":"BUL","name_en":"Buldhana","name_mr":null,"order":60},
      {"code":"CHA","name_en":"Chandrapur","name_mr":null,"order":70},
      {"code":"CSN","name_en":"Chhatrapati Sambhajinagar","name_mr":null,"order":80},
      {"code":"DHA","name_en":"Dharashiv","name_mr":null,"order":90},
      {"code":"DHU","name_en":"Dhule","name_mr":null,"order":100},
      {"code":"GAD","name_en":"Gadchiroli","name_mr":null,"order":110},
      {"code":"GON","name_en":"Gondia","name_mr":null,"order":120},
      {"code":"HIN","name_en":"Hingoli","name_mr":null,"order":130},
      {"code":"JAL","name_en":"Jalgaon","name_mr":null,"order":140},
      {"code":"JLN","name_en":"Jalna","name_mr":null,"order":150},
      {"code":"KOL","name_en":"Kolhapur","name_mr":null,"order":160},
      {"code":"LAT","name_en":"Latur","name_mr":null,"order":170},
      {"code":"MUC","name_en":"Mumbai City","name_mr":null,"order":180},
      {"code":"MUS","name_en":"Mumbai Suburban","name_mr":null,"order":190},
      {"code":"NAG","name_en":"Nagpur","name_mr":null,"order":200},
      {"code":"NAN","name_en":"Nanded","name_mr":null,"order":210},
      {"code":"NDB","name_en":"Nandurbar","name_mr":null,"order":220},
      {"code":"NAS","name_en":"Nashik","name_mr":null,"order":230},
      {"code":"PAL","name_en":"Palghar","name_mr":null,"order":240},
      {"code":"PAR","name_en":"Parbhani","name_mr":null,"order":250},
      {"code":"PUN","name_en":"Pune","name_mr":null,"order":260},
      {"code":"RAI","name_en":"Raigad","name_mr":null,"order":270},
      {"code":"RAT","name_en":"Ratnagiri","name_mr":null,"order":280},
      {"code":"SAN","name_en":"Sangli","name_mr":null,"order":290},
      {"code":"SAT","name_en":"Satara","name_mr":null,"order":300},
      {"code":"SIN","name_en":"Sindhudurg","name_mr":null,"order":310},
      {"code":"SOL","name_en":"Solapur","name_mr":null,"order":320},
      {"code":"THA","name_en":"Thane","name_mr":null,"order":330},
      {"code":"WAR","name_en":"Wardha","name_mr":null,"order":340},
      {"code":"WAS","name_en":"Washim","name_mr":null,"order":350},
      {"code":"YAV","name_en":"Yavatmal","name_mr":null,"order":360}
    ],
    "RELIGION": [
      {"code":"हिंदू","name_en":"Hindu","name_mr":"हिंदू","order":10}
    ],
    "GENDER": [
      {"code":"Male","name_en":"Male","name_mr":"पुरुष","order":10},
      {"code":"Female","name_en":"Female","name_mr":"स्त्री","order":20},
      {"code":"Transgender","name_en":"Transgender","name_mr":"तृतीयपंथी","order":30}
    ],
    "MARITAL_STATUS": [
      {"code":"Unmarried","name_en":"Unmarried","name_mr":"अविवाहित","order":10},
      {"code":"Married","name_en":"Married","name_mr":"विवाहित","order":20}
    ],
    "EDUCATIONAL_STATUS": [
      {"code":"Third Year","name_en":"Third Year","name_mr":"तृतीय वर्ष","order":10},
      {"code":"Final Year","name_en":"Final Year","name_mr":"अंतिम वर्ष","order":20},
      {"code":"Completed","name_en":"Completed","name_mr":"पूर्ण","order":30}
    ],
    "GRADING_TYPE": [
      {"code":"PERCENTAGE","name_en":"Percentage","name_mr":"टक्केवारी","order":10,"is_system":true},
      {"code":"CGPA","name_en":"CGPA","name_mr":"सीजीपीए","order":20,"is_system":true}
    ],
    "CGPA_SCALE": [
      {"code":"4","name_en":"4","name_mr":null,"order":10},
      {"code":"5","name_en":"5","name_mr":null,"order":20},
      {"code":"10","name_en":"10","name_mr":null,"order":30}
    ],
    "QUALIFICATION_CLASS": [
      {"code":"Distinction","name_en":"Distinction","name_mr":"विशेष प्रावीण्य","order":10},
      {"code":"First Class","name_en":"First Class","name_mr":"प्रथम श्रेणी","order":20},
      {"code":"Higher Second Class","name_en":"Higher Second Class","name_mr":"उच्च द्वितीय श्रेणी","order":30},
      {"code":"Second Class","name_en":"Second Class","name_mr":"द्वितीय श्रेणी","order":40},
      {"code":"Pass Class","name_en":"Pass Class","name_mr":"उत्तीर्ण श्रेणी","order":50}
    ],
    "TECHNOLOGY": [
      {"code":"T01","name_en":"Data Analytics & Business Intelligence","name_mr":null,"order":10},
      {"code":"T02","name_en":"Graphic Design & Digital Branding","name_mr":null,"order":20},
      {"code":"T03","name_en":"Web Design & Development","name_mr":null,"order":30},
      {"code":"T04","name_en":"Application Development","name_mr":null,"order":40},
      {"code":"T05","name_en":"IT Infrastructure & Smart Technologies","name_mr":null,"order":50},
      {"code":"T06","name_en":"Retail & E-Commerce Management","name_mr":null,"order":60},
      {"code":"T07","name_en":"Cyber Security","name_mr":null,"order":70},
      {"code":"T08","name_en":"AI/ML Engineer","name_mr":null,"order":80},
      {"code":"T09","name_en":"Data Scientist","name_mr":null,"order":90},
      {"code":"T10","name_en":"Social Media Marketing / Digital Marketing","name_mr":null,"order":100},
      {"code":"T11","name_en":"Blockchain","name_mr":null,"order":110},
      {"code":"T12","name_en":"Office Process Automation (OPA)","name_mr":null,"order":120}
    ]
  },
  "documents": [
    {"code":"PHOTO","name_en":"Photo","name_mr":"छायाचित्र","required":true,"kind":"DOCUMENT","order":10,"is_system":true},
    {"code":"SIGNATURE","name_en":"Signature","name_mr":"स्वाक्षरी","required":true,"kind":"DOCUMENT","order":20,"is_system":true},
    {"code":"AADHAAR_CARD","name_en":"Aadhar Card","name_mr":"आधार कार्ड","required":true,"kind":"DOCUMENT","order":30,"is_system":true},
    {"code":"AADHAAR_PHOTO","name_en":"Applicant Photograph with Aadhaar","name_mr":"आधार कार्डसह अर्जदाराचे छायाचित्र","required":true,"kind":"DOCUMENT","order":40,"is_system":true},
    {"code":"APPLICANT_VIDEO","name_en":"Applicant Video with Aadhaar","name_mr":"आधार कार्डसह अर्जदाराचा व्हिडिओ","required":false,"kind":"VIDEO","order":50,"is_system":true},
    {"code":"PAN_CARD","name_en":"PAN Card","name_mr":"पॅन कार्ड","required":true,"kind":"DOCUMENT","order":60,"is_system":true},
    {"code":"HSC_DIPLOMA","name_en":"12th Pass Or 3 Years Diploma Pass Marksheet / Certificate","name_mr":"१२ वी उत्तीर्ण किंवा ३ वर्षांची पदविका उत्तीर्ण गुणपत्रिका / प्रमाणपत्र","required":true,"kind":"DOCUMENT","order":70,"is_system":true},
    {"code":"EDU_CERT","name_en":"Highest Qualification Certificate / Marksheet","name_mr":"सर्वोच्च पात्रतेचे प्रमाणपत्र / गुणपत्रिका","required":true,"kind":"DOCUMENT","order":80,"is_system":true},
    {"code":"INCOME_EWS","name_en":"EWS Certificate","name_mr":"ईडब्ल्यूएस प्रमाणपत्र","required":true,"kind":"DOCUMENT","order":90,"is_system":true},
    {"code":"SCHOOL_LEAVING","name_en":"School Leaving Certificate / Transfer Certificate","name_mr":"शाळा सोडल्याचा दाखला / स्थलांतर प्रमाणपत्र","required":true,"kind":"DOCUMENT","order":100,"is_system":true},
    {"code":"DOMICILE","name_en":"Domicile of Certificate Maharashtra","name_mr":"महाराष्ट्र अधिवास प्रमाणपत्र","required":true,"kind":"DOCUMENT","order":110,"is_system":true}
  ],
  "fields": [
    {"step":1,"order":10,"key":"first_name","label_en":"First Name","label_mr":"पहिले नाव","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":20,"key":"last_name","label_en":"Last Name","label_mr":"आडनाव","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":30,"key":"father_name","label_en":"Father Name","label_mr":"वडिलांचे नाव","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":40,"key":"mother_name","label_en":"Mother Name","label_mr":"आईचे नाव","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":50,"key":"email","label_en":"Email","label_mr":"ईमेल आयडी","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":60,"key":"date_of_birth","label_en":"Date of Birth","label_mr":"जन्मतारीख","type":"DATE","required":true,"core":true,"options_kind":null},
    {"step":1,"order":70,"key":"current_address","label_en":"Current Address","label_mr":"सध्याचा पत्ता","type":"TEXTAREA","required":true,"core":true,"options_kind":null},
    {"step":1,"order":80,"key":"permanent_address","label_en":"Permanent Address","label_mr":"कायमचा पत्ता","type":"TEXTAREA","required":true,"core":false,"options_kind":null},
    {"step":1,"order":90,"key":"landmark","label_en":"Landmark","label_mr":"जवळची खूण","type":"TEXT","required":false,"core":false,"options_kind":null},
    {"step":1,"order":100,"key":"pin_code","label_en":"PIN Code","label_mr":"पिन कोड","type":"TEXT","required":true,"core":false,"options_kind":null},
    {"step":1,"order":110,"key":"district_id","label_en":"District","label_mr":"जिल्हा","type":"DROPDOWN","required":true,"core":true,"options_kind":null},
    {"step":1,"order":120,"key":"taluka","label_en":"Taluka","label_mr":"तालुका","type":"TEXT","required":false,"core":false,"options_kind":null},
    {"step":1,"order":130,"key":"aadhaar_number","label_en":"Aadhaar Number","label_mr":"आधार क्रमांक","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":140,"key":"mobile_number","label_en":"Mobile Number","label_mr":"मोबाईल क्रमांक","type":"TEXT","required":true,"core":true,"options_kind":null},
    {"step":1,"order":150,"key":"religion","label_en":"Religion","label_mr":"धर्म","type":"DROPDOWN","required":true,"core":true,"options_kind":"RELIGION"},
    {"step":1,"order":160,"key":"caste_id","label_en":"Caste","label_mr":"जात","type":"DROPDOWN","required":true,"core":true,"options_kind":"CASTE"},
    {"step":1,"order":170,"key":"gender","label_en":"Gender","label_mr":"लिंग","type":"DROPDOWN","required":true,"core":false,"options_kind":"GENDER"},
    {"step":1,"order":180,"key":"marital_status","label_en":"Marital Status","label_mr":"वैवाहिक स्थिती","type":"DROPDOWN","required":true,"core":false,"options_kind":"MARITAL_STATUS"},
    {"step":1,"order":190,"key":"alternate_mobile_number","label_en":"Alternate Mobile Number","label_mr":"पर्यायी मोबाईल क्रमांक","type":"TEXT","required":false,"core":false,"options_kind":null},
    {"step":1,"order":200,"key":"alternate_email","label_en":"Alternate Email","label_mr":"पर्यायी ईमेल आयडी","type":"TEXT","required":false,"core":false,"options_kind":null},
    {"step":1,"order":210,"key":"disability_status","label_en":"Person with Disability","label_mr":"दिव्यांग व्यक्ती","type":"DROPDOWN","required":true,"core":false,"options_kind":null},
    {"step":1,"order":220,"key":"disability_type","label_en":"Type of Disability","label_mr":"दिव्यांगत्वाचा प्रकार","type":"TEXT","required":true,"core":false,"options_kind":null},
    {"step":1,"order":230,"key":"disability_certificate_number","label_en":"Disability Certificate Number","label_mr":"दिव्यांग प्रमाणपत्र क्रमांक","type":"TEXT","required":true,"core":false,"options_kind":null},
    {"step":2,"order":10,"key":"region_id","label_en":"Course District","label_mr":"अभ्यासक्रमाचा जिल्हा","type":"DROPDOWN","required":true,"core":true,"options_kind":"REGION"},
    {"step":2,"order":20,"key":"centre_id","label_en":"Center Name","label_mr":"केंद्राचे नाव","type":"DROPDOWN","required":true,"core":true,"options_kind":null},
    {"step":2,"order":30,"key":"technology","label_en":"Technology","label_mr":"तंत्रज्ञान","type":"DROPDOWN","required":true,"core":true,"options_kind":"TECHNOLOGY"},
    {"step":2,"order":40,"key":"education_id","label_en":"Education Qualification","label_mr":"शैक्षणिक पात्रता","type":"DROPDOWN","required":true,"core":true,"options_kind":"EDUCATION"},
    {"step":2,"order":50,"key":"educational_status","label_en":"Educational Status","label_mr":"शैक्षणिक स्थिती","type":"DROPDOWN","required":true,"core":false,"options_kind":"EDUCATIONAL_STATUS"},
    {"step":2,"order":60,"key":"qualification_name","label_en":"Qualification Name","label_mr":"पात्रतेचे नाव","type":"TEXT","required":true,"core":false,"options_kind":null},
    {"step":2,"order":70,"key":"qualification_stream","label_en":"Subject / Stream / Branch","label_mr":"विषय / शाखा","type":"TEXT","required":true,"core":false,"options_kind":null},
    {"step":2,"order":80,"key":"qualification_board","label_en":"College Name","label_mr":"महाविद्यालयाचे नाव","type":"TEXT","required":true,"core":false,"options_kind":null},
    {"step":2,"order":90,"key":"qualification_completed_on","label_en":"Qualification Completed On","label_mr":"पात्रता पूर्ण झाल्याची तारीख","type":"DATE","required":true,"core":false,"options_kind":null},
    {"step":2,"order":100,"key":"grading_type","label_en":"Grading Type","label_mr":"गुणांकन प्रकार","type":"DROPDOWN","required":true,"core":false,"options_kind":"GRADING_TYPE"},
    {"step":2,"order":110,"key":"cgpa_scale","label_en":"CGPA Scale","label_mr":"सीजीपीए मापन","type":"DROPDOWN","required":true,"core":false,"options_kind":"CGPA_SCALE"},
    {"step":2,"order":120,"key":"score","label_en":"Score","label_mr":"गुण","type":"NUMBER","required":true,"core":false,"options_kind":null},
    {"step":2,"order":130,"key":"qualification_class","label_en":"Class / Division","label_mr":"श्रेणी","type":"DROPDOWN","required":true,"core":false,"options_kind":"QUALIFICATION_CLASS"}
  ]
}
```

### 10.1 Districts of Maharashtra (36)

All in state `MH`. The codes are those of `seed-contact-directory.ts` and equal the region codes. The Marathi names come from migration `1797600000000-CmsLiveDashboard.ts` (constant `DISTRICTS`); districts and regions store no Marathi name today (`name_mr` null).

| # | Name | Code | Marathi name (reference only) |
|---|---|---|---|
| 1 | Ahilyanagar | `AHL` | अहिल्यानगर |
| 2 | Akola | `AKO` | अकोला |
| 3 | Amravati | `AMR` | अमरावती |
| 4 | Beed | `BEE` | बीड |
| 5 | Bhandara | `BHA` | भंडारा |
| 6 | Buldhana | `BUL` | बुलढाणा |
| 7 | Chandrapur | `CHA` | चंद्रपूर |
| 8 | Chhatrapati Sambhajinagar | `CSN` | छत्रपती संभाजीनगर |
| 9 | Dharashiv | `DHA` | धाराशिव |
| 10 | Dhule | `DHU` | धुळे |
| 11 | Gadchiroli | `GAD` | गडचिरोली |
| 12 | Gondia | `GON` | गोंदिया |
| 13 | Hingoli | `HIN` | हिंगोली |
| 14 | Jalgaon | `JAL` | जळगाव |
| 15 | Jalna | `JLN` | जालना |
| 16 | Kolhapur | `KOL` | कोल्हापूर |
| 17 | Latur | `LAT` | लातूर |
| 18 | Mumbai City | `MUC` | मुंबई शहर |
| 19 | Mumbai Suburban | `MUS` | मुंबई उपनगर |
| 20 | Nagpur | `NAG` | नागपूर |
| 21 | Nanded | `NAN` | नांदेड |
| 22 | Nandurbar | `NDB` | नंदुरबार |
| 23 | Nashik | `NAS` | नाशिक |
| 24 | Palghar | `PAL` | पालघर |
| 25 | Parbhani | `PAR` | परभणी |
| 26 | Pune | `PUN` | पुणे |
| 27 | Raigad | `RAI` | रायगड |
| 28 | Ratnagiri | `RAT` | रत्नागिरी |
| 29 | Sangli | `SAN` | सांगली |
| 30 | Satara | `SAT` | सातारा |
| 31 | Sindhudurg | `SIN` | सिंधुदुर्ग |
| 32 | Solapur | `SOL` | सोलापूर |
| 33 | Thane | `THA` | ठाणे |
| 34 | Wardha | `WAR` | वर्धा |
| 35 | Washim | `WAS` | वाशिम |
| 36 | Yavatmal | `YAV` | यवतमाळ |

### 10.2 Not seeded, and other notes

- **Centers**: none are seeded (the local API offers 0 active ones). At least one active center must be entered before a student can complete step 2 or a batch can be made.
- **Talukas**: no taluka list exists in any of the repositories (the seed creates only the state and the districts), and the running local API has none in any of the 36 districts. See Q1.
- **District-wise technologies**: none (every district offers all 12).
- **Castes**: the program offers only the three above (`EDP_CASTE_CODES`); the 26 AMRUT castes (`CASTE_LIST` in `src/modules/students/student.constants.ts`) belong to the other programme and are not seeded (Q8).
- **Panel admin**: first ADMIN account from the environment (other part). **Batch size** default 30 (1–100).
- Seeding must be idempotent and must never overwrite or revive what an ADMIN changed or deleted (a list that has any row, deleted ones included, is left as it is).

---

## A. Table of endpoints

`P` = any panel user, `A` = ADMIN only, `–` = public. All under `/api/v1/edp`.

| # | Method | Path | Who | Used by |
|---|---|---|---|---|
| 1 | GET | `/manage/masters` | P | Dropdown lists |
| 2 | GET | `/manage/masters/:kind` | P | Dropdown lists, Technologies, own choices |
| 3 | POST | `/manage/masters/:kind` | A | same |
| 4 | PATCH | `/manage/masters/:kind/:id` | A | same |
| 5 | DELETE | `/manage/masters/:kind/:id` | A | same |
| 6 | GET | `/manage/technologies/districts` | P | Technologies |
| 7 | PUT | `/manage/technologies/districts/:districtId` | A | Technologies |
| 8 | GET | `/manage/documents` | P | Documents |
| 9 | POST | `/manage/documents` | A | Documents |
| 10 | PATCH | `/manage/documents/:id` | A | Documents |
| 11 | DELETE | `/manage/documents/:id` | A | Documents |
| 12 | GET | `/manage/fields` | P | Form fields |
| 13 | POST | `/manage/fields` | A | Form fields |
| 14 | PATCH | `/manage/fields/:id` | A | Form fields |
| 15 | DELETE | `/manage/fields/:id` | A | Form fields |
| 16 | GET | `/manage/districts` | P | Districts |
| 17 | POST | `/manage/districts` | A | Districts |
| 18 | PATCH | `/manage/districts/:id` | A | Districts |
| 19 | DELETE | `/manage/districts/:id` | A | Districts |
| 20 | GET | `/manage/centres` | P | Center Master, Create batch, Batch page |
| 21 | POST | `/manage/centres` | A | Center form |
| 22 | GET | `/manage/centres/:id` | P | Center detail, form |
| 23 | PATCH | `/manage/centres/:id` | A | Center form |
| 24 | PATCH | `/manage/centres/:id/status` | A | Center list, detail |
| 25 | GET | `/geography/states` | – | Districts (Add), Center form |
| 26 | GET | `/geography/states/:stateId/districts` | – | Center form |
| 27 | GET | `/geography/districts/:districtId/talukas` | – | Center form |

**27 endpoints** called by the frontend in this part (plus `GET /options` and `GET /manage/me`, specified in `01-student-portal.md` and `02-auditor-panel.md`). Recommended additions (C.4): `DELETE /manage/centres/:id` (28), `GET/POST/PATCH/DELETE /manage/states[/:id]` (29–32), `GET/POST/PATCH/DELETE /manage/talukas[/:id]` (33–36); new fields on `POST/PATCH/GET /manage/batches`.

---

## B. Business rules

1. Everybody signed in to the panel sees all masters; only an ADMIN changes them (API 403, UI hides).
2. Deletes are soft. Forms keep showing the name of an entry that was switched off or deleted.
3. **Active / inactive**: an inactive entry is not offered and not accepted for a new answer (`Select a valid <label>`; castes, educations, regions, district and center: `<label> not found or inactive`); an unchanged stored value stays accepted in the Auditor's edit.
4. A rename never changes the stored value; every form then shows the new name.
5. **`is_system` choice** = the two of GRADING_TYPE (the score is checked by the codes `PERCENTAGE` and `CGPA`): rename, order, on/off only.
6. **`is_system` document** = the 11 standard ones: rename, required/optional, order, on/off; never deleted, kind never changed.
7. **Core field** (16: first_name, last_name, father_name, mother_name, email, date_of_birth, current_address, district_id, aadhaar_number, mobile_number, religion, caste_id, region_id, centre_id, technology, education_id): always active and required; only labels, help, order.
8. **Built-in field, not core** (20): also required and on/off. Never deleted, step and type fixed.
9. **Own field** (`x_…`): everything, and delete. Answers stay stored in the form after a delete; the key is never used again. Own fields are always shown last in their step, whatever their order.
10. A switched-off field is neither asked, checked nor saved; a stored value is kept and still shown on forms that have one. A deleted own field is not shown at all.
11. `disability_type`, `disability_certificate_number` are asked only when `disability_status = Yes` (and it is on); `cgpa_scale` only when `grading_type = CGPA`. "Required" on them means required when asked.
12. Names are unique in their list (case-insensitive, not deleted): option English name per kind, document English name, state name and code, district name and code per state, taluka name (and code) per district, centre code overall and name per district.
13. Technology codes `T<nn>`: the next number, never given twice. Own document codes `IPP_DOC_<n>`: same.
14. Technologies of a student depend on the district only (section 4), re-checked when a step is completed and at submission (`Technology is not offered in the selected district`).
15. CGPA score limit: the chosen scale, else the largest active scale; percentage 0–100.
16. Documents: only active ones are asked, in order; a required one blocks submission (`<name> is required`); a file of a document switched off later stays and is shown after the active ones; uploading for an inactive one → `Unknown or inactive document type`.
17. Castes and religions are shown by the Marathi name in both languages; everything else in the chosen language, English when the Marathi name is blank.
18. A center belongs to one district (state derived), its optional taluka must be of that district; state in the body only cross-checks. Deactivating never blocks; the student who had chosen it must choose again.
19. A district / state / taluka may always be deactivated; children are kept and shown as `(inactive)` where they are chosen; new children cannot be attached to an inactive parent.
20. Only active states and districts are offered in the geography lists; a deleted or unknown parent is 404, never an empty list.
21. **Delete guards for the new database** (stricter than the reference, to match the UI text): state ← districts; district ← talukas, centers, students' forms, batches, officers' districts (later); taluka ← centers; center ← students' forms and batches. Answer 409 naming what holds it and "Deactivate it instead". `in_use` of a district should be true for the same reasons. Choices, documents and fields are never blocked by use.
22. Nothing in the reference prevents switching off or deleting the last active choice of a required dropdown, or the last choice of an own dropdown (Q11).
23. Every write is audited with the panel user, the row and what changed.

---

## C. Gap analysis and recommendations

### C.1 The 5174 master and batch screens

All of these except the last three rows are **commented out** in `src/constants/navigation.ts` (menu and routes; 25 Nov 2026, "Not used by the 3 Month Internship Placement Program"); the pages still exist. The `/cms/*` masters share: list with server search (350 ms), status filter, sort by column, page sizes 10/15/25/50/100 (default 15), KPI tiles, View / Edit / status toggle (confirmation) / Delete (confirmation), separate Create and Edit pages with a save confirmation on Edit, `restore` in the API without a button. The four `/masters/*` screens use dialogs instead (20 per page, status toggle without confirmation).

| 5174 screen (route) | Fields and rules | Buttons, filters | Needed by the program | In 5176 | Missing in 5176 |
|---|---|---|---|---|---|
| **State Master** `/cms/states` | State Name* 2–100; State Code* 2–10 `A–Z0–9`, letter first; Status. Unique name, code. Delete refused while districts exist | Add State; filter status; KPI Districts mapped; View shows the number of districts | Yes, indirectly: the Center form needs a state; Districts shows it | No screen; only read (`/geography/states`) | **States page** (R1) |
| **District Master** `/cms/districts` | State*; District Name* 2–100; District Code* 2–20 (hyphen); Status. Unique per state; may move to another state. Delete refused: talukas, colleges, training centres, centers, documents | Add; filter state, status; KPI Talukas mapped | Yes: form, technologies, batches, officers | Yes (`/manage/masters/districts`) | code optional there (generated); no state filter / move, no taluka count, no status filter (R3) |
| **Taluka Master** `/cms/talukas` | State*; District*; Taluka Name* 2–100; Taluka Code optional 2–20; Status. Unique per district. Delete refused: colleges, training centres, centers; move refused while used | Add; filter state → district, status; search taluka, district, state | Yes: Center form's taluka. **Not** the student form (taluka is typed) | No screen; only read (`/geography/districts/:id/talukas`) | **Talukas page** (R2). Without it the Center form always says `No talukas in this district.` |
| **Center Master** `/cms/centres` | Name* 2–150, Code* 2–20, State*, District*, Taluka, PIN, Address ≤ 300, Contact Person ≤ 120, Contact Number, Email, Allocated Technologies (≤ 50), Status | Add; filter state, district, technology, status; Delete (409 when used) | Yes: step 2, batches | Yes (`/manage/centres`) | Delete button, district filter, taluka column (R4). Allocated technologies: not needed (replaced by district-wise technologies) |
| **Castes** `/masters/castes` | Name (Marathi)* ≤ 80, Code* ≤ 20, English name ≤ 150, Display order 0–9999, Description ≤ 500, Status; deleted codes and names stay reserved; delete / code change refused when used | Add, View, Edit, toggle, Delete; search code/name; 20 per page | Yes | Yes (list `CASTE`) | nothing needed (description, typed code not used) |
| **Regions** `/masters/regions` | Code* ≤ 10, Name* ≤ 150, Description, Status | same | Yes (Course District) | Yes (list `REGION`) | nothing needed (Q3) |
| **Education** `/masters/education` | Code* ≤ 20, Name* ≤ 150, Description, Status | same | Yes | Yes (list `EDUCATION`) | nothing needed |
| **Document Types** `/masters/document-types` | Code* ≤ 20, Name* ≤ 150, Description, Mandatory, Status | same | Yes | Yes (Documents; adds Marathi name, kind, order) | nothing needed |
| **Batch Master** `/cms/batches` | Training centre*; Batch Name* 2–100 (unique at the centre); Batch Code 2–30, blank → `AMK-B-<centre code>-001`; Technology track (free text ≤ 100); Delivery mode* Offline / Online / Blended; Start date*; End date (after start); Capacity* 1–100000; Batch status* Planned / Open / Full / Closed / Cancelled; Status. Locks: centre and code fixed once assigned; capacity ≥ students; no cancel with students; delete refused with assignments. **No trainer and no timings** | Add Batch; filter centre, batch status, delivery mode, status; KPI Open for assignment; View → students | Partly: the program's batch is another thing (students chosen first, exactly the batch size, one district, sent to the Divisional Officer at once) | Yes (`/manage/batches`): name, centre, district, size, stages | code, dates, delivery mode, technology (R5). Capacity, batch status: not needed (C.3) |
| **Assign Batch** `/cms/batch-assignments` | Student* (search ≥ 2 characters, registered, one batch each), Batch* (active, Open, free seat, centre active), Reason (required when the batch's centre ≠ the student's preferred centre: Preferred centre full / Candidate request / Programme decision / Other), Remarks ≤ 500, Status (holds the seat) | Assign Student; move; deactivate (frees the seat); delete; filter batch, centre, reason | No: in 5176 the students are ticked in Applicants and fixed when the batch is made | Replaced by Create batch | only the "other centre" information (R6, optional) |
| **Department Master** `/cms/departments` | Name* 2–100, Code* 2–20, Description ≤ 500 | Add … | No (no field or screen uses it) | No | – |
| **College Master** `/cms/colleges` | State*, District*, Taluka, Name* 2–150, Code*, Address, PIN, Contact, Email | Add …; filter state, district | No: the form's *College Name* is typed text (`qualification_board`) | No | – |
| **Document Master** `/cms/documents` | Title* 3–150, Category* (8 kinds: centre profile, agreement …), Description, District, Training centre, File* PDF/JPG/PNG ≤ 5 MB, Verify / Reject (reason 5–300) | Upload, download, verify | No: office papers, not the students' documents | No | – |
| **Training Centre Type Master** `/cms/centre-types` | Name* 2–100, Code* 2–20, Description | Add … | No | No | – |
| **Training Centre Master** `/cms/training-centres` | Centre Name* 3–150, Code ≤ 10 (blank → `TC0001`; locked once batches exist), Type, State*, District*, Taluka, Contact, Email, POC name / mobile, Centre head, Alternative contact, Coordinator 1 / 2 | Add …; filter type, state, district | No: the program uses Center Master | No | – |
| **Location Information** `/cms/centre-locations` | one per training centre: Address* 5–300, PIN, https map link, landmark, station / bus stand, public transport, Parking, Remarks | Add … | No | No | – |
| **Capacity & Infrastructure** `/cms/centre-infrastructure` | one per training centre: Maximum Seating Capacity* 1–100000, floors, rooms, computers, internet, lift, AC, washroom, water, power backup, 20 facilities | Add … | No (no rule uses it) | No | – |
| **Batches** `/batches`, **Trainers** `/trainers`, **Trainer ToT**, **Centre Onboarding**, **Training Centres** `/centres`, **Districts** `/districts`, **Attendance** … | no own data: `Not available` screens, or a live view of the LMS | – | No | No | – |
| **LMS Admin** (Entity, Branding, Academic Calendar, Learning Configuration, Form Field Configuration, Reference Data, Course, Module, Track Variant) | LMS course set-up | – | No: the LMS is separate; Form fields of 5176 replace the only related idea | No | – |
| **Student Import**, website CMS (Contact coordinators, offices, Live Dashboard districts …) | other programme / public website | – | No | No | – |
| **Users & Roles → Districts** `/users` (**in the menu**) | for a role that needs districts (Divisional Officer): Districts* multi-select with search, Select all (shown), Clear; `Select at least one district` | – | Later, when the officers work in the portal | No: 5176 users are ADMIN / VIEWER only | R7 (later) |
| **System Settings → Head Office approval is optional** (**in the menu**) | one switch with confirmation; moves waiting students | – | Yes, later (approval chain; other part) | No | other part |
| **Student Approval Stages → batch pages** (**in the menu**) | officers' batch approval (batch, district, centre, students here / size, approve / reject) | – | Yes, later (other part, Q13) | No | other part |

### C.2 What 5176 already has of the masters data

Castes, Regions (Course District), Education, Document Types, Technologies, District-wise technologies, form fields, documents, districts, centers, batch size (Settings). With its own database these are complete for the student form once the seeds of section 10 are in. Missing for "everything managed from 5176": **State**, **Taluka**, center delete, and the batch fields below.

### C.3 Not recommended, with reasons

| 5174 item | Why not |
|---|---|
| Department, Training Centre Type, Training Centre, Location Information, Capacity & Infrastructure, Document Master, LMS masters, Trainers | no field, rule or screen of the program reads them; Center Master is the program's only centre |
| College Master | the form asks the college as text; a master of thousands of colleges would slow the student. If wanted later: turn it into an own dropdown, no new screen |
| Assign Batch | a batch is made with its students and they are fixed; nobody is added or removed later |
| Batch capacity | the batch size setting (exact, 1–100) replaces it |
| Batch status (Planned / Open / Full / Closed / Cancelled), active flag | a 5176 batch exists only with its students and moves through the approval stages; Open / Full mean nothing. Cancel only if the owner wants it (Q5) |
| Trainer, timings | not in Batch Master; add only if the owner asks (Q5) |
| Center's allocated technologies | replaced by the district's technologies |
| Separate View pages, KPI tiles, column sorting, restore, descriptions, typed codes of castes / regions / educations | not used in the flow; the 5176 lists are short |

### C.4 Recommended additions to 5176 (exact)

Style: as `DistrictsPage` / `MasterList` (table, status switch, Edit / Delete, FormDialog, ConfirmDelete, view-only notice, snake_case JSON). `tests/masters.test.tsx` lists the six links of `MastersNav` exactly and must follow. Put the links in `MastersNav` in this order: Dropdown lists · Technologies · Documents · Form fields · **States** · Districts · **Talukas** · Center Master.

**R1 States** — `/manage/masters/states` (priority: should; one seeded row, rarely used)

| | |
|---|---|
| Columns | # · Name · Code · Districts (count) · Status · Used · Actions |
| Search | name or code, in the browser |
| Dialog | Name* (≤ 100, `Name is required`), Code* (2–10, upper-cased, `Code: 2–10 characters, A–Z and 0–9, starting with a letter`) |
| Delete note | `It is no longer offered. A state that has districts cannot be deleted; switch it off instead.` |

```ts
interface State { id: string; name: string; code: string; districts: number; is_active: boolean; in_use: boolean }
// GET  /manage/states                 → 200 State[] (all, by name)
// POST /manage/states                 { name, code, is_active? } → 201 State      409 "A state with this name already exists" / "… code …"
// PATCH /manage/states/:id            { name?, code?, is_active? } → 200 State    404 "State not found"
// DELETE /manage/states/:id           → 200 null   409 "This state cannot be deleted while 36 districts reference it. Deactivate it instead, or move or delete the districts first."
```

**R2 Talukas** — `/manage/masters/talukas` (priority: **must**, or remove Taluka from the Center form; Q1)

| | |
|---|---|
| Columns | # · Name · Code · District · Status · Used · Actions |
| Filters | search (server), District (from `GET /manage/districts`), Status; 25 per page (several hundred rows) |
| Dialog | District* (active ones, changeable unless in use), Name* (2–100), Code (2–20, optional, blank allowed) |
| Delete note | `It is no longer offered. A taluka that a center uses cannot be deleted; switch it off instead.` |

```ts
interface Taluka { id: string; name: string; code: string | null; district_id: string; district: string; is_active: boolean; in_use: boolean }
// GET  /manage/talukas?page&limit&search&status&district_id → 200 Taluka[] + meta (order: district, name)
// POST /manage/talukas      { district_id, name, code?, is_active? } → 201   409 "A taluka with this name already exists in the selected district" / "… code …"; 400 district inactive (field district_id)
// PATCH /manage/talukas/:id { district_id?, name?, code? (null clears), is_active? } → 200   409 when moved while centers use it
// DELETE /manage/talukas/:id → 200 null   409 "This taluka cannot be deleted while 2 centers reference it. Deactivate it instead, or remove those records first."
```
A bulk way to enter talukas (CSV upload or seed) is worth more than the dialog: Maharashtra has several hundred.

**R3 Districts page** (should): status filter; `Talukas` count column; State select on Edit when there is more than one state; hide nothing (the API refuses a used one). API: `talukas: number` in the row, `state_id` accepted on PATCH.

**R4 Center Master** (must for the text, should for the rest): replace the footer sentence about the Amrut admin panel by `Only active centers are offered to students in the registration form.`; add `Delete` (list and detail, ADMIN, note `It is no longer offered. A center that students or batches use cannot be deleted; deactivate it instead.`) → `DELETE /manage/centres/:id`; add a District filter (`districtId`) and the Taluka column; add the view-only notice (also on Technologies and Documents).

**R5 Batch fields** (must, if the owner's "batch creation data of 5174" means these; Q5) — in `CreateBatchDialog` and, for an ADMIN, in "Batch details" of the batch page; shown in the Batches table and on the batch page.

| Field | Key | Rule | 5174 equivalent |
|---|---|---|---|
| Batch code (read-only) | `code` | generated at creation, unique, never changes, e.g. `IPP-B-0001` (not from the centre: the centre can be changed later) | Batch Code |
| Start date | `start_date` | `YYYY-MM-DD`, optional until decided (Q5); `Enter a valid start date` | Start date* |
| End date | `end_date` | optional, after the start (`End date must be after the start date`); the UI may prefill start + 3 months | End date |
| Delivery mode | `delivery_mode` | `OFFLINE` Offline (classroom) / `ONLINE` / `BLENDED`, default OFFLINE | Delivery mode* |
| Technology | `technology` | optional, a code of the Technology master; information only (students of a batch may have chosen different ones, Q5) | Technology track (free text) |

API: `POST /manage/batches` and `PATCH /manage/batches/:id` accept the four new keys (all optional; `null` clears the dates and the technology, the delivery mode is never empty); `Batch` gains `code: string; start_date: string | null; end_date: string | null; delivery_mode: 'OFFLINE' | 'ONLINE' | 'BLENDED'; technology: { code: string; name: string } | null`; `BatchMember` gains `technology: string | null`. Columns to add: Code (under the name), Dates. Dates may be changed by an ADMIN at any stage (as name and centre today). Existing rules stay: exactly the batch size, one district, only approved students waiting for a batch, name unique (case-insensitive, 2–120), centre active, students fixed.

**R6 Other centre** (optional, from Assign Batch): in the Create batch dialog say `<n> of <m> students chose another centre` (the students chose `centre_id` in step 2), and store an optional reason (Preferred centre full / Candidate request / Programme decision / Other) and remarks ≤ 500 with the batch. Needs a decision (Q6).

**R7 Officers' districts** (later): when officer accounts come into the portal, Users → Add / Edit user needs a Districts multi-select for a Divisional Officer (required, search, Select all, Clear), fed by the active rows of `GET /manage/districts`, and `user_districts` in the delete guard of districts.

**R8 Small fixes in existing pages** (optional): show the code (`T01`) in the Technologies list (today codes appear only in the district-wise boxes); limit the name inputs to what the API accepts (Q2); districts' code rule "starting with a letter" in the UI; `name_mr` for districts, centers and talukas so the Marathi form shows Marathi names (the 36 are in 10.1).

---

## D. Unclear, decisions needed

| # | Question |
|---|---|
| Q1 | Taluka list: who supplies the names (and codes)? No repository has one. Until then the Center form's Taluka stays empty. Alternative: free text as on the student form, then no Taluka master |
| Q2 | Longest names: the UI allows 200 for choices and documents, the reference refuses more than 150 (and 20–120 for most lists, 100 for own choices, because of the old student register). Proposal for the new database: one limit of 150 everywhere and the UI inputs set to 150 |
| Q3 | Course District (`REGION`) repeats the 36 districts as a separate list: a new district does not appear there. Keep the two lists, or take Course District from the Districts master? (Keeping = no frontend change) |
| Q4 | `HSC_DIPLOMA` (12th / diploma marksheet, required) is in the seeds but the running local API offers only 10 documents: this one is not offered there (inactive or missing). Active or inactive in the new database? |
| Q5 | Batches: are dates mandatory at creation? Must all students of a batch have the same technology? Format of the batch code? Trainer or timings wanted? May a batch be cancelled / dissolved (no way today)? |
| Q6 | May a batch's centre be in another district than its students, or differ from the centre they chose? The reference allows both, without a word |
| Q7 | Deleting a district (or center) that students' forms or batches use: the UI text says refused; the reference does not check forms (district) or batches (both). Section B-21 proposes refusing. Also: `in_use` of a district counts only forms today |
| Q8 | Castes: only the three Maratha castes (SAR01–SAR03)? They are shown on the sign-in page as the eligibility list |
| Q9 | Religion: only `हिंदू` is seeded; a student of another religion cannot submit. Intended? |
| Q10 | `/geography/*` stays public (the UI sends no token), or the frontend sends the panel token and it is protected? |
| Q11 | Should the API refuse switching off / deleting the last active choice of a required dropdown, and deleting the last choice of an own dropdown? Today allowed (then no student can complete the step) |
| Q12 | Restore of deleted entries: the 5174 API had it, no panel offers it. A name re-added to a list is a new row (castes, educations, regions: the old one). Enough? |
| Q13 | With its own database the portal no longer shares students with 5174: who approves after the batch is sent (Divisional Officer, COEP, Head Office, Admin work in 5174 today)? Decides whether R7, the stage settings and the stage screens move to 5176 (other parts) |
| Q14 | Is existing data moved (accounts, forms, batches)? Then ids of districts, castes, educations, regions, centers and the choice codes must be kept, because forms store them |
