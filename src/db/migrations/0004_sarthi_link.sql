-- The officers' approval in Sarthi (docs/SARTHI_LINK.md): batches of a size per district, the messages to Sarthi and the
-- decisions that come back. Only additions: a server still running the code from before this keeps working.

-- How many students a batch of this district has; NULL = the default (settings, "batch").
ALTER TABLE districts ADD COLUMN batch_size smallint CONSTRAINT ck_districts_batch_size CHECK (batch_size BETWEEN 1 AND 100);

-- Messages to Sarthi, saved with the change they tell of and sent by the worker: in the order of seq within a batch, whose row is
-- locked while one is added. BATCH = a new batch with its students; BATCH_UPDATE = the batch itself; RESUBMIT = a student who was
-- sent back and is approved again; UPDATE = a corrected form. What a message says is read when it is sent.
CREATE TABLE link_outbox (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  kind            varchar(12) NOT NULL CHECK (kind IN ('BATCH', 'BATCH_UPDATE', 'RESUBMIT', 'UPDATE')),
  batch_id        uuid NOT NULL REFERENCES batches (id) ON DELETE RESTRICT,
  application_id  uuid REFERENCES applications (id) ON DELETE RESTRICT,
  status          varchar(8) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Why it is not sent; never a value of a form.
  last_error      varchar(300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CHECK ((kind IN ('RESUBMIT', 'UPDATE')) = (application_id IS NOT NULL)),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX ix_link_outbox_waiting ON link_outbox (batch_id, seq) WHERE status <> 'SENT';
CREATE INDEX ix_link_outbox_batch ON link_outbox (batch_id, seq DESC);

-- The decisions of Sarthi that are done: the same id again changes nothing.
CREATE TABLE link_inbound (
  id             uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE RESTRICT,
  action         varchar(8) NOT NULL CHECK (action IN ('APPROVE', 'REJECT', 'MOVE')),
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_link_inbound_received ON link_inbound (received_at DESC);

-- MOVE = the students waiting for the final decision change hands (Head Office approval switched on or off in Sarthi).
-- actor_role = the officer's role, as Sarthi names it.
ALTER TABLE approval_events ADD COLUMN actor_role varchar(60);
ALTER TABLE approval_events DROP CONSTRAINT approval_events_action_check, DROP CONSTRAINT approval_events_check;
ALTER TABLE approval_events
  ADD CONSTRAINT ck_approval_events_action CHECK (action IN ('APPROVE', 'REJECT', 'MOVE')),
  ADD CONSTRAINT ck_approval_events_reason CHECK (action <> 'REJECT' OR length(btrim(reason)) >= 3);

-- Batches made before the link are sent too: their students with the Divisional Officer.
INSERT INTO link_outbox (kind, batch_id)
SELECT 'BATCH', b.id FROM batches b
WHERE b.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM applications p WHERE p.batch_id = b.id AND p.deleted_at IS NULL AND p.approval_stage IS NOT NULL)
ORDER BY b.created_at, b.id;
