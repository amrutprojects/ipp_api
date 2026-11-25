# 01 – Student portal and shared code

Specification of what the student side of the portal needs from a backend.

| | |
|---|---|
| Frontend read | `D:\Sarthi\EDP-Candidates-Registration`, commit `4a5d910` (React 18.3, react-router 6.28, Vite 5, TypeScript). `src/App.tsx, api.ts, session.tsx, i18n.tsx, types.ts, validation.ts, form.ts, signup.ts, welcome.ts`, all of `src/components`, `src/pages` except `src/pages/manage`, and the matching `tests/` |
| Server read (reference) | `D:\Sarthi\amrut-kalash-api\src\modules\students\edp`, commit `d9f3638` **plus its uncommitted changes** (`EDP_STATIC_OTP`), with `registration.validation.ts`, `aadhaar.ts`, `file-type.ts`, `registration-upload.middleware.ts`, `registration-admin.service.ts` (`prepareFiles`), `document-storage.ts`, `app.ts`, `api-response.ts`, the error handler, the migrations and `tests/e2e/edp-portal.e2e.test.ts` |
| Not covered here | `/manage/*` pages (tracking panel) and the approval chain; only the parts of shared code they use |

Conventions: paths are written below the base (`/auth/login` = `<base>/auth/login`, see 2.1). "Page" = the React page; "API" = the current server. `F-n` refers to section (f). Messages are quoted exactly. All portal text exists in English and Marathi in the frontend unless noted; only English is quoted.

Contents: [1 Routes](#1-routes) · [2 Shared code](#2-shared-code) · [3 Pages](#3-pages) · [4 The form model](#4-the-form-model-steps-1-and-2) · [5 Documents](#5-documents-step-3) · [6 API reference](#6-api-reference) · [(a) Endpoints](#a-all-endpoints-of-this-part) · [(b) Envelopes](#b-response-and-error-envelopes) · [(c) Tokens](#c-tokens-401-and-storage) · [(d) Business rules](#d-business-rules-the-server-must-enforce) · [(e) E-mail and SMS](#e-e-mail-and-sms) · [(f) Unclear / inconsistent](#f-unclear-or-inconsistent) · [Appendix: seed data and configuration](#appendix-seed-data-and-configuration-of-a-new-database)

---

## 1 Routes

`BrowserRouter`, single-page app: the web server must answer `index.html` for every path. Providers: `LangProvider` > `SessionProvider` > routes.

| Route | Page | Guard | Purpose |
|---|---|---|---|
| `/` | – | – | redirects to `/login` |
| `/login` | LoginPage | none; a signed-in student is sent to `/application` | caste eligibility tick, then e-mail + password |
| `/register` | RegisterPage | same | caste eligibility tick, then create account |
| `/verify?email=…` | VerifyPage | signed in → `/application`; no `email` in the query → `/register` | SMS OTP |
| `/forgot-password` | ForgotPasswordPage | none | ask for a reset link |
| `/reset-password?token=…` | ResetPasswordPage | none | set a new password from the e-mailed link |
| `/application` | ApplicationPage | `RequireStudent` (not signed in → `/login`) | the three-step form, or the submitted form |
| `/manage…` | tracking panel | `RequireManage` / `RequireManageAdmin` | other document |
| `*` | – | – | redirects to `/` |

`index.html`: `lang="en"`, `<meta name="referrer" content="no-referrer">` (page addresses can hold a reset token or an e-mail ID). Program name shown: `3 MONTH INTERNSHIP PLACEMENT PROGRAM`, organisation `Sumago Infotech Pvt. Ltd.` (constants in `components/ui.tsx`).

---

## 2 Shared code

### 2.1 Requests (`api.ts`)

- Base URL = `VITE_API_BASE_URL` without its trailing slash (default `/api/v1`) + **`/edp`** (hard-coded). Every call goes to `<VITE_API_BASE_URL>/edp<path>`; the new backend must serve that prefix or the frontend must change (F-30).
- Headers sent: `Accept: application/json`; `Authorization: Bearer <token>` when the call has a realm (`student` / `manage`) and a token is stored; `Content-Type: application/json` for JSON bodies; multipart bodies are `FormData` (browser sets the boundary). No cookies, no CSRF header, no `credentials` option, no custom request id.
- Query parameters `undefined` or `''` are left out.
- Success = any 2xx (`res.ok`). Body read as JSON; only `data`, `meta`, `message` are used. A body that is not JSON counts as `null` (so `data` is `undefined`). Every endpoint below must therefore answer JSON with `data`, except the file download.
- Failure: throws `ApiError{ message, status, code, details }` built from `json.message` (fallback `Request failed (<status>)`), `json.error.code`, `json.error.details`.
- No response at all: `ApiError("Could not reach the server. Check your internet connection and try again.", 0, "NETWORK")`.
- `ApiError.fields()` maps `details[]` to `{ [field]: message }`: the prefix `body.` or `body.data.` is removed (`body.first_name` → `first_name`, `body.data.landmark` → `landmark`), anything else is kept (`files.PHOTO` → `files.PHOTO`). **The first message per field wins.**
- HTTP 401 on a call with a realm: token removed, the realm's session set to signed-out (see (c)).
- `openFile(path, realm)`: opens a blank tab synchronously, then `GET <path>` with only the `Authorization` header, turns the response into a blob URL (revoked after 60 s) and shows it in the tab. Relies on the response **`Content-Type`**; ignores `Content-Disposition`. Any non-2xx (401 too) → tab closed, error `Could not open the file`; it does **not** sign the student out.
- `downloadFile(path, realm, fallbackName)` (tracking panel only): saves under the name in `Content-Disposition` (`filename*=UTF-8''…`, else `filename="…"`, else the fallback). If the API is on another origin, it must send `Access-Control-Expose-Headers: Content-Disposition` (F-31).
- The portal reads **no** response header in the student part apart from `Content-Type` of a file (no `Retry-After`, no rate-limit headers, no `Location`).
- Development: Vite serves on 5176 and proxies `/api` to `VITE_API_PROXY_TARGET` (default `http://localhost:5001`).

### 2.2 Session (`session.tsx`)

Two independent sessions (`student`, `manage`), each `{ user, loading, signIn(token,user), signOut() }`.

- On page load, for each realm with a stored token: `GET /me` (student) or `GET /manage/me` (manage). Success → `user`; **any** failure → `user = null` (the token itself is removed only on 401, so after a network error or 500 the student looks signed out until a reload). Guards show `Loading…` meanwhile.
- `signIn` stores the token and the `account` object of the login / verify answer; `expires_at` is never read.
- `signOut` is local only: no logout endpoint is called.
- `storage` event: when another tab removes the token, this tab signs out too. (A sign-in in another tab is not followed.)
- `RequireStudent` passes `state.from`, but LoginPage ignores it: after login it always goes to `/application`.

### 2.3 Language (`i18n.tsx`)

- `mr` / `en`, toggle "मराठी | English" on every sign-in page and in the header of `/application`; stored in `localStorage['edp.lang']`, default `en`; sets `<html lang>`.
- Names from the masters: `pickName(lang, en, mr)` = Marathi when the language is `mr` and the Marathi name is not blank, else English.
- Castes and religions (`CASTE`, `RELIGION` lists) are always shown by their Marathi name in **both** languages (English when there is none).
- Failed requests on the sign-in pages (login, register, verify, forgot, reset) are kept as `{ code, status, message }` and translated when drawn. Decision table (`serverMessage`), first match wins:

| Match | Shown in English | Shown in Marathi |
|---|---|---|
| `OTP_INCORRECT` | fixed: `Incorrect OTP` | fixed |
| `OTP_EXPIRED` | fixed: `OTP has expired. Please request a new OTP.` | fixed |
| `OTP_TOO_MANY_ATTEMPTS` | fixed: `Too many incorrect attempts. Please request a new OTP when the current one expires.` | fixed |
| `OTP_NOT_PENDING` | **server message** | fixed |
| `OTP_RESEND_TOO_SOON` | **server message** | fixed |
| `EMAIL_NOT_VERIFIED` | **server message** | fixed |
| `EMAIL_UNAVAILABLE`, `SMS_UNAVAILABLE` | **server message** | fixed |
| `SIGNUP_PASSWORD_MISMATCH` | fixed: `This is not the password chosen when the account was created. Enter that password, or create the account again.` | fixed |
| `EMAIL_NOT_REGISTERED` | fixed: `This email ID is not registered. Kindly check your email ID.` | fixed |
| `RESET_TOO_SOON` | **server message** | fixed |
| `RESET_LINK_INVALID` | fixed: `This password reset link is not valid or has already been used. Please request a new link.` | fixed |
| `RESET_LINK_EXPIRED` | fixed: `This password reset link has expired. Please request a new link.` | fixed |
| `RATE_LIMITED` | fixed: `Too many attempts. Please try again later.` | fixed |
| `NETWORK` | the client's text (2.1) | fixed |
| local codes `LOGIN_FAILED`, `SIGNUP_FAILED`, `VERIFY_FAILED`, `RESEND_FAILED`, `FORGOT_FAILED`, `RESET_FAILED` (an exception that is not an ApiError) | `Login failed` / `Could not create the account` / `Verification failed` / `Could not send a new OTP` / `Could not send the link` / `Could not change the password` | fixed |
| status 401 | **server message** | fixed ("wrong e-mail or password") |
| status 403 | **server message** | fixed ("account disabled") |
| status 404 | **server message** | fixed ("no account for this e-mail") |
| status 409 and message matches `/already verified/i`, `/just registered/i` or `/already exists/i` | **server message** | fixed, one per pattern |
| anything else (e.g. 422) | **server message** (`Validation failed`) | **server message** (English) |

So the English messages are part of the contract, and the 409 messages must keep those words. On `/application` the server's `message` is shown as sent (English) in both languages.

### 2.4 What the browser stores

| Key | Where | Content |
|---|---|---|
| `edp.token` | localStorage | student bearer token |
| `edp.manage.token` | localStorage | tracking panel token |
| `edp.lang` | localStorage | `mr` / `en` |
| `edp.pending.<account id>` | localStorage | typed values not yet saved: `{ "1": { key: value }, "2": { … } }`; written on every keystroke, removed once saved (F-12: includes the Aadhaar digits in clear) |
| `edp.casteConfirmed` | sessionStorage | `1` = eligibility ticked in this tab |
| reset token | `history.state` of `/reset-password` | removed from the address after the first render |
| sign-up password, "welcome owed" flag | memory only (`signup.ts`, `welcome.ts`) | lost on reload |

### 2.5 `signup.ts`, `welcome.ts`

- `signup.ts` keeps `{ email (trimmed, lower-case), password }` from the sign-up, or from a login answered `EMAIL_NOT_VERIFIED`, for the OTP page (verify needs the password). Memory only.
- `welcome.ts`: set when `verify-otp` succeeds; ApplicationPage then shows the welcome dialog once; closing it clears the flag.

### 2.6 Components

| Component | Purpose and behaviour | Data it needs |
|---|---|---|
| `Header`, `Footer`, `BrandMark` | programme bar, `© <year> …`, logo | none |
| `Field` | label, `*` when required, control, error (role `alert`) or hint; links them with `aria-describedby` | – |
| `PasswordInput` | show / hide eye; `maxLength` **72** | – |
| `Notice` | info / warn / ok (`role=status`) / error (`role=alert`) box | – |
| `Modal` | focus trap, Escape closes the top one, `alertdialog` for yes/no, `wide`, optional ✕ | – |
| `useOptions` / `loadOptions` | `GET /options`, **cached for the whole page load** (a failed call is not cached). `useOptions` swallows failures and does not retry | `Options` (6.9) |
| `useRemoteList(path, realm)` | dependent lists (tracking panel only); answer `data: T[]` | – |
| `AuthLayout` | frame of the sign-in pages: form, language toggle, program panel; for students the chip list "Keep these documents ready" (`document_types`: name, mandatory `*`, optional dashed) and `HelpButton` | `options.document_types` (tolerates it missing) |
| `LangToggle` | the two language buttons | – |
| `DocumentsReady` | foot of `/application`: ordered list of `document_types` with `*` or ` (optional)`; hard-coded note `* Mandatory. Scanned copies in PDF, JPG, JPEG or PNG format, each up to 5 MB.` (F-20) | `options.document_types` (**must be an array**, not tolerated missing) |
| `HelpButton` | bottom-right, on every student page. Hidden while options load, when `help` is absent, `help.enabled === false`, or no field has both label and value. Panel: `help.title` (blank → `Need help?`), `help.intro` (if not blank), `<dl>` of fields. A value matching `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$` is a `mailto:` link, one matching `^\+?\d[\d ()-]{5,18}\d$` a `tel:` link (digits and `+` only), anything else plain text. Escape / click outside closes | `options.help` |
| `SupportMessage` | `support.message` as text, never HTML; `{email}` → `mailto:` link, `{mobile}` → `tel:` link; without placeholders the message is followed by ` Email: …`, ` Mobile: …` for those set; blank message → nothing. Shown on the submitted form | `options.support` |
| `WelcomeDialog` | shown on `/application` right after `verify-otp`, once the options are loaded. `welcome.enabled === false` → not shown. Blank or missing `title` / `message` / `button_label` → the portal's own text: `Congratulations! Your account is created`, `Your mobile number is verified and your account is ready. Fill in the form in three steps, upload your documents and submit your application.`, `Start filling my form`. Button, ✕, Escape and backdrop close it | `options.welcome` |
| `CasteEligibility`, `EligibilityConfirmed` | section 3.1 | `options.lists.CASTE` (else `options.castes`) |
| `StepFields`, `useFormRules` | the fields of steps 1 and 2 (section 4) | `Options`, `Application.form` |
| `DocumentField` | one document of step 3 (section 5) | `DocumentType`, `StoredFile` |

### 2.7 Client checks (`validation.ts`)

| Function | Rule | English messages |
|---|---|---|
| `nameIssue` | trim; required; max; `^[\p{L}\p{M}][\p{L}\p{M} .'-]*$` (Unicode) | `<Label> is required`, `<Label> must be at most <n> characters`, `<Label> may contain only letters, spaces and . ' -` |
| `emailIssue` | trim; `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$` | `Email is required`, `Enter a valid email address` |
| `mobileIssue` | strip spaces, `(`, `)`, `-`; strip `+91`/`91` or `0` before 10 digits; then `^[6-9]\d{9}$` | `Mobile number is required`, `Mobile number must be a 10-digit Indian number starting 6–9` |
| `passwordIssue` | 8–72 characters, `[A-Za-z]`, `[0-9]`; not trimmed | `Password is required`, `Password must be at least 8 characters`, `Password must be at most 72 characters`, `Password must contain a letter`, `Password must contain a digit` |
| `aadhaarIssue` | strip spaces and `-`; `^[2-9]\d{11}$` and Verhoeff | `Aadhaar number is required`, `Aadhaar number must be 12 digits with a valid checksum` |
| `dobIssue` | `YYYY-MM-DD`, real date, not future, age 14–100 (UTC) | `Date of birth is required`, `Date of birth is not a real date`, `Date of birth cannot be in the future`, `Applicant must be between 14 and 100 years old` |
| `pinCodeIssue` | `^[1-9]\d{5}$` | `PIN code is required`, `PIN code must be 6 digits and cannot start with 0` |
| `completedOnIssue` | `YYYY-MM-DD`, real date, not after today in the **browser's** time zone | `Qualification completion date is required` / `… is not a real date` / `… cannot be in the future` |
| `scoreIssue` | `^\d+(\.\d{1,2})?$`; CGPA ≤ scale; percentage ≤ 100 | `Score is required`, `Score must be a number with at most 2 decimal places`, `CGPA must be between 0 and <scale>`, `Percentage must be between 0 and 100` |
| alternate mobile | as mobile, and different from `mobile_number` after normalising | `<Label> must be a 10-digit Indian number starting 6–9`, `<Label> must be different from the mobile number` |
| alternate e-mail | ≤ 254, e-mail pattern, different from `email` (case-insensitive) | `Enter a valid email address`, `<Label> must be different from your account email` |
| disability certificate | `^[A-Za-z0-9/-]{4,50}$` | `<Label> must be 4–50 characters: letters, digits, / and - only` |
| own fields | TEXT ≤ 250, TEXTAREA ≤ 2000, NUMBER `^-?\d{1,12}(\.\d{1,4})?$`, DATE real `YYYY-MM-DD` | `<Label> must be at most <n> characters`, `<Label> must be a number`, `<Label> is not a real date` |
| dropdowns | value in the list (skipped when the list is empty or unknown) | `Select a valid <Label>` |
| required | blank after trim | `<Label> is required`; `disability_status`: `<Label>: select Yes or No` |
| files | extension in the type's formats; size ≤ max | `Only PDF, JPG, JPEG or PNG files are accepted`, `Only MP4 files are accepted`, `File is larger than <n> MB` |

The server checks everything again; its messages are in 4.3.

### 2.8 Shared code used only by the tracking panel

Listed because it lives in the shared files; the endpoints belong to the other document.

| Code | Behaviour |
|---|---|
| `useManage`, `RequireManage` | second session: token `edp.manage.token`, `GET /manage/me` → `Admin { id, name, email, role: 'ADMIN' \| 'VIEWER' }`, login answer `{ token, admin }`; not signed in → `/manage/login` |
| `RequireManageAdmin(viewerTo)`, `useCanEdit` | pages and buttons for `role === 'ADMIN'` only; a VIEWER is sent to `viewerTo` |
| `StepFields` with `locked`, `current`, `aadhaarMasked` (Edit form) | locked fields disabled with the reason as hint; a saved choice no longer offered stays selectable as `<text> (no longer offered)`; Aadhaar optional, placeholder = masked number, hint `Leave it empty to keep the number on record; enter all 12 digits to change it.`; no browser autofill |
| `DocumentField` without `onRemove` | file can be replaced, not removed |
| `centreIssues` | name required, 2–150, `^[\p{L}\p{M}\d][\p{L}\p{M}\d .,'’()/&-]*$` (inner spaces collapsed); code required, upper-cased, `^[A-Z][A-Z0-9-]{1,19}$`; state and district required; address ≤ 300; PIN `^\d{6}$` if given; contact person ≤ 120, name pattern; phone (spaces removed) `^(?:[6-9]\d{9}\|0\d{2,4}-?\d{6,8})$`; e-mail ≤ 254. Error keys `name, code, stateId, districtId, address, pinCode, contactPerson, contactNumber, email` |
| `manageUserIssues` | name 2–150, e-mail, password (2.7), role ADMIN / VIEWER |
| `supportIssues` | message 10–500; e-mail valid, required when the message has `{email}`; mobile `^\+?\d[\d ()-]{5,18}\d$`, required when it has `{mobile}` |
| `welcomeIssues` | title 3–120, message 10–1000, button label ≤ 60 |
| `helpIssues` | title 2–120, intro ≤ 300, up to 4 fields: label ≤ 60, value ≤ 200, both or neither; enabled needs at least one complete field. Error keys `title`, `intro`, `fields`, `fields.<i>.label`, `fields.<i>.value` (server: `body.fields.0.label`, …) |
| `types.ts` | also the panel's types (`Applicant`, `ApplicantDetail`, `Batch…`, `Master…`, `Centre`, `ManageUser`, …) |

### 2.9 Tests that fix this behaviour

Portal: `tests/register.test.tsx`, `password.test.tsx`, `login-eligibility.test.tsx`, `application.test.tsx`, `form-fields.test.tsx`, `welcome-help.test.tsx`, `validation.test.ts`, `validation.extra.test.ts`, `wording.test.ts` (the former program name must not appear in any text of the portal or README). Server: `tests/e2e/edp-portal.e2e.test.ts`, `tests/unit/students/edp-otp-sms.test.ts`. The portal's mocks answer 201 to an upload, the API 200: both are accepted.

---

## 3 Pages

### 3.1 Caste eligibility (before the forms of `/login` and `/register`)

| | |
|---|---|
| Call | `GET /options` (cached) → choices of the `CASTE` list |
| States | loading `Loading the list…`; failed: `The list of castes could not be loaded.` + **Try again** (calls again); empty: `No castes are available at the moment.`; list |
| List | chips with the caste names; badge `<n> castes`; a search box `Find your caste` when there are more than 8 (case-insensitive "contains"); no match: `No caste in the list matches this name.` |
| Tick | `I belong to one of the castes listed above.` * – the button stays disabled until ticked |
| Button | `/login`: **Proceed to Login**; `/register`: **Proceed to Create Account** → stores `edp.casteConfirmed=1` for the tab (shared by both pages) and opens the form |
| Links | `/login`: Create an account → `/register`; `/register`: Login → `/login` |
| Afterwards | a strip `You confirmed that your caste is in the eligible list.` with **Change** (removes the confirmation, shows the list again) |

Nothing is sent to the server; the tick is not stored there. With no list (failure or empty) nobody can reach the login or the sign-up form (F-9). Not asked on `/verify`, `/forgot-password`, `/reset-password`.

### 3.2 `/login` – LoginPage

| Field | Type | Required | Client check | Limits |
|---|---|---|---|---|
| `email` "Email ID" | email | yes | `emailIssue` | none |
| `password` "Password" | password | yes | not blank: `Password is required` | 72 (input) |

- Router state `{ passwordChanged, email }` (from the reset page): e-mail prefilled, notice `Your password has been changed. Please log in with your new password.`
- **Login** (`Logging in…` while busy) → `POST /auth/login { email, password }` (as typed). Success: store token, go to `/application`.
- `403 EMAIL_NOT_VERIFIED`: password kept in memory, go to `/verify?email=<trimmed lower-case>` with the failure as its notice.
- Other failures: message at the top (2.3); `details` of a 422 also at the fields (`body.email`, `body.password`).
- **Forgot password?** → `/forgot-password` with the typed e-mail. **Create an account** → `/register`. Text: `Never share your password with anyone.`

### 3.3 `/register` – RegisterPage

| Field | Label | Type | Required | Max (input) | Client check |
|---|---|---|---|---|---|
| `first_name` | First Name | text | yes | 100 | name, label `First name` |
| `middle_name` | Middle Name | text | no | 100 | name when filled, label `Middle name` |
| `last_name` | Last Name | text | yes | 100 | name, label `Last name` |
| `email` | Email ID | email | yes | 254 | `emailIssue`; hint `This email ID is used to log in.` |
| `mobile_number` | Mobile Number | tel | yes | 15 | `mobileIssue`; hint `An OTP will be sent by SMS to this number. Enter a 10-digit number.` |
| `password` | Password | password | yes | 72 | `passwordIssue`; hint `At least 8 characters, with a letter and a digit.` |
| `confirm_password` | Re-enter Password | password | yes | 72 | `Please re-enter the password`, `Passwords do not match` |

- **Create account** (`Creating account…`) → `POST /auth/register` with the values as typed (`middle_name` trimmed, left out when blank; everything else untrimmed). Success: password kept in memory under `data.email`; go to `/verify?email=<data.email>` with `{ expiresIn: otp_expires_in, resendAfter: resend_after, receivedAt: now, mobileMasked: mobile_masked }`.
- 422: `Validation failed` at the top and each message at its field (`body.first_name`, …). Other failures: 2.3.
- **Login** link. No state is kept when coming back (the form is empty).

### 3.4 `/verify?email=…` – VerifyPage

| Field | Type | Check |
|---|---|---|
| `otp` "OTP" | numeric, digits only, 6 (`autocomplete=one-time-code`) | `^\d{6}$`: `Enter the 6-digit OTP` |
| `password` "Password" | shown only when the page does not have the sign-up password in memory (reload, other tab), or after `SIGNUP_PASSWORD_MISMATCH` | not blank: `Enter the password you chose when creating the account` |

- **Timing**: straight after the sign-up (state received less than 10 s ago) the sign-up's timing is used and no call is made; otherwise on opening → `POST /auth/otp-status { email }`. Until then defaults 300 s / 300 s. `otp-status` failing with 404 or 409 shows that message; any other failure is ignored.
- Countdown `OTP expires in m:ss` (updates 4×/s); at 0: `OTP has expired. Please request a new OTP.` The page blocks a verify by itself as expired **only** when its timing came from the server.
- Notice: `We have sent a 6-digit OTP by SMS to <mobile_masked>.` (`your mobile number` when not known); after a resend `A new OTP has been sent by SMS to …`; after a login the `EMAIL_NOT_VERIFIED` message.
- **Verify & create account** (`Verifying…`) → `POST /auth/verify-otp { email, otp, password }`. Success: memory password dropped, welcome dialog owed, token stored, `/application`.
- Failures: message (2.3). `SIGNUP_PASSWORD_MISMATCH`: password field shown, emptied. `OTP_EXPIRED`: both countdowns set to 0. For `OTP_EXPIRED`, `OTP_NOT_PENDING`, `OTP_TOO_MANY_ATTEMPTS`, `OTP_RESEND_TOO_SOON` the page calls `POST /auth/otp-status` again.
- **Resend OTP** (disabled `Resend OTP in m:ss` while `resend_after` runs; `Sending…`) → `POST /auth/resend-otp { email }`. Success: both countdowns restart from the answer, OTP box emptied.
- **Create the account again** → `/register`.

### 3.5 `/forgot-password` – ForgotPasswordPage

- `email` "Email ID": `emailIssue`, max 254; prefilled from the login page.
- **Send password reset link** (`Sending…`) → `POST /auth/forgot-password { email }`. Success: `A password reset link has been sent to <email>. The link is valid for <link_valid_minutes> minutes. If you do not see the email, check the spam folder.`; the button becomes `Send the link again in m:ss` (disabled for `resend_after` s), then `Send the link again`.
- Failures: message (2.3); `EMAIL_NOT_REGISTERED` also marks the field and disappears when the e-mail is edited. Field details of a 422 are not used (only `Validation failed`).
- **Back to login**.

### 3.6 `/reset-password?token=…` – ResetPasswordPage

- The token is taken from the query once, then removed from the address (kept in `history.state`, so a reload works).
- No token: `RESET_LINK_INVALID` text without calling the API.
- On opening → `POST /auth/reset-password/check { token }`. States: `Checking the link…`; **ready** (`Enter a new password for the account <email>.`); **bad** (`RESET_LINK_INVALID`, `RESET_LINK_EXPIRED` or any 422): message + **Request a new link** → `/forgot-password`; **retry** (network, 429, 5xx): message + **Try again** (checks again).
- Fields `password` "New Password", `confirm_password` "Re-enter New Password": `passwordIssue`, `Please re-enter the password`, `Passwords do not match`; max 72.
- **Save password** (`Saving…`) → `POST /auth/reset-password { token, password, confirm_password }`. Success: signs this browser out if signed in; `/login` with `{ passwordChanged: true, email: data.email }`.
- `RESET_LINK_INVALID` / `RESET_LINK_EXPIRED` → **bad**. 422 details at `password`, `confirm_password`; `Validation failed` at the top.

### 3.7 `/application` – ApplicationPage

**Header**: language toggle, first + last name and e-mail of the account, **Logout** (local).

**Loading**: `GET /application` and `GET /options` in parallel. `Loading your application…` until both are there. `GET /application` failing → its message in an error box (401 → login). `GET /options` failing → the page stays at `Loading your application…` for ever (F-8).

`app.editable` decides: `true` → the wizard (3.7.1), `false` → the submitted view (3.7.4).

#### 3.7.1 Wizard

- Step bar: `Step 1 of 3 Basic Details`, `Step 2 of 3 Main Form`, `Step 3 of 3 Upload Documents`. Opens at `clamp(current_step, 1, 3)`; steps above `current_step` are disabled. Done marks: `n < current_step`, or step 1 when `steps.basic_completed`.
- The typed values live in the page (`useState(app.form)`); later answers of the server replace `app` but **not** the typed values.
- **Autosave** (steps 1 and 2): 1.2 s after the last change, for each step with changes `PUT /application/steps/<step> { complete: false, data: { only the changed keys } }`, one request at a time. The answer is not read. Status texts: `Saving…`, `All changes saved`, `Not saved – no connection. It will be saved when you are back online.`
  - **Every failure (any status) counts as "offline"**: values stay pending in memory and in `edp.pending.<account id>`, and are sent again on the next change, on the browser's `online` event, before Save & Next / Submit, and on the next visit (then also laid over the server's values).
  - Consequence for the server: `complete:false` must accept everything the page can send and **ignore** keys it does not know or that are switched off (pending values may be older than the masters). A 4xx there would block the student: `Your latest changes could not be saved. Check your internet connection and try again.` (F-7).
  - A pending entry of step 3 (older portal) is dropped, never sent.
- **On opening**: a stored `centre_id` not in `options.centres`, or a stored `technology` not offered for the district, is cleared (and autosaved) with a warning shown at Technology: `The center you chose earlier is no longer available. Please choose the center again.` / `The technology you chose earlier is no longer offered in your district. Please choose a technology again.`
- **Save & Next →** (steps 1, 2): checks the active, asked fields of the step (2.7). Errors: at the fields and `Please correct the highlighted fields: <labels>.` No errors: dialog `Save Step <n> of 3 – <name>?` with **No, stay here** / **Yes, save & next**. Yes: pending autosaves first, then `PUT /application/steps/<n> { complete: true, data: { every active field of the step: value or '' } }` (own fields and not-asked ones included; `email` too). Success: `app` = answer, next step. Failure: field messages + the server's `message` at the top (so `Validation failed` for a 422).
- **← Back** / **Previous**: previous step, no call.

Step 1 and 2 fields: section 4. Step 3: section 5 plus the declaration.

#### 3.7.2 Step 3: documents, declaration, preview

- One `DocumentField` per `options.document_types`, in that order (section 5).
- Checkbox `I accept the declaration` with the text: *I hereby declare that all the above information is true to my personal knowledge and belief. Also, these are true copies of the original documents. I am aware that if the said information and documents are found to be false, a case will be registered against me under the Indian Penal Code and/or the relevant law, and I will be liable for punishment accordingly.* (English only). It is not saved; after a reload it must be ticked again.
- **Preview Application** and **Submit Application** (disabled during an upload) first run the same check: all active fields of both steps, `<document name> is required` for every mandatory listed document without a file in `draft_files`, `Please accept the declaration`. Errors: the first step with an error is opened, list at the top.
- Preview dialog: both steps (asked fields, names of choices, dates `DD/MM/YYYY`, score `72.50%` or `8.2 / 10`, **Aadhaar in full**, grouped `4821 3579 2463`), the documents with file name and size or `Not uploaded`, the declaration. Only **Close**; no call.
- Submit dialog `Submit your form?` – `Once submitted, it cannot be edited or submitted again.` – **No, go back** / **Yes, submit** (`Submitting…`; cannot be closed while running; a second click sends nothing).

#### 3.7.3 Submitting

1. Pending autosaves are sent; if that fails nothing is submitted.
2. `POST /application/submit { "declaration_accepted": true }`.
3. Success: pending store cleared; flash `Your form has been submitted successfully. Registration ID: <registration_id>.`; `GET /application` again (if that fails: `… Please refresh the page to see your registration.`, the wizard stays).
4. Failure: dialogs close, `details` at the fields, the first step with an error is opened, the server's `message` at the top. `409 ALREADY_SUBMITTED` is shown like any other failure; the page does not reload (F-15).

#### 3.7.4 Submitted view

- `support` line (2.6), then **Your registration**: `Submitted on <date, time>. The submission is final; the form cannot be changed.`, Registration ID, Registration Number (`—` if null), Status (`SUBMITTED` → `Submitted`; `REGISTRATION_PENDING` → `Received – pending verification`; `RECEIVED` → `Received`; else as sent), Submitted on. `registration: null` → `Your registration is no longer available. Please contact the programme office.` and nothing else.
- **Details**: `view_fields` in the order sent, label in the chosen language, `text`; DATE fields shown `DD/MM/YYYY`; `score` with `%` or ` / <scale>`; disability details only when `disability_status` is `Yes`, CGPA scale only when `grading_type` is `CGPA`; blank = `—`. (Without `view_fields`: built from `form` + `registration.display`.)
- **Documents**: `submitted_files`; name from `options.document_types` (chosen language) when still listed, else `name`; file name is a button → `GET /application/documents/<CODE>/file`; failure `Could not open the file`; upload date. Column **Verification** only when at least one file has `verified: true` (badge `Verified`).
- No approval stage, rejection or remark is ever shown to the student (F-18). `documents`, `barcodes` of the answer are not used.

---

## 4 The form model (steps 1 and 2)

The form is defined by `GET /options`: `fields` (the active ones), `lists`, `districts`, `centres`, `district_technologies`. Fields are sorted by `step`, then `order`. Any `step` other than 1 counts as 2.

### 4.1 Fields

Default rows of the Form fields master (seed, migration `1799300000000`). **Core** = always active and required (only labels, help and order can be changed). Every label, help text, order, and for non-core fields required / active, can change in the tracking panel; keys never change.

**Step 1** (order 10, 20, 30, …)

| # | Key | Label EN / MR | `type` | Required | Core | Control and input limits | Choices (`options_kind`) |
|---|---|---|---|---|---|---|---|
| 1 | `first_name` | First Name / पहिले नाव | TEXT | yes | yes | text, 100 | – |
| 2 | `last_name` | Last Name / आडनाव | TEXT | yes | yes | text, 100 | – |
| 3 | `father_name` | Father Name / वडिलांचे नाव | TEXT | yes | yes | text, 150 | – |
| 4 | `mother_name` | Mother Name / आईचे नाव | TEXT | yes | yes | text, 150 | – |
| 5 | `email` | Email / ईमेल आयडी | TEXT | yes | yes | read-only, the account's e-mail | – |
| 6 | `date_of_birth` | Date of Birth / जन्मतारीख | DATE | yes | yes | date, max today, min 1920-01-01 (picker only) | – |
| 7 | `current_address` | Current Address / सध्याचा पत्ता | TEXTAREA | yes | yes | textarea, 500 | – |
| 8 | `permanent_address` | Permanent Address / कायमचा पत्ता | TEXTAREA | yes | no | textarea, 500; tick "same as the current address" copies and locks it | – |
| 9 | `landmark` | Landmark / जवळची खूण | TEXT | no | no | text, 150 | – |
| 10 | `pin_code` | PIN Code / पिन कोड | TEXT | yes | no | digits only, 6 | – |
| 11 | `district_id` | District / जिल्हा | DROPDOWN | yes | yes | select | `options.districts` (`id`, `name`) |
| 12 | `taluka` | Taluka / तालुका | TEXT | no | no | text, 100; free text, independent of the district | – |
| 13 | `aadhaar_number` | Aadhaar Number / आधार क्रमांक | TEXT | yes | yes | text, 14, numeric keypad | – |
| 14 | `mobile_number` | Mobile Number / मोबाईल क्रमांक | TEXT | yes | yes | tel, 15 | – |
| 15 | `religion` | Religion / धर्म | DROPDOWN | yes | yes | select (Marathi names) | `RELIGION`, stores `code` |
| 16 | `caste_id` | Caste / जात | DROPDOWN | yes | yes | select (Marathi names) | `CASTE`, stores the master row's id |
| 17 | `gender` | Gender / लिंग | DROPDOWN | yes | no | select | `GENDER`, code |
| 18 | `marital_status` | Marital Status / वैवाहिक स्थिती | DROPDOWN | yes | no | select | `MARITAL_STATUS`, code |
| 19 | `alternate_mobile_number` | Alternate Mobile Number / पर्यायी मोबाईल क्रमांक | TEXT | no | no | tel, 15 | – |
| 20 | `alternate_email` | Alternate Email / पर्यायी ईमेल आयडी | TEXT | no | no | email, 254 | – |
| 21 | `disability_status` | Person with Disability / दिव्यांग व्यक्ती | DROPDOWN | yes | no | radio Yes / No; stores `Yes` / `No` (fixed, not a list) | – |
| 22 | `disability_type` | Type of Disability / दिव्यांगत्वाचा प्रकार | TEXT | yes | no | text, 100; **only when status = Yes** | – |
| 23 | `disability_certificate_number` | Disability Certificate Number / दिव्यांग प्रमाणपत्र क्रमांक | TEXT | yes | no | text, 50; **only when status = Yes** | – |

**Step 2** (order 10, 20, …)

| # | Key | Label EN / MR | `type` | Required | Core | Control and input limits | Choices |
|---|---|---|---|---|---|---|---|
| 1 | `region_id` | Course District / अभ्यासक्रमाचा जिल्हा | DROPDOWN | yes | yes | select | `REGION`, master id |
| 2 | `centre_id` | Center Name / केंद्राचे नाव | DROPDOWN | yes | yes | select, shown `<name> (<district_name>)` | `options.centres`, id |
| 3 | `technology` | Technology / तंत्रज्ञान | DROPDOWN | yes | yes | select, depends on `district_id` (4.2) | `TECHNOLOGY`, code |
| 4 | `education_id` | Education Qualification / शैक्षणिक पात्रता | DROPDOWN | yes | yes | select | `EDUCATION`, master id |
| 5 | `educational_status` | Educational Status / शैक्षणिक स्थिती | DROPDOWN | yes | no | select | `EDUCATIONAL_STATUS`, code |
| 6 | `qualification_name` | Qualification Name / पात्रतेचे नाव | TEXT | yes | no | text, 150 | – |
| 7 | `qualification_stream` | Subject / Stream / Branch / विषय / शाखा | TEXT | yes | no | text, 150 | – |
| 8 | `qualification_board` | College Name / महाविद्यालयाचे नाव | TEXT | yes | no | text, 200 | – |
| 9 | `qualification_completed_on` | Qualification Completed On / पात्रता पूर्ण झाल्याची तारीख | DATE | yes | no | date, max today, min 1950-01-01 (picker only) | – |
| 10 | `grading_type` | Grading Type / गुणांकन प्रकार | DROPDOWN | yes | no | select | `GRADING_TYPE`, code `PERCENTAGE` / `CGPA` |
| 11 | `cgpa_scale` | CGPA Scale / सीजीपीए मापन | DROPDOWN | yes | no | select, numeric names shown `Out of <n>`; **only when grading = CGPA** | `CGPA_SCALE`, code (a number as text) |
| 12 | `score` | Score / गुण | NUMBER | yes | no | text, 6, typed pattern `^\d{0,3}(\.\d{0,2})?$`; label `Score (<grading>)` | – |
| 13 | `qualification_class` | Class / Division / श्रेणी | DROPDOWN | yes | no | select | `QUALIFICATION_CLASS`, code |

**Own fields** (added in the tracking panel): key `x_<slug>` (`^x_[a-z0-9_]+$`), `custom: true`, any step, type TEXT (250) / TEXTAREA (2000) / NUMBER (20 typed) / DATE / DROPDOWN (choices in `lists['FIELD:<key>']`, value = code). Shown last in their step under "Additional details". Keys are never reused after deletion.

Drawing rules the server's data must satisfy:

- Known dropdowns other than `disability_status`, `technology` are drawn as a select only when `type` is `DROPDOWN`. Any key the portal does not know is drawn as an own field by its `type`.
- `options_kind` = the list of the field; `null` → the portal's built-in kind for known keys, `FIELD:<key>` for an own dropdown.
- Step 2 groups: course (`region_id, centre_id, technology, education_id`), "Qualification details" (the other known ones), "Additional details" (own).
- `help_en` / `help_mr` replace the portal's built-in hint of a field.
- The stored value of a choice never changes when the choice is renamed.

### 4.2 Conditions

| Condition | Page | Server must do |
|---|---|---|
| `disability_status` ≠ `Yes`, or that field switched off | type and certificate not asked, not checked; changing to `No` sends them as `''` | not required, stored as `''` on a complete save |
| `grading_type` ≠ `CGPA`, or that field switched off | `cgpa_scale` not asked; changing it sends `''` | same |
| District → technology | `district_technologies[district_id]` (codes), when present and not empty, limits the list; otherwise every active technology. Changing the district clears a technology it does not offer (`The technology you chose is not offered in this district. Please choose a technology again.`). No choice left: `No technologies are currently offered in the chosen district.` | `technology` must be an active choice and offered in `district_id` (step 1), else 422. Send only **active** codes; a district whose chosen codes are all inactive must be left out (= all offered) |
| Centre | not linked to the district or the course district | must exist, active, not deleted |
| Field switched off | not asked, not checked, not sent; a stored value is kept | ignored in requests, not required, stored value kept; still shown in `view_fields` when it has a value |
| Field made optional | blank accepted, a value still checked | same |
| Choice switched off or deleted | not offered; a stored value fails `Select a valid …` | refused in the draft; the name is still shown on submitted forms |

### 4.3 Server checks and messages (complete save of a step, and submission)

Errors are `{ field: "body.<key>", message }`, in form order (cross-field rules last), HTTP 422 `VALIDATION_ERROR`, message `Validation failed`. `<L>` = the field's **current** English label. A blank field yields only the required error; a field that is wrong is not used in cross-field rules.

| Field | Message(s) |
|---|---|
| any required, blank | `<L> is required` |
| `first_name`, `last_name` (100), `father_name`, `mother_name` (150) | `<L> must be at most <n> characters`; `<L> may contain only letters, spaces and . ' -` |
| `email` | taken from the account, never from the request; `<L> address is not valid` |
| `date_of_birth` | `<L> must be in YYYY-MM-DD format`; `<L> is not a real date`; `<L> cannot be in the future`; `Applicant must be between 14 and 100 years old` |
| `current_address`, `permanent_address` (500), `landmark` (150), `taluka` (100), `disability_type` (100), `qualification_name`, `qualification_stream` (150), `qualification_board` (200) | `<L> must be at most <n> characters` |
| `aadhaar_number` (≤ 20 typed) | `<L> must be 12 digits with a valid checksum`; already submitted elsewhere: `A registration with this Aadhaar number already exists` |
| `mobile_number` (≤ 20 typed) | `<L> must be a 10-digit Indian number starting 6–9` |
| `alternate_mobile_number` | same text; `<L> must be different from <label of mobile_number>` (after normalising) |
| `alternate_email` | `<L> must be at most 254 characters`; `<L> must be a valid email address`; `<L> must be different from <label of email>` (case-insensitive) |
| `pin_code` | `<L> must be exactly 6 digits` (`^[1-9]\d{5}$`) |
| `disability_status` | `Select a valid <L>` (only `Yes` / `No`) |
| `disability_certificate_number` | `<L> may contain only letters, digits, / and - (4–50 characters)` |
| `district_id`, `centre_id`, `caste_id`, `education_id`, `region_id` | `<L> not found or inactive` (a value that is not a UUID too, never a 500) |
| `religion`, `gender`, `marital_status`, `educational_status`, `grading_type`, `cgpa_scale`, `qualification_class`, own dropdowns | `Select a valid <L>` |
| `technology` | `Select a valid <L>`; `<L> is not offered in the selected district` |
| `qualification_completed_on` | `<L> must be in YYYY-MM-DD format`; `<L> is not a real date`; `<L> is too far in the past` (before 1940); `<L> cannot be in the future` |
| `score` | `Enter a number with at most 2 decimal places` (`^\d{1,3}(\.\d{1,2})?$`); range: `<name of the grading type, else L> must be between 0 and <limit>`. Limit: percentage or no grading type 100; CGPA = the given scale; CGPA without a scale = the largest active scale when `cgpa_scale` is off or optional (a required missing scale is reported by itself, limit 100) |
| own NUMBER / DATE / TEXT / TEXTAREA | `<L> must be a number`; `<L> must be a real date in YYYY-MM-DD format`; `<L> must be at most 250 / 2000 characters` |

Values are trimmed before checking and storing. Mobile numbers of the form are stored as typed, not normalised (F-5).

---

## 5 Documents (step 3)

Seed of the Documents master, in order (order 10, 20, …):

| Code | Name EN / MR | Required | Kind |
|---|---|---|---|
| `PHOTO` | Photo / छायाचित्र | yes | DOCUMENT |
| `SIGNATURE` | Signature / स्वाक्षरी | yes | DOCUMENT |
| `AADHAAR_CARD` | Aadhar Card / आधार कार्ड | yes | DOCUMENT |
| `AADHAAR_PHOTO` | Applicant Photograph with Aadhaar / आधार कार्डसह अर्जदाराचे छायाचित्र | yes | DOCUMENT |
| `APPLICANT_VIDEO` | Applicant Video with Aadhaar / आधार कार्डसह अर्जदाराचा व्हिडिओ | no | VIDEO |
| `PAN_CARD` | PAN Card / पॅन कार्ड | yes | DOCUMENT |
| `HSC_DIPLOMA` | 12th Pass Or 3 Years Diploma Pass Marksheet / Certificate / १२ वी उत्तीर्ण किंवा ३ वर्षांची पदविका उत्तीर्ण गुणपत्रिका / प्रमाणपत्र | yes | DOCUMENT |
| `EDU_CERT` | Highest Qualification Certificate / Marksheet / सर्वोच्च पात्रतेचे प्रमाणपत्र / गुणपत्रिका | yes | DOCUMENT |
| `INCOME_EWS` | EWS Certificate / ईडब्ल्यूएस प्रमाणपत्र | yes | DOCUMENT |
| `SCHOOL_LEAVING` | School Leaving Certificate / Transfer Certificate / शाळा सोडल्याचा दाखला / स्थलांतर प्रमाणपत्र | yes | DOCUMENT |
| `DOMICILE` | Domicile of Certificate Maharashtra / महाराष्ट्र अधिवास प्रमाणपत्र | yes | DOCUMENT |

Own documents get the code `IPP_DOC_<n>`. Codes: `^[A-Z][A-Z0-9_]*$`, at most 40.

| Kind | Formats | Max | Detected by content |
|---|---|---|---|
| DOCUMENT | PDF, JPG, JPEG, PNG | 5 MB | `%PDF-`; `FF D8 FF`; PNG signature |
| VIDEO | MP4 | 50 MB | `ftyp` at bytes 4–7, brand not `qt  ` |

`1 MB = 1024 × 1024`. The extension must agree with the content (`.jpg`/`.jpeg` both JPEG). The page takes `formats` and `max_mb` of each type when sent, otherwise by `kind`.

`DocumentField`: label with `*` when mandatory, else ` (optional)` unless the name already says so; drop area (click, Enter, Space, drop one file) showing the file name or `No file chosen`, `✓ Uploaded · <size>`, `Click or drag file`, `PDF, JPG, PNG · max 5MB`; hint `Accepted formats: PDF, JPG, JPEG, PNG (max 5MB)`; **View** (opens the file; failures are silent in the draft), **Replace** (file chooser, then upload), **Remove** (no confirmation → `DELETE`; failure at the top of the step); while uploading `Uploading…`. Client-refused files are never sent. Upload failure: the message of `files.<CODE>`, else the server's message, else `Upload failed`.

Server messages (422, field `files.<CODE>`): `Unknown or inactive document type`; `Only one <name> file may be uploaded`; `<name>: file is larger than <n> MB`; `<name>: only PDF, JPG, JPEG or PNG files are accepted`; `<name>: only MP4 videos are accepted`; no file at all: field `files`, `Choose a file to upload`; larger than the request limit (50 MB): `files.<CODE>`, `File is larger than <n> MB`. At submission: `<name> is required`. `<name>` = the current English name.

---

## 6 API reference

Common to all: success and error envelopes in (b). Auth `student` = `Authorization: Bearer` student token; failures 401 `UNAUTHORIZED` (messages in (c)) → the page silently goes to `/login`. Every endpoint can answer 429 `RATE_LIMITED`, 400 `BAD_REQUEST` (malformed JSON: `Malformed JSON body`), 413 `PAYLOAD_TOO_LARGE` (JSON over 100 KB), 500 `INTERNAL_ERROR`. JSON bodies are strict: an unknown key is a 422 at field `body`.

Types used below:

```ts
interface Account { id: string; first_name: string; middle_name: string | null; last_name: string; email: string; mobile_number: string; email_verified: boolean }
interface Session { token: string; expires_at: string /* ISO, not read */; account: Account }
interface OtpTiming { email: string; mobile_masked: string | null /* +91XXXXXX1234 */; otp_expires_in: number /* s, 0 = expired */; resend_after: number /* s, 0 = now */ }
interface StoredFile { doc_type: string; name: string; original_name: string; mime_type: string; size_bytes: number; uploaded_at: string /* ISO */; verified?: boolean /* submitted files only */ }
interface ViewField { key: string; step: number; label_en: string; label_mr: string; type: FieldType; value: string; text: string; custom: boolean }
type FieldType = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'DATE' | 'DROPDOWN';
interface Application {
  status: 'DRAFT' | 'SUBMITTED';
  current_step: 1 | 2 | 3;                                   // highest step open to the student; 3 after submission
  steps: { basic_completed: boolean; main_completed: boolean };
  editable: boolean;                                          // status === 'DRAFT'
  submitted_at: string | null;                                // ISO
  form: Record<string, string>;                               // every known key and every own key; '' when empty, never null or a number
  draft_files: StoredFile[];                                  // DRAFT: files of documents asked for now; [] when submitted
  submitted_files: StoredFile[];                              // SUBMITTED; [] in a draft
  registration: null | { registration_id: string; registration_number: string | null; status: string; aadhaar_masked: string | null; display: Record<string, string | null> };
  view_fields: ViewField[];                                   // SUBMITTED; [] in a draft
  documents: object[];                                        // not read by the student page
  barcodes: Record<string, string>;                           // not read; always {}
}
interface Submitted { registration_id: string; registration_number: string | null; status: string }
```

Fields of `Application` read by the page: all except `documents`, `barcodes`, and `registration.display` (fallback only).

### 6.1 `POST /auth/register` – create account

Auth none. Body:

```ts
{ first_name: string; middle_name?: string; last_name: string; email: string; mobile_number: string; password: string; confirm_password: string }
```

| Field | Server rule | Messages (field `body.<key>`) |
|---|---|---|
| `first_name`, `last_name` | trim, 1–100, name pattern | `First name is required` / `… must be at most 100 characters` / `… may contain only letters, spaces and . ' -` (same with `Last name`) |
| `middle_name` | optional, trim, ≤ 100, name pattern when not blank | `Middle name must be at most 100 characters`, `Middle name may contain only letters, spaces and . ' -` |
| `email` | trim, lower-case, ≤ 254, valid e-mail | `Email is required`, `Email must be at most 254 characters`, `Enter a valid email address` |
| `mobile_number` | trim, ≤ 20, normalised → `^[6-9]\d{9}$`; stored as 10 digits | `Mobile number is required`, `Mobile number must be a 10-digit Indian number starting 6–9` |
| `password` | 8–72, a letter A–Z/a–z, a digit | as 2.7 |
| `confirm_password` | equal | `Please re-enter the password`, `Passwords do not match` |

Behaviour: verified account with this e-mail → 409. Otherwise creates the account unverified, or **replaces** first/middle/last name, mobile and password of the unverified one. Changed mobile: the pending OTP is dropped and a new one is sent now. Otherwise, while the pending OTP still works, no new SMS is sent and its remaining timing is returned; after it has expired a new one is sent.

**201**, `data: OtpTiming`, message `An OTP has been sent to your mobile number`. Read: `email`, `otp_expires_in`, `resend_after`, `mobile_masked`.

Errors: 422; 409 `CONFLICT` `An account with this email address already exists. Please log in.`; 409 `CONFLICT` `This email address was just registered. Please enter the OTP sent to it.` (two sign-ups at once); 429 `OTP_RESEND_TOO_SOON` `Too many OTP requests. Please try again after an hour.`; 503 `SMS_UNAVAILABLE` `The OTP SMS could not be sent right now. Please try again in a few minutes.` (the account row stays, unverified; signing up again works at once).

### 6.2 `POST /auth/verify-otp`

Auth none. Body `{ email, otp, password }` (`otp` `^\d{6}$` → `Enter the 6-digit OTP`; `password` 1–200). Checks in this order:

1. no account → 400 `OTP_NOT_PENDING` `No OTP is pending for this account. Please request a new OTP.`
2. already verified → 409 `CONFLICT` `This email address is already verified. Please log in.`
3. no pending OTP → 400 `OTP_NOT_PENDING`
4. expired → 400 `OTP_EXPIRED` `OTP has expired. Please request a new OTP.`
5. 5 wrong attempts already → 429 `OTP_TOO_MANY_ATTEMPTS` `Too many incorrect attempts. Please request a new OTP when the current one expires.`
6. wrong OTP → attempt + 1, 400 `OTP_INCORRECT` `Incorrect OTP`
7. wrong password → attempt + 1, 400 `SIGNUP_PASSWORD_MISMATCH` `This is not the password chosen when the account was created. Enter that password, or create the account again.`
8. ok → verified, OTP cleared (one conditional update: still unverified and password unchanged), application created, last login set.

**200**, `data: Session`, message `Account created. Your mobile number is verified.`

### 6.3 `POST /auth/resend-otp`

Auth none. Body `{ email }`. **200** `data: OtpTiming` (the new code; it replaces the old one). Errors: 404 `NOT_FOUND` `No account was found for this email address. Please create an account.`; 409 already verified; 429 `OTP_RESEND_TOO_SOON` `Please wait <45 seconds | 4 min 47 s | 5 min> before requesting a new OTP.` / `Too many OTP requests. Please try again after an hour.` / `An OTP was just sent. Please check the SMS on your mobile.`; 503 `SMS_UNAVAILABLE`; 422.

### 6.4 `POST /auth/otp-status`

Auth none. Body `{ email }`. **200** `data: OtpTiming` with the **remaining** seconds, rounded up, 0 when over. Errors: 404, 409 (as 6.3), 422.

### 6.5 `POST /auth/login`

Auth none. Body `{ email, password }` (password 1–200). **200** `data: Session`, message `Logged in`.

Errors: 401 `UNAUTHORIZED` `Incorrect email or password` (unknown e-mail or wrong password; meant to take the same time, F-17a); 403 `FORBIDDEN` `This account has been disabled. Please contact the programme office.`; 403 `EMAIL_NOT_VERIFIED` `Your mobile number is not verified yet. Enter the OTP sent to your mobile number.` (first sends a new OTP if one may be sent; a resend limit is ignored, 503 `SMS_UNAVAILABLE` is not, F-6); 422 `body.email`, `body.password`.

### 6.6 `POST /auth/forgot-password`

Auth none. Body `{ email }`. Registered e-mails only (verified or not).

**200** `data: { email: string; link_valid_minutes: 30; resend_after: 60 }`, message `A password reset link has been sent to your email ID. The link is valid for 30 minutes.` All three are read.

Errors: 404 `EMAIL_NOT_REGISTERED` `This email ID is not registered. Kindly check your email ID.`; 403 `FORBIDDEN` (disabled); 429 `RESET_TOO_SOON` `A password reset link was just sent to this email ID. Please check your email, or try again in <n seconds | 1 min>.` / `Too many password reset requests for this email ID. Please try again after an hour.`; 503 `EMAIL_UNAVAILABLE` `Email could not be sent right now. Please try again in a few minutes.` (then nothing is pending and it does not count); 422.

### 6.7 `POST /auth/reset-password/check`

Auth none. Body `{ token }` (trim, 1–200; `The password reset link is incomplete` / `This password reset link is not valid`). **200** `data: { email: string }`. Errors: 400 `RESET_LINK_INVALID`, 400 `RESET_LINK_EXPIRED` (texts in 2.3); unknown, used, replaced link, or a disabled account → INVALID; 422.

### 6.8 `POST /auth/reset-password`

Auth none. Body `{ token, password, confirm_password }` (sign-up password rules, `body.password`, `body.confirm_password`). **200** `data: { email: string }`, message `Your password has been changed. Please log in with your new password.` Effects: password replaced, `passwordChangedAt` = now (older sessions refused), link cleared, pending OTP cleared, an unverified account becomes verified (F-4), application created. Errors as 6.7 + 422.

### 6.9 `GET /options`

Auth none; called on almost every page. **200** `data: Options`.

```ts
interface Options {
  // read by the portal
  fields: { key: string; step: 1 | 2; label_en: string; label_mr: string | null; required: boolean; type: FieldType; core: boolean /* not read here */; custom: boolean; order: number; options_kind: string | null; help_en: string | null; help_mr: string | null }[];   // ACTIVE fields only
  lists: Record<string, { value: string; name_en: string; name_mr: string | null }[]>;   // ACTIVE choices in order, per kind: CASTE, EDUCATION, REGION (value = master id), RELIGION, GENDER, MARITAL_STATUS, EDUCATIONAL_STATUS, GRADING_TYPE, CGPA_SCALE, QUALIFICATION_CLASS, TECHNOLOGY, FIELD:<own dropdown key> (value = code)
  districts: { id: string; name: string; code: string }[];                                // active, A–Z; id and name read
  centres: { id: string; name: string; code: string; district_name: string }[];           // active, by name; id, name, district_name read
  district_technologies: Record<string /* district id */, string[] /* active codes */>;   // only districts with a selection
  document_types: { id: string; code: string; name: string; name_mr: string | null; is_mandatory: boolean; kind: 'DOCUMENT' | 'VIDEO'; formats: string[]; max_mb: number; barcode: null }[];   // active, in order; id and barcode not read
  support: { message: string; email: string | null; mobile: string | null };
  welcome: { enabled: boolean; title: string; message: string; button_label: string };
  help: { enabled: boolean; title: string; intro: string; fields: { label: string; value: string }[] /* at most 4 */ };
  // sent by the current API and used only when `fields` / `lists` are missing (older API): not needed by a new backend
  regions; castes; educations; religions; tracks; technologies; genders; marital_statuses; educational_statuses; grading_types; cgpa_scales; qualification_classes;
}
```

`document_types` must always be an array. `fields` empty or missing makes the portal fall back to its built-in list, so it must not be empty. Errors: page-specific (3.1 retry; 3.7 waits for ever).

Content of `support`, `welcome`, `help`: the saved settings of the tracking panel, else defaults (Appendix).

### 6.10 `GET /me`

Auth student. **200** `data: Account`. Read: `id` (pending-store key), `first_name`, `last_name`, `email`.

### 6.11 `GET /application`

Auth student. Creates the application on first use. **200** `data: Application`.

- DRAFT: `form` = stored values; blank `first_name`, `last_name`, `mobile_number` prefilled from the account; `email` always the account's; `aadhaar_number` **in full** when stored.
- SUBMITTED: `form.aadhaar_number` = `''`; `registration` filled (`registration.status` = `SUBMITTED`, `aadhaar_masked` = `XXXX-XXXX-1234`); `view_fields` = every active field in order plus switched-off ones with a value, `text` = names of choices (English; caste and religion Marathi), dates as stored, Aadhaar masked, `value` of Aadhaar `''`; `submitted_files[].verified` = the Auditor's check.

### 6.12 `PUT /application/steps/:step` (`1` or `2`)

Auth student. Body `{ complete: boolean (default false); data: Record<string, string> }`. `data`: at most 200 keys, each value a string of at most 2000 characters without control characters other than tab / line breaks (422 `Value must be text`, `Value is too long`, `Value contains characters that cannot be saved`, field `body.data.<key>`; `Too many values`, field `body.data`). Keys that are not active fields of that step are ignored; `email` is ignored.

- `complete: false`: stores the values as typed, nothing else is checked. Aadhaar: 12 digits (after removing spaces and `-`) → stored encrypted; blank → cleared; anything else → ignored (F-13).
- `complete: true`: stores them likewise **first** (kept even when the check fails), then checks the step (4.3; a field not sent counts as blank; the other step is taken as stored), then the Aadhaar uniqueness (step 1), then stores the checked values, sets `basic_completed` / `main_completed` (first time) and `current_step = max(current_step, step + 1)`.

**200** `data: Application`, message `Saved`. (Read only for `complete: true`.)

Errors: 422 with `body.<key>`; 409 `CONFLICT` `Please complete Step 1 – Basic Details first.` (step 2 complete before step 1 was); 409 `ALREADY_SUBMITTED` `Your form has already been submitted. A submitted form cannot be changed.`; 422 `params.step` for another step. (The current API also takes step 3 = certificate barcodes; the portal never calls it.)

### 6.13 `POST /application/documents`

Auth student. `multipart/form-data`, one file field **named after the document code** (the page sends one per request; the API takes up to 20 files, one per code). Request limit 50 MB per file; a reverse proxy must allow it. Replaces an earlier file of that code.

**200** `data: Application`, message `Uploaded` (read: `draft_files`). Errors: 422 `files.<CODE>` (section 5); 409 `ALREADY_SUBMITTED`; 400 for other multipart errors.

### 6.14 `DELETE /application/documents/:docType`

Auth student. **200** `data: Application`, message `Removed`. Errors: 404 `NOT_FOUND` `No file has been uploaded for this document`; 409 `ALREADY_SUBMITTED`; 422 `params.docType` (`^[A-Za-z0-9_]{1,40}$`, case-insensitive).

### 6.15 `GET /application/documents/:docType/file`

Auth student (header, not query). **200** the file: `Content-Type` as stored (`application/pdf`, `image/jpeg`, `image/png`, `video/mp4`), `Content-Disposition: inline; filename="<encoded original name>"`, `Cache-Control: private, no-store`. Own files, draft and submitted, also of a document switched off later. Errors: 404 (as 6.14); the page shows `Could not open the file` (submitted) or nothing (draft).

### 6.16 `POST /application/submit`

Auth student. Body `{ declaration_accepted: true }` (422 `body.declaration_accepted` `The declaration must be accepted`; the current API also accepts an unused `barcodes`).

Server: one submission at a time per application; whole form checked again against the masters as they are **now** (4.3) and every mandatory active document present; then in one transaction under a per-Aadhaar lock: no other submitted form with this Aadhaar, registration ID and number allocated, files moved to the candidate folder (back on failure), status `SUBMITTED`, `submitted_at`, `current_step` 3, Aadhaar blind index and last four digits set. Files of codes that are no document of the program are removed.

**201** `data: Submitted` (`registration_id` shown), message `Your form has been submitted successfully`.

Errors: 422 (`body.<key>`, `files.<CODE>`); 409 `ALREADY_SUBMITTED`; 409 `CONFLICT` `A registration with this Aadhaar number already exists`; 409 `CONFLICT` `Your form is already being submitted. Please wait a moment.`; 409 `CONFLICT` `Could not allocate a registration number right now; please try again`.

---

## (a) All endpoints of this part

| # | Method | Path | Auth | Success | Used by |
|---|---|---|---|---|---|
| 1 | POST | `/auth/register` | – | 201 OtpTiming | /register |
| 2 | POST | `/auth/verify-otp` | – | 200 Session | /verify |
| 3 | POST | `/auth/resend-otp` | – | 200 OtpTiming | /verify |
| 4 | POST | `/auth/otp-status` | – | 200 OtpTiming | /verify |
| 5 | POST | `/auth/login` | – | 200 Session | /login |
| 6 | POST | `/auth/forgot-password` | – | 200 `{email, link_valid_minutes, resend_after}` | /forgot-password |
| 7 | POST | `/auth/reset-password/check` | – | 200 `{email}` | /reset-password |
| 8 | POST | `/auth/reset-password` | – | 200 `{email}` | /reset-password |
| 9 | GET | `/options` | – | 200 Options | every page |
| 10 | GET | `/me` | student | 200 Account | page load |
| 11 | GET | `/application` | student | 200 Application | /application |
| 12 | PUT | `/application/steps/{1\|2}` | student | 200 Application | /application |
| 13 | POST | `/application/documents` | student | 200 Application | step 3 |
| 14 | DELETE | `/application/documents/{docType}` | student | 200 Application | step 3 |
| 15 | GET | `/application/documents/{docType}/file` | student | 200 file | step 3, submitted view |
| 16 | POST | `/application/submit` | student | 201 Submitted | step 3 |

16 endpoints. Also called by shared code on page load when a tracking-panel token is stored: `GET /manage/me` (other document). Existing in the current API but **not called** by the student portal: `PUT /application/steps/3`, `GET /districts/{id}/talukas`, `GET /centres/{id}/technologies`, `/geography/*` (tracking panel).

---

## (b) Response and error envelopes

```ts
// success; `status` equals the HTTP status; meta only on paged lists (not in this part)
{ success: true, status: number, message: string, data: T, meta?: { page, limit, total, totalPages } }
// failure
{ success: false, status: number, message: string, data: null,
  error: { code: string, details?: { field?: string, message: string }[], requestId?: string } }
```

Read by the portal: `data`, `meta`, `message`, `error.code`, `error.details[].field`, `error.details[].message`. Success messages are never shown in the student part (the pages use their own text).

Generic codes: 400 `BAD_REQUEST`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND` / `ROUTE_NOT_FOUND`, 409 `CONFLICT`, 413 `PAYLOAD_TOO_LARGE`, 422 `VALIDATION_ERROR` (message `Validation failed`), 429 `RATE_LIMITED` (`Too many requests, please try again later`), 500 `INTERNAL_ERROR`, 503 `SERVICE_UNAVAILABLE`. Program codes: `OTP_INCORRECT`, `OTP_EXPIRED`, `OTP_NOT_PENDING` (400), `OTP_TOO_MANY_ATTEMPTS`, `OTP_RESEND_TOO_SOON` (429), `SIGNUP_PASSWORD_MISMATCH` (400), `EMAIL_NOT_VERIFIED` (403), `EMAIL_NOT_REGISTERED` (404), `RESET_TOO_SOON` (429), `RESET_LINK_INVALID`, `RESET_LINK_EXPIRED` (400), `ALREADY_SUBMITTED` (409), `SMS_UNAVAILABLE`, `EMAIL_UNAVAILABLE` (503).

`details[].field` naming: `body.<key>` (request body and form fields; keys inside `data` of a step save may be `body.data.<key>`), `params.<name>`, `query.<name>`, `files.<CODE>`, `files`. Order matters: the first message per field is shown.

Other headers of the current API: `X-Request-Id` echoed, `RateLimit` / `RateLimit-Policy` (draft-7), helmet headers; CORS allows the configured origins, methods GET POST PUT PATCH DELETE OPTIONS, headers `Content-Type`, `Authorization`, …; exposes only `X-Request-Id`.

---

## (c) Tokens, 401 and storage

- Student token: JWT HS256, claims `sub` (account id), `aud` `edp-student`, `iss` `amrut-edp`, `pv` (password version = `passwordChangedAt` in ms, 0 if never), `jti`, `exp`. Own signing key; a tracking-panel token (`aud` `edp-admin`, another key) or any other token is refused, and the reverse. Lifetime `EDP_SESSION_HOURS` (default 12 h); no refresh, no server-side logout.
- Per request the API loads the account: must exist, not deleted, active, verified; `pv` must equal the current password version.
- 401 messages (not shown to the student): `Please log in to continue.` (no token, account gone, disabled or unverified), `Your session has expired. Please log in again.`, `Your password was changed. Please log in again.` All with code `UNAUTHORIZED`.
- Page on 401 of a signed-in call: removes the token, `user = null`, `RequireStudent` goes to `/login` without a message; unsaved typed values stay in `edp.pending.<account id>` and are sent after the next login. Exceptions: file view (2.1), and 401 of `/auth/login` (no realm: shown as a login failure).
- Storage: `localStorage['edp.token']` (2.4). Content Security Policy / XSS hardening of the portal host is therefore relevant.

---

## (d) Business rules the server must enforce

### Accounts

1. One account per e-mail (trimmed, lower-cased, unique among non-deleted accounts). The same mobile number may be used by several accounts (no rule today, F-5).
2. Password bcrypt (cost 12, max 72 characters), never returned or logged.
3. An account can sign in only after the SMS OTP (or a password reset, F-4). Before that a new sign-up with the e-mail replaces its details; verifying needs the password of the **latest** sign-up, so nobody can take over an account by signing up with someone else's e-mail.
4. After verification the student cannot change name, e-mail or mobile of the account (no endpoint); the password only through the reset link. (The Auditor's change of the form's first / last name also changes the account's name.)
5. A disabled account (`isActive = false`) cannot log in, reset or use a token.

### Timing and limits

| Rule | Value | Configuration of the current API |
|---|---|---|
| OTP length, storage | 6 digits, random; only an HMAC (keyed, bound to the account) is stored | – |
| OTP lifetime | 300 s | `EDP_OTP_TTL_SECONDS` 10–1800 |
| Resend wait | = lifetime (so only after expiry) | `EDP_OTP_RESEND_SECONDS` 10–1800, capped at the lifetime |
| Wrong attempts per OTP (OTP or password) | 5, then blocked until a new OTP | – |
| OTP sends per account | 10 in a rolling hour (window starts with the first); a failed SMS does not count | – |
| New OTP | replaces the old one; attempts reset; the send slot is taken by a conditional update (no double send) | – |
| Reset link | 43-character base64url (256 bit) token, only its HMAC stored; 30 minutes; once; a new one replaces the old | fixed |
| Reset link wait / limit | 60 s / 5 in a rolling hour per account; a failed e-mail does not count | fixed |
| Session | 12 h; ended by a password reset | `EDP_SESSION_HOURS` |
| Auth endpoints (all `/auth/*` and the tracking panel login together) | 30 requests per IP per 15 min → 429 `RATE_LIMITED` | `EDP_RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| All endpoints | 300 requests per IP per 15 min (client address from exactly one reverse proxy) | `RATE_LIMIT_MAX` |

### Application

1. Exactly one application per account (unique `accountId`), created on first use.
2. States `DRAFT` → `SUBMITTED` only. Submitted once, final for the student: every change (step save of any kind, upload, removal, submit) → 409 `ALREADY_SUBMITTED`. Viewing own files stays possible.
3. Editable when:

| Data | Draft | Submitted |
|---|---|---|
| `email` | never (account's) | never |
| every other active field | student | Auditor (tracking panel) until the final approval; `district_id` not once in a batch |
| documents | student: add, replace, remove | Auditor: add, replace; a replaced file must be verified again |
| Aadhaar | student | Auditor |

4. Step 2 can be completed only after step 1 was completed once. Later changes to step 1 do not reopen step 2; everything is checked again at submission against the masters of that moment.
5. Values of switched-off fields stay stored; a partial save merges into the stored values.
6. Registration ID `IPP-` + 6-digit sequence (`IPP-000001`; gaps allowed), unique. Registration number: 16 digits `MMDDHHmmssSSSfff` (month … millisecond, then microseconds; from the database clock in `APP_TIMEZONE` = Asia/Kolkata; no year), unique, allocated under a lock.
7. Declaration must be accepted in the request. Neither the acceptance nor its text is stored today (F-10).
8. Submission is not copied anywhere until the final approval (tracking panel / approval chain, other document).

### Aadhaar

1. Exactly 12 digits, first digit 2–9, Verhoeff check digit; spaces and hyphens allowed in input.
2. Stored encrypted (AES-256-GCM, random 12-byte IV, stored `iv | tag | ciphertext`; key `STUDENT_DATA_KEY`, 32 bytes), never in the form JSON or a log.
3. Uniqueness among **submitted** forms only, by a blind index (HMAC-SHA-256, key `STUDENT_INDEX_KEY`): checked when step 1 is completed (422 at the field) and again at submission under a per-Aadhaar lock (409); a partial unique index is the last guard. Two drafts may hold the same number.
4. Returned in full only to its owner in the draft (preview). After submission only `XXXX-XXXX-<last 4>`; stored last four digits for that.

### Dates and age

Date of birth: real date, not in the future, age 14–100 (UTC). Qualification date: real, 1940 or later, not in the future (UTC; see F-16). Dates travel and are stored as `YYYY-MM-DD` text.

### Documents

One file per document code and application; replacing keeps only the newest; type by content **and** extension; 5 MB / 50 MB; only documents active now can be uploaded; mandatory active ones must be there at submission. A document switched off later keeps its uploaded file (shown and served). Files are private: served only through the API with the student's (or panel's) token. Storage keys today: `applications/<application id>/<CODE>.<ext>` → on submission `candidates/<registration id>_<First>_<Last>/<CODE>.<ext>`; SHA-256, MIME type, size and original name (≤ 255) stored.

### Suggested constraints of a new database (from the current migrations)

`accounts`: unique lower-case e-mail; unique reset-token hash. `applications`: unique account; status check; step 1–3; unique registration code and number; unique Aadhaar blind index where submitted. `files`: unique (application, code).

### Not needed by a new, empty database

- Reading old submissions from the student register (`studentId`, `legacySubmission`, `studentForm`), statuses `REGISTRATION_PENDING` / `RECEIVED` of the submitted view, and Aadhaar uniqueness against that register.
- Prefix rewriting `EDP-` → `IPP-` (`publicCode`).
- Certificate barcodes (step 3 save, `barcodes` in answers and in submit, `barcode` of a document type, `BARCODE_RE`).
- Edit-once columns (`resubmittedAt`, `editUsed`), states `EDITING` / `RESUBMITTED`.
- `taluka_id` → `taluka` conversion; taluka and centre-technology lists for students.
- Tokens without `pv`; the dummy fallback lists of `loadProgram` (`EDP_CASTE_CODES`, active rows of shared masters); names from the old register's tables; technology names from the built-in track list.
- The flat lists in `Options` listed in 6.9 as "older API" (unless another client uses them).
- The e-mailed OTP (template kept in `edp.mailer.ts`, never sent).

---

## (e) E-mail and SMS

| Message | Channel | Trigger | Content |
|---|---|---|---|
| Sign-up OTP | SMS to the account's 10-digit mobile | `/auth/register` (new, expired or changed mobile), `/auth/resend-otp`, `/auth/login` of an unverified account when a send is allowed | DLT template `SMS_OTP_MESSAGE`, placeholders `{otp}`, `{seconds}`, `{minutes}` (whole, at least 1). Default text: `Your OTP for Entrepreneurship Development Program registration is {otp}. Valid for {seconds} seconds. - Sumago Infotech` (F-3) |
| Password reset | e-mail to the account's address | `/auth/forgot-password` | below |

Nothing else is sent: no e-mail or SMS on account creation, submission, approval, rejection, correction by the Auditor, or password change.

**SMS gateway** (HappySMS style): `GET <SMS_API_URL>?authkey&mobiles=<10 digits>&message&sender&route=4&country=91&DLT_TE_ID&response=json`, timeout 10 s. Accepted when HTTP 2xx and the body says so: JSON `type` / `status` = `success` / `ok`, or text without `error|fail|invalid|insufficient|denied|not allowed|blocked|reject`; an empty body = failure. Failure → 503 `SMS_UNAVAILABLE`, the send slot is freed. Not configured: development / test log the code; elsewhere 503. `EDP_STATIC_OTP` (6 digits): no SMS, this code; honoured only when `NODE_ENV=development` **and** the portal URL is localhost. The URL (holds the key) and the full mobile are never logged.

**Password reset e-mail**: subject `Reset your password – 3 Month Internship Placement Program`. From `SMTP_FROM`, else `3 Month Internship Placement Program – Sumago Infotech <SMTP_USER>`; `Reply-To` = the support e-mail when set; header `X-Entity-Ref-ID` unique (no Gmail threading); the logo inline (cid). Text: `Dear <first name>,` · `We received a request to reset the password of your 3 Month Internship Placement Program account (Sumago Infotech Pvt. Ltd.). To set a new password, open this link:` · `<EDP_PORTAL_URL>/reset-password?token=<token>` · `This link is valid for 30 minutes and can be used once.` HTML: same with a **Reset password** button (no visible link), the note `If you did not ask to reset your password, your password has not been changed and no action is needed.`, and in the footer the support line with links, `This is an automated email from the 3 Month Internship Placement Program portal.` All values HTML-escaped. The link's host comes from configuration, never from the request. Without SMTP: development / test log the link, elsewhere 503 `EMAIL_UNAVAILABLE`.

Audit records of the current API: `edp.account.create`, `edp.account.verified`, `edp.account.password_reset_requested`, `edp.account.password_reset`, `edp.application.submitted` (registration code, number, folder, number of files; no personal data).

---

## (f) Unclear or inconsistent

**Account, OTP, password**

- F-1. README, OpenAPI and code comments say the OTP is e-mailed; it is sent by **SMS**. Names still say e-mail (`EMAIL_NOT_VERIFIED`, `email_verified`, `emailVerifiedAt`, messages "This email address is already verified"); the portal depends on the code `EMAIL_NOT_VERIFIED` and on the word patterns of 2.3.
- F-2. The OTP proves the mobile number, but the e-mail address is never proved at sign-up (only by a later reset link).
- F-3. The default SMS text names the former program ("Entrepreneurship Development Program") and `{seconds}`; `.env.example` and the comments speak of `{minutes}`. The portal's own test forbids that name on screen. The registered DLT template for this program must be supplied; the gateway URL default is plain `http`.
- F-4. A password reset of an account that never entered its OTP makes it verified: the mobile number is then never checked.
- F-5. `mobile_number` of the form is prefilled from the account but can be changed to any number (not verified, not stored back), and is stored as typed (`+91 97654 12345`), so searches and comparisons must normalise. Several accounts may share a mobile.
- F-6. Login of an unverified account whose OTP has expired answers 503 while the SMS gateway is down, so the student does not reach the OTP page that way. When a shorter resend wait is configured, a failed send also destroys the previous, still valid OTP (its hash was already replaced).
- F-17a. Login timing: the dummy hash for an unknown e-mail has bcrypt cost 4, real ones 12, so the time still tells them apart; register, resend, otp-status and forgot-password reveal registered e-mails anyway (the last on purpose), and otp-status gives the masked mobile to anyone who knows the e-mail.
- F-17b. Wrong-attempt counting reads, compares, then increments: parallel guesses can exceed 5. Count before comparing. Login has no per-account limit.
- F-17c. bcrypt uses 72 **bytes**; the rule counts 72 **characters**.

**Form, autosave, submission**

- F-7. Autosave treats every failure as "no connection" and keeps retrying the same values; a 4xx on `complete:false` blocks Save & Next and Submit. The current API can send one (value over 2000 characters, control characters, 200 keys, JSON over 100 KB, 409, 429). A new backend should be lenient there.
- F-8. If `GET /options` fails, `/application` stays at "Loading your application…" without message or retry; likewise the Help button and document list on the sign-in pages.
- F-9. The caste eligibility tick is asked of everybody, also of existing students on every new tab, is not stored, and locks out the login when the caste list is empty or cannot be loaded. Whether it must be recorded (who, when, which list) is open.
- F-10. Declaration: only `declaration_accepted: true` at the moment of submission; no record of the text version.
- F-11. Full Aadhaar is returned to the browser in the draft (needed for the preview).
- F-12. Unsaved values, including Aadhaar digits, are kept in clear in `localStorage` until saved (and after a 401 until the next login).
- F-13. A partly typed Aadhaar is answered 200 but not stored, while the page says "All changes saved"; after a reload the earlier 12-digit number (or blank) is back.
- F-14. Concurrent saves are read-modify-write of one JSON value without a lock (two tabs can overwrite each other); the page only serialises within a tab.
- F-15. After `409 ALREADY_SUBMITTED` (submitted in another tab, or the reload after submit failed) the wizard stays open. `body.declaration_accepted` is not mapped to the tick box.
- F-16. "Not in the future" is UTC on the server and local time in the browser: today's qualification date is refused between 00:00 and 05:30 IST. Date rules and the age should be decided in Asia/Kolkata.
- F-18. The student sees no approval stage, rejection or reason; status is always "Submitted". The page says "The submission is final; the form cannot be changed" and "As submitted with your registration", but the Auditor can change the form and documents, and the view then shows the changed values without notice.
- F-19. Languages: on `/application` headings, buttons, dialogs, declaration, statuses, server messages and file messages are English only; labels, choices and field checks follow the language. The submitted view shows choice texts in English (caste, religion in Marathi) whatever the language, because `text` has one language.
- F-20. The texts "PDF, JPG, JPEG or PNG … up to 5 MB" are fixed in the portal although videos and master changes exist.
- F-21. The certificate-number hint says "You will upload the certificate in step 3", but no Disability Certificate is in the document list; a program restricted to castes asks for no caste certificate. Document names contain "Aadhar Card" and "Domicile of Certificate Maharashtra".
- F-22. "Course District" (`region_id`), "Center Name" and the home district are independent: a centre of another district than the course district is accepted.
- F-23. The sign-up's middle name is not part of the form (only the account has it).
- F-24. Client and server differ: PIN, certificate, score and date texts; the e-mail pattern (client looser); qualification date lower bound (picker 1950, client none, server 1940); the date-of-birth picker minimum 1920; score without grading type (client unchecked, server ≤ 100); alternate e-mail / mobile texts. The server's wins.
- F-25. Own VIDEO documents: a file over 50 MB is answered `File is larger than 5 MB` because that middleware knows only `APPLICANT_VIDEO`.
- F-26. Upload while the page shows only one busy document: several uploads may run at once; the last answer wins on the page.
- F-27. `Content-Disposition` of the student's file holds a percent-encoded name in `filename="…"` (not RFC 5987).

**Configuration and naming**

- F-28. `support` default: without saved settings and without `EDP_SUPPORT_*`, the standard message is shown with empty placeholders ("… email ID  or mobile number ."), not "contact the programme office" as `.env.example` says.
- F-29. Ports: README and `EDP_PORTAL_URL` default say 5175, Vite serves 5176 (a reset link in local development points to the wrong port unless set).
- F-30. `/edp` in the base path, `edp.*` storage keys and the token audiences keep the former short name; confirm whether the new backend keeps them (no frontend change) or renames.
- F-31. CORS does not expose `Content-Disposition`; needed only if the API is on another origin than the portal (tracking panel downloads).
- F-32. IP limits: colleges share one address; 30 auth requests in 15 minutes for the whole address (a sign-up needs at least 2–4) and 300 in total (autosaves count) are too low for a lab. Count per account or device where possible.
- F-33. The current e2e test of `otp-status` expects no `mobile_masked`; the service returns it and the portal uses it.
- F-34. The OpenAPI text is out of date (submit "creates the registration in the student register", documents "PDF, JPG, JPEG or PNG" only).

**Open questions for the program owner**

1. Must one mobile number be limited to one account, and must the form's mobile stay the verified one? (F-5, F-4)
2. Must the eligibility tick and the declaration (text, time) be stored? (F-9, F-10)
3. Should the student see the approval stage, a rejection reason, and the Auditor's changes, or get a message about them? (F-18)
4. Which DLT template / sender is registered for this program? (F-3)
5. Disability certificate and caste certificate as documents? Centre limited to the course district? (F-21, F-22)
6. Keep the `/edp` prefix and the error-code names? (F-1, F-30)
7. Rate limits for shared networks? (F-32)
8. Is Aadhaar in full in the draft acceptable, or should the preview show it masked after the first save? (F-11, F-12)

---

## Appendix: seed data and configuration of a new database

Besides the fields (4.1) and documents (5):

| Kind | Choices (code = value, English / Marathi), in order |
|---|---|
| `RELIGION` | `हिंदू` Hindu / हिंदू |
| `GENDER` | `Male` पुरुष, `Female` स्त्री, `Transgender` तृतीयपंथी |
| `MARITAL_STATUS` | `Unmarried` अविवाहित, `Married` विवाहित |
| `EDUCATIONAL_STATUS` | `Third Year` तृतीय वर्ष, `Final Year` अंतिम वर्ष, `Completed` पूर्ण |
| `GRADING_TYPE` (fixed: rename / switch only) | `PERCENTAGE` Percentage / टक्केवारी, `CGPA` CGPA / सीजीपीए |
| `CGPA_SCALE` | `4`, `5`, `10` |
| `QUALIFICATION_CLASS` | `Distinction` विशेष प्रावीण्य, `First Class` प्रथम श्रेणी, `Higher Second Class` उच्च द्वितीय श्रेणी, `Second Class` द्वितीय श्रेणी, `Pass Class` उत्तीर्ण श्रेणी |
| `TECHNOLOGY` | `T01` Data Analytics & Business Intelligence, `T02` Graphic Design & Digital Branding, `T03` Web Design & Development, `T04` Application Development, `T05` IT Infrastructure & Smart Technologies, `T06` Retail & E-Commerce Management, `T07` Cyber Security, `T08` AI/ML Engineer, `T09` Data Scientist, `T10` Social Media Marketing / Digital Marketing, `T11` Blockchain, `T12` Office Process Automation (OPA); new ones continue `T13`… |
| `CASTE` | the program's own: `SAR01` Maratha / मराठा, `SAR02` Maratha-Kunbi / मराठा-कुणबी, `SAR03` Kunbi-Maratha / कुणबी-मराठा (rows with ids). In the current API only with `EDP_CASTE_CODES=SAR01,SAR02,SAR03` at the first seed; otherwise the list starts with every active caste (AMRUT's 26). A new program database should seed these three directly |
| `EDUCATION` | `SSC` SSC (10th), `HSC` HSC (12th), `ITI` ITI, `DIPLOMA` Diploma, `BA` B.A., `BCOM` B.Com, `BSC` B.Sc, `BCA` BCA, `BBA` BBA, `BE_BTECH` B.E. / B.Tech, `GRAD_OTHER` Other Graduate, `MA` M.A., `MCOM` M.Com, `MSC` M.Sc, `MCA` MCA, `MBA` MBA, `ME_MTECH` M.E. / M.Tech, `PG_OTHER` Other Post Graduate (rows with ids; listed A–Z by name at the first seed) |
| `REGION` (Course District) | 36 rows with ids, listed A–Z by name at the first seed: `NDB` Nandurbar, `DHU` Dhule, `JAL` Jalgaon, `BUL` Buldhana, `AKO` Akola, `AMR` Amravati, `NAG` Nagpur, `BHA` Bhandara, `GON` Gondia, `PAL` Palghar, `NAS` Nashik, `WAS` Washim, `YAV` Yavatmal, `WAR` Wardha, `CHA` Chandrapur, `GAD` Gadchiroli, `MUS` Mumbai Suburban, `THA` Thane, `CSN` Chhatrapati Sambhajinagar, `JLN` Jalna, `HIN` Hingoli, `PAR` Parbhani, `NAN` Nanded, `MUC` Mumbai City, `RAI` Raigad, `PUN` Pune, `AHL` Ahilyanagar, `BEE` Beed, `LAT` Latur, `DHA` Dharashiv, `RAT` Ratnagiri, `SAT` Satara, `SOL` Solapur, `SIN` Sindhudurg, `KOL` Kolhapur, `SAN` Sangli |
| `districts` | from the District master, active, A–Z (no seed in this code) |
| `centres` | from the Center Master, active (no seed) |

Names: case-insensitively unique per list; a list without entries makes its required dropdown impossible to fill. Longest names: caste 80, education / region 150, religion 60, gender / marital status 20, educational status 100, grading type / CGPA scale 60, class 40, technology 120, own choices 100.

Default `support.message`: `If you have any query related to your registration, you can contact us on email ID {email} or mobile number {mobile}.`; `email` / `mobile` = `EDP_SUPPORT_EMAIL` / `EDP_SUPPORT_MOBILE` or null. Default `welcome`: enabled, `Congratulations! Your account is created`, `Your mobile number is verified and your 3 Month Internship Placement Program account is ready. Fill in the form in three steps, upload your documents and submit it — you can see your application any time.`, button label blank. Default `help`: enabled, `Need help?`, `For any query about your registration, you can contact the programme office.`, fields `Contact Number` / `Email ID` from the two variables (those set). Reading settings never fails: on a database error the defaults are used.

Configuration the student part needs: portal URL (reset link), allowed origins, JWT key, session hours, OTP lifetime / resend wait, IP limits, SMS gateway (URL, key, sender, DLT template id, route, country, message), SMTP (host, port, secure, user, password, from), support contact, `APP_TIMEZONE`, Aadhaar data key and index key, file storage (local folder or private S3 bucket, SSE), bcrypt cost, local static OTP.
