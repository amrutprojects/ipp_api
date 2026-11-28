# IPP ↔ Sarthi: the approval of student forms (contract)

IPP (this API and its Auditor panel) and Sarthi (`sarthi-api`, `sarthi-admin`) are two projects with their own databases. The Auditor
approves forms and makes batches in IPP; the officers (Divisional Officer → COEP → Head Office, or the Super Admin) decide in Sarthi.

```
IPP Auditor ──batch──▶ DIVISION (Divisional Officer) ──▶ COEP ──▶ HEAD_OFFICE, or SUPER_ADMIN while Head Office is off ──▶ APPROVED
            ◀─reject── DIVISION ◀───────────reject────── COEP ◀──reject── HEAD_OFFICE / SUPER_ADMIN
```

- A rejection needs a reason (3–500 characters), concerns one student and goes back **one** level; the officer there decides again (approves,
  or rejects one level further). It never holds up the other students of the batch.
- A second approval needs a reason too (3–500 characters), at every level: when the level approving it decided the form before (the
  Auditor approved it and it was rejected back, or returned it to the candidate; an officer approved or rejected it before and it came
  back). A first approval asks for none. Approving several students together keeps the one reason for each. Every reason is shown in
  the student's approval history on both sides (never in the audit logs: it is free text).
- A student sent back to the Auditor stays in the batch; after the correction the Auditor approves the form again and it goes to DIVISION.
- A batch is of one district and goes to the Divisional Officers that district is assigned to in Sarthi (an officer has one or more districts).
  Its size is set in IPP: a default (30) and, where needed, one per district.
- Head Office on: Head Office makes the final decision, the Super Admin only reads. Off: the Super Admin makes it, Head Office only reads.
  Switching it moves the students waiting for the final decision (`MOVE`).
- IPP is the source of the form, the documents and their corrections; Sarthi is the source of the officers' decisions. The Aadhaar number never
  leaves IPP (only `XXXX-XXXX-1234`). Documents are not copied: Sarthi fetches one when an officer opens it.

## 1. Every call

Both sides hold one shared secret (at least 32 characters). JSON (UTF-8) over HTTPS.

| Header | |
|---|---|
| `Authorization` | `IPP-SARTHI <client>:<signature>`; client = `ipp` (IPP calls Sarthi) or `sarthi` (Sarthi calls IPP) |
| `X-Timestamp` | Unix time in seconds; at most 300 s from the receiver's clock |

`signature` = lower-case hex HMAC-SHA256 (shared secret) of these five lines joined with `\n`:

```
<client>
<METHOD>
<path with query, as sent, e.g. /integration/v1/ipp/messages>
<X-Timestamp>
<lower-case hex SHA-256 of the raw body; of an empty string when there is none>
```

Compared in constant time. The client is part of the signed text, so a message cannot be sent back to its sender. Every write has an id and is
done once, so a repeated or replayed call changes nothing. Anything wrong with the signature → 401 `LINK_UNAUTHORIZED`. Link not configured → 503
`LINK_NOT_CONFIGURED`. Answers have the usual envelope (`{ success, status, message, data, error: { code, … } }`).

## 2. IPP → Sarthi

### `POST /integration/v1/ipp/messages` (body up to 5 MB)

```ts
{
  id: string;          // uuid; the same id again → 200, data.duplicate = true, nothing changes
  seq: number;         // increases with every message of IPP; an older snapshot never replaces a newer one
  sent_at: string;     // ISO
  batch: {             // always in full: inserted or updated
    id: string; code: string /* IPP-B-0001 */; name: string; size: number;
    district: { code: string; name: string; state_code: string };
    centre: { code: string; name: string };
    start_date: string | null; end_date: string | null;          // YYYY-MM-DD
    delivery_mode: 'OFFLINE' | 'ONLINE' | 'BLENDED';
    technology: { code: string; name: string } | null;
    created_at: string; created_by: string | null;
    // Where the batch is: the Auditor starts it once every student of it is final approved, then ends it (each at the date
    // and time they give, confirmed with their e-mail and password). Sent with BATCH_UPDATE each time. A receiver that
    // predates these fields ignores them.
    status: 'NOT_STARTED' | 'ONGOING' | 'ENDED';
    started_at: string | null; ended_at: string | null;           // ISO
  };
  applications: {      // 0–100
    action: 'SUBMIT' | 'RESUBMIT' | 'UPDATE';
    id: string;        // uuid of the IPP application
    registration_id: string /* IPP-000001 */; registration_number: string | null;
    name: string; email: string; mobile_number: string; aadhaar_masked: string | null;
    district: string | null; category: string | null; centre: string | null; technology: string | null;   // of the form, as read
    submitted_at: string; auditor_approved_at: string | null; auditor_approved_by: string | null;
    auditor_approval_reason: string | null;   // why the Auditor approved it (latest approval); null for a first approval
    fields: { key: string; step: 1 | 2; label_en: string; label_mr: string; type: string; text: string }[];
    documents: {
      code: string; name: string; name_mr: string | null; required: boolean; kind: 'DOCUMENT' | 'VIDEO';
      file: { name: string; mime: string; size: number; uploaded_at: string } | null;
      verified: boolean; verified_at: string | null; verified_by: string | null;
    }[];
    edits: { at: string; by: string | null; changes: { key: string; label: string; from: string; to: string }[] }[];  // newest first, at most 50
  }[];
}
```

| action | Sarthi |
|---|---|
| `SUBMIT` | unknown → added at DIVISION (event `RECEIVED`); known in this batch → as `UPDATE`; in another batch → 409 `APPLICATION_IN_OTHER_BATCH` |
| `RESUBMIT` | with the Auditor → DIVISION (event `RESUBMITTED`); unknown → as `SUBMIT`; anywhere else → 409 `STAGE_MISMATCH` |
| `UPDATE` | the snapshot is replaced, the stage stays (event `CORRECTED`); unknown → 409 `APPLICATION_UNKNOWN` |

`fields[].text` is what people read: names of choices, the Aadhaar number masked, a score as `72.5%` or `8.2 / 10`; dates stay `YYYY-MM-DD`
(`type` DATE) and months `YYYY-MM` (`type` MONTH); '' = not answered. Fields that do not apply to the student are left out. A `BATCH` message holds
the students with the Divisional Officer when it is sent (after it was made: all of them). One message is done as a whole or not at all. 200 → `data: { id, duplicate, applications: { id, stage }[] }`. Other errors: 409 `DISTRICT_UNKNOWN`
(not in Sarthi's District Master; matched by code, then name), 422 (malformed).

### `GET /integration/v1/ipp/ping` → `data: { ok: true, time }`

## 3. Sarthi → IPP (`/api/v1/link/…`)

### `POST /api/v1/link/decisions` (1–100 per call, handled in the order given, each on its own)

```ts
{
  decisions: {
    id: string;              // uuid; the same id again → ok, duplicate = true
    application_id: string;
    action: 'APPROVE' | 'REJECT' | 'MOVE';
    from: 'DIVISION' | 'COEP' | 'HEAD_OFFICE' | 'SUPER_ADMIN';
    to: 'AUDITOR' | 'DIVISION' | 'COEP' | 'HEAD_OFFICE' | 'SUPER_ADMIN' | 'APPROVED';
    reason: string | null;   // REJECT: 3–500 characters; APPROVE: 3–500 characters for a second approval, else null; MOVE: null
    by: { name: string; role: string };
    at: string;              // ISO, when the officer decided
  }[];
}
```

Moves: APPROVE `DIVISION→COEP`, `COEP→HEAD_OFFICE|SUPER_ADMIN`, `HEAD_OFFICE→APPROVED`, `SUPER_ADMIN→APPROVED`; REJECT `DIVISION→AUDITOR`,
`COEP→DIVISION`, `HEAD_OFFICE→COEP`, `SUPER_ADMIN→COEP`; MOVE `HEAD_OFFICE→SUPER_ADMIN`, `SUPER_ADMIN→HEAD_OFFICE` (the switch).

200 → `data: { results: ({ id, ok: true, duplicate: boolean } | { id, ok: false, code: 'APPLICATION_UNKNOWN' | 'STAGE_MISMATCH' | 'INVALID_MOVE', message, stage: string | null })[] }`.
422 = the call itself is malformed (nothing is done).

### `GET /api/v1/link/applications/:id/documents/:code` → the file (its own content type, `Content-Length`); only of a form in a batch; else 404

### `GET /api/v1/link/ping` → `data: { ok: true, time }`

## 4. Sending, on both sides

IPP sends a message for: a new batch (`SUBMIT` of its students), a changed batch (no applications), a student approved again after being sent back
(`RESUBMIT`), and a corrected form, replaced document or changed document check of a student who is in a batch and not finally approved (`UPDATE`,
also while the form is back with the Auditor). Messages of one batch arrive in the order of `seq`.

A change and its message are saved in the same transaction (outbox). A worker sends them: first come, first served per batch (IPP) or per
application (Sarthi); a message waits while an earlier one of the same batch / application is not sent. Not reachable, 401, 408, 429, 5xx → tried
again after 30 s, 1, 2, 5, 10, 30 min, then every hour. Any other 4xx, or a decision answered `ok: false` → FAILED: shown in the panel with its
reason, tried again when somebody chooses Retry. Link off or not configured → messages wait. Errors never hold form values or the secret.

## 5. Settings

| IPP (`ipp_backend/.env`) | Sarthi (`sarthi-api/.env`) | |
|---|---|---|
| `SARTHI_LINK_ENABLED=true` | `IPP_LINK_ENABLED=true` | off by default |
| `SARTHI_API_URL=https://…` (no path) | `IPP_API_URL=https://ippapi.sumago.ai/api/v1` | where the other side answers |
| `SARTHI_LINK_SECRET` | `IPP_LINK_SECRET` | the same value, ≥ 32 characters |
| `SARTHI_HTTP_TIMEOUT_MS` (15000) | `IPP_HTTP_TIMEOUT_MS` (15000) | |
