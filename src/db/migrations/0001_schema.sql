-- 3 Month Internship Placement Program: the whole schema of the portal (student form, Auditor panel, masters, batches).
--
-- Conventions: uuid keys; every time is timestamptz; deleted_at = soft delete (a deleted row is inactive as well); what must
-- never be changed (approval events, the Auditor's edits, the audit log) is append-only.

-- ---------------------------------------------------------------------------------------------------------------- helpers

-- A text as a uuid; NULL when it is not one. A draft's form may hold anything.
CREATE FUNCTION uuid_or_null(v text) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN v::uuid END
$$;

-- A number with leading zeros, at least `width` digits (longer numbers are kept whole).
CREATE FUNCTION padded(n bigint, width int) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lpad(n::text, greatest(width, length(n::text)), '0')
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

-- ----------------------------------------------------------------------------------------------------------------- people

-- A student's sign-in. Usable once the OTP sent to the mobile number is verified (verified_at).
CREATE TABLE student_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name          varchar(100) NOT NULL,
  middle_name         varchar(100),
  last_name           varchar(100) NOT NULL,
  full_name           text GENERATED ALWAYS AS (first_name || coalesce(' ' || middle_name, '') || ' ' || last_name) STORED,
  email               varchar(254) NOT NULL CHECK (email = lower(email)),
  mobile              varchar(10) NOT NULL CHECK (mobile ~ '^[6-9][0-9]{9}$'),
  password_hash       varchar(255) NOT NULL,
  verified_at         timestamptz,
  -- HMAC of the pending one-time code; NULL when none is pending.
  otp_hash            char(64),
  otp_expires_at      timestamptz,
  otp_sent_at         timestamptz,
  otp_attempts        integer NOT NULL DEFAULT 0,
  -- Codes sent since otp_window_start (an hour), for the limit per account.
  otp_send_count      integer NOT NULL DEFAULT 0,
  otp_window_start    timestamptz,
  -- HMAC of the pending password reset link's token.
  reset_token_hash    char(64),
  reset_expires_at    timestamptz,
  reset_sent_at       timestamptz,
  reset_send_count    integer NOT NULL DEFAULT 0,
  reset_window_start  timestamptz,
  -- Sessions from before the password was last changed are refused.
  password_changed_at timestamptz,
  -- Wrong passwords since failed_window_start, for the limit per account.
  failed_logins       integer NOT NULL DEFAULT 0,
  failed_window_start timestamptz,
  last_login_at       timestamptz,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX uq_student_accounts_email ON student_accounts (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_student_accounts_reset ON student_accounts (reset_token_hash) WHERE reset_token_hash IS NOT NULL;
CREATE INDEX ix_student_accounts_created ON student_accounts (created_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX ix_student_accounts_mobile ON student_accounts (mobile);

-- A sign-in of the Auditor panel: ADMIN (the Auditor, may do everything) or VIEWER (views and downloads).
CREATE TABLE panel_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                varchar(150) NOT NULL,
  email               varchar(254) NOT NULL CHECK (email = lower(email)),
  password_hash       varchar(255) NOT NULL,
  role                varchar(10) NOT NULL CHECK (role IN ('ADMIN', 'VIEWER')),
  password_changed_at timestamptz,
  failed_logins       integer NOT NULL DEFAULT 0,
  failed_window_start timestamptz,
  last_login_at       timestamptz,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX uq_panel_users_email ON panel_users (email) WHERE deleted_at IS NULL;

-- --------------------------------------------------------------------------------------------------------------- settings

-- Keys: batch, support, welcome, help (and program.* for the officers' stages, later). Missing = the defaults of the code.
CREATE TABLE settings (
  key        varchar(60) PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES panel_users (id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------------------------------------------- masters

CREATE TABLE states (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       varchar(100) NOT NULL,
  code       varchar(10) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9]{1,9}$'),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active)
);
CREATE UNIQUE INDEX uq_states_name ON states (lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_states_code ON states (code) WHERE deleted_at IS NULL;

CREATE TABLE districts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id   uuid NOT NULL REFERENCES states (id) ON DELETE RESTRICT,
  name       varchar(100) NOT NULL,
  code       varchar(20) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9-]{1,19}$'),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active)
);
CREATE UNIQUE INDEX uq_districts_name ON districts (state_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_districts_code ON districts (state_id, code) WHERE deleted_at IS NULL;

CREATE TABLE talukas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
  name        varchar(100) NOT NULL,
  code        varchar(20) CHECK (code ~ '^[A-Z][A-Z0-9-]{1,19}$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active)
);
CREATE UNIQUE INDEX uq_talukas_name ON talukas (district_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_talukas_code ON talukas (district_id, code) WHERE deleted_at IS NULL AND code IS NOT NULL;

-- Center Master: the centers a student chooses from and a batch is placed at.
CREATE TABLE centres (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id    uuid NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
  taluka_id      uuid REFERENCES talukas (id) ON DELETE RESTRICT,
  name           varchar(150) NOT NULL,
  code           varchar(20) NOT NULL,
  address        varchar(300),
  pin_code       varchar(6) CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  contact_person varchar(120),
  contact_number varchar(15),
  email          varchar(254),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active)
);
CREATE UNIQUE INDEX uq_centres_code ON centres (upper(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_centres_name ON centres (district_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_centres_taluka ON centres (taluka_id);

-- The choices of every dropdown of the form ("kind"; FIELD:<key> = those of an own dropdown field). A form stores the
-- choice's id for CASTE, EDUCATION and REGION, and its code for every other kind: a rename never changes a stored value.
CREATE TABLE program_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          varchar(60) NOT NULL,
  code          varchar(120) NOT NULL,
  name_en       varchar(150) NOT NULL,
  name_mr       varchar(150),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 9999),
  is_system     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active),
  CHECK (NOT (is_system AND deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_program_options_code ON program_options (kind, lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_program_options_name ON program_options (kind, lower(name_en)) WHERE deleted_at IS NULL;
CREATE INDEX ix_program_options_kind ON program_options (kind, display_order);

-- The technologies offered in a district; none = every active one.
CREATE TABLE district_technologies (
  district_id uuid NOT NULL REFERENCES districts (id) ON DELETE CASCADE,
  option_id   uuid NOT NULL REFERENCES program_options (id) ON DELETE CASCADE,
  PRIMARY KEY (district_id, option_id)
);
CREATE INDEX ix_district_technologies_option ON district_technologies (option_id);

-- The documents of step 3. The code is the file's name for ever.
CREATE TABLE program_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          varchar(40) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name_en       varchar(150) NOT NULL,
  name_mr       varchar(150),
  kind          varchar(10) NOT NULL DEFAULT 'DOCUMENT' CHECK (kind IN ('DOCUMENT', 'VIDEO')),
  required      boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 9999),
  is_system     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active),
  CHECK (NOT (is_system AND deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_program_documents_name ON program_documents (lower(name_en)) WHERE deleted_at IS NULL;

-- The fields of steps 1 and 2: the program's own (a fixed key, step and type) and the ones the Auditor adds (x_…).
CREATE TABLE program_fields (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           varchar(60) NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  step          smallint NOT NULL CHECK (step IN (1, 2)),
  type          varchar(10) NOT NULL CHECK (type IN ('TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'DROPDOWN')),
  label_en      varchar(150) NOT NULL,
  label_mr      varchar(150),
  help_en       varchar(300),
  help_mr       varchar(300),
  required      boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 9999),
  is_core       boolean NOT NULL DEFAULT false,
  is_custom     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active),
  CHECK (is_custom = (key LIKE 'x\_%')),
  CHECK (NOT is_core OR (required AND is_active AND deleted_at IS NULL AND NOT is_custom)),
  CHECK (deleted_at IS NULL OR is_custom)
);

-- ---------------------------------------------------------------------------------------------------------------- batches

CREATE SEQUENCE batch_code_seq;

-- A group of students (exactly the batch size, one district) at a center; its students are fixed once it is made.
CREATE TABLE batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          varchar(20) NOT NULL UNIQUE DEFAULT 'IPP-B-' || padded(nextval('batch_code_seq'), 4),
  name          varchar(120) NOT NULL,
  district_id   uuid NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
  centre_id     uuid NOT NULL REFERENCES centres (id) ON DELETE RESTRICT,
  size          smallint NOT NULL CHECK (size BETWEEN 1 AND 100),
  start_date    date,
  end_date      date,
  delivery_mode varchar(10) NOT NULL DEFAULT 'OFFLINE' CHECK (delivery_mode IN ('OFFLINE', 'ONLINE', 'BLENDED')),
  -- A choice of kind TECHNOLOGY.
  technology_id uuid REFERENCES program_options (id) ON DELETE RESTRICT,
  created_by    uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date > start_date)
);
CREATE UNIQUE INDEX uq_batches_name ON batches (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_batches_district ON batches (district_id);
CREATE INDEX ix_batches_centre ON batches (centre_id);

-- ----------------------------------------------------------------------------------------------------------- applications

CREATE SEQUENCE registration_seq;

-- A student's form: a draft that is filled step by step, submitted once, then approved stage by stage.
CREATE TABLE applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL UNIQUE REFERENCES student_accounts (id) ON DELETE RESTRICT,
  status                varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED')),
  current_step          smallint NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 3),
  -- The form's values by field key, as text. Never the Aadhaar number.
  data                  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND NOT (data ? 'aadhaar_number')),
  -- AES-256-GCM: iv | tag | ciphertext.
  aadhaar_enc           bytea,
  -- Set at submission: the blind index (one submitted form per Aadhaar) and the last four digits (for the masked number).
  aadhaar_index         char(64),
  aadhaar_last4         char(4),
  -- Of the form's District, Caste and Center Name, for the lists' filters (they follow `data` by themselves).
  district_id           uuid GENERATED ALWAYS AS (uuid_or_null(data ->> 'district_id')) STORED,
  caste_id              uuid GENERATED ALWAYS AS (uuid_or_null(data ->> 'caste_id')) STORED,
  centre_id             uuid GENERATED ALWAYS AS (uuid_or_null(data ->> 'centre_id')) STORED,
  basic_completed_at    timestamptz,
  main_completed_at     timestamptz,
  declared_at           timestamptz,
  submitted_at          timestamptz,
  registration_code     varchar(20) UNIQUE,
  registration_number   varchar(16) UNIQUE,
  -- The student's own last change.
  student_active_at     timestamptz NOT NULL DEFAULT now(),
  -- Every uploaded document is verified (document_checks).
  documents_verified_at timestamptz,
  documents_verified_by uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  -- The Auditor's latest approval; NULL again when the form is sent back to the Auditor.
  approved_at           timestamptz,
  approved_by           uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  -- NULL = with the Auditor; BATCH = approved, waiting for a batch; then the officers' stages; APPROVED = final.
  approval_stage        varchar(12) CHECK (approval_stage IN ('BATCH', 'DIVISION', 'COEP', 'HEAD_OFFICE', 'ADMIN', 'APPROVED')),
  stage_updated_at      timestamptz,
  -- Kept when the student is sent back, until the end.
  batch_id              uuid REFERENCES batches (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT ck_applications_submitted CHECK (
    status = 'DRAFT' OR (submitted_at IS NOT NULL AND declared_at IS NOT NULL AND registration_code IS NOT NULL
                         AND basic_completed_at IS NOT NULL AND main_completed_at IS NOT NULL
                         AND aadhaar_enc IS NOT NULL AND aadhaar_index IS NOT NULL AND aadhaar_last4 IS NOT NULL)),
  CONSTRAINT ck_applications_draft CHECK (
    status = 'SUBMITTED' OR (submitted_at IS NULL AND registration_code IS NULL AND approval_stage IS NULL AND batch_id IS NULL)),
  CONSTRAINT ck_applications_waiting CHECK (approval_stage IS DISTINCT FROM 'BATCH' OR batch_id IS NULL),
  CONSTRAINT ck_applications_in_batch CHECK (
    approval_stage IS NULL OR approval_stage = 'BATCH' OR batch_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_applications_aadhaar ON applications (aadhaar_index) WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
CREATE INDEX ix_applications_stage ON applications (approval_stage) WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
CREATE INDEX ix_applications_batch ON applications (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX ix_applications_district ON applications (district_id);
CREATE INDEX ix_applications_caste ON applications (caste_id);
CREATE INDEX ix_applications_centre ON applications (centre_id);

-- The uploaded documents: one file per document; a replacement takes the place of the one before.
CREATE TABLE application_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  document_code  varchar(40) NOT NULL REFERENCES program_documents (code) ON DELETE RESTRICT,
  storage_key    varchar(500) NOT NULL UNIQUE,
  original_name  varchar(255) NOT NULL,
  mime_type      varchar(100) NOT NULL,
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  sha256         char(64) NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, document_code)
);

-- The Auditor's check of each uploaded document; gone as soon as its file is replaced or removed.
CREATE TABLE document_checks (
  application_id uuid NOT NULL,
  document_code  varchar(40) NOT NULL,
  verified_at    timestamptz NOT NULL DEFAULT now(),
  verified_by    uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  PRIMARY KEY (application_id, document_code),
  FOREIGN KEY (application_id, document_code) REFERENCES application_files (application_id, document_code) ON DELETE CASCADE
);

-- Every move between stages: who, when, and a rejection's reason. Append-only; seq is the order.
CREATE TABLE approval_events (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE RESTRICT,
  action         varchar(10) NOT NULL CHECK (action IN ('APPROVE', 'REJECT')),
  from_stage     varchar(12) NOT NULL CHECK (from_stage IN ('AUDITOR', 'BATCH', 'DIVISION', 'COEP', 'HEAD_OFFICE', 'ADMIN')),
  to_stage       varchar(12) NOT NULL CHECK (to_stage IN ('AUDITOR', 'BATCH', 'DIVISION', 'COEP', 'HEAD_OFFICE', 'ADMIN', 'APPROVED')),
  reason         varchar(500),
  actor_kind     varchar(10) NOT NULL CHECK (actor_kind IN ('PANEL', 'OFFICER', 'SYSTEM')),
  panel_user_id  uuid REFERENCES panel_users (id) ON DELETE RESTRICT,
  actor_name     varchar(150),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (action = 'APPROVE' OR length(btrim(reason)) >= 3),
  CHECK (actor_kind <> 'PANEL' OR panel_user_id IS NOT NULL)
);
CREATE INDEX ix_approval_events_application ON approval_events (application_id, seq DESC);
CREATE TRIGGER approval_events_append_only BEFORE UPDATE OR DELETE ON approval_events FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- What the Auditor changed on a submitted form: [{ key, label, from, to }]. Append-only.
CREATE TABLE application_edits (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE RESTRICT,
  changes        jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  panel_user_id  uuid REFERENCES panel_users (id) ON DELETE RESTRICT,
  actor_name     varchar(150),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_application_edits_application ON application_edits (application_id, seq DESC);
CREATE TRIGGER application_edits_append_only BEFORE UPDATE OR DELETE ON application_edits FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- The calls made to a student; the newest is the current follow-up status.
CREATE TABLE follow_ups (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES student_accounts (id) ON DELETE RESTRICT,
  status        varchar(20) NOT NULL CHECK (status IN ('PENDING', 'CALLED', 'SECOND_CALL', 'FORM_FILLED')),
  note          varchar(1000),
  panel_user_id uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_follow_ups_account ON follow_ups (account_id, seq DESC);

-- ------------------------------------------------------------------------------------------------------------------ audit

-- Who did what. Never personal data, passwords, codes or file contents. Append-only.
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action      varchar(80) NOT NULL,
  resource    varchar(60) NOT NULL,
  resource_id varchar(120),
  actor_kind  varchar(10) NOT NULL CHECK (actor_kind IN ('STUDENT', 'PANEL', 'OFFICER', 'SYSTEM')),
  actor_id    uuid,
  details     jsonb,
  ip          varchar(64),
  user_agent  varchar(300),
  request_id  varchar(64),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX ix_audit_logs_resource ON audit_logs (resource, resource_id);
CREATE INDEX ix_audit_logs_actor ON audit_logs (actor_id);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ------------------------------------------------------------------------------------------------------------- updated_at

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['student_accounts', 'panel_users', 'states', 'districts', 'talukas', 'centres', 'program_options',
                           'program_documents', 'program_fields', 'batches', 'applications']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
  END LOOP;
END $$;
