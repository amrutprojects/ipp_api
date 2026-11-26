-- The Auditor sends a submitted form back to the candidate to correct (only while the setting "Enable Rejection Email
-- Notification and Resubmission" is on, settings key "rejection"): the reason, who did it, whether the e-mail to the candidate
-- went out, and when the candidate saved the corrected form, which sends it back to the Auditor (resubmitted_at). While a
-- return is open the form stays SUBMITTED (registration ID, number and documents are kept) and is with the candidate, not the
-- Auditor. History: a row is never deleted; only its e-mail outcome and resubmitted_at are set, once each.
CREATE TABLE application_returns (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE RESTRICT,
  reason         varchar(500) NOT NULL CHECK (length(btrim(reason)) >= 3),
  panel_user_id  uuid NOT NULL REFERENCES panel_users (id) ON DELETE RESTRICT,
  actor_name     varchar(150) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- PENDING until the e-mail is tried; NOT_SENT = no mail server (development only: logged instead).
  email_status   varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (email_status IN ('PENDING', 'SENT', 'FAILED', 'NOT_SENT')),
  email_at       timestamptz,
  resubmitted_at timestamptz
);
-- At most one open return per form.
CREATE UNIQUE INDEX uq_application_returns_open ON application_returns (application_id) WHERE resubmitted_at IS NULL;
CREATE INDEX ix_application_returns_application ON application_returns (application_id, seq DESC);
