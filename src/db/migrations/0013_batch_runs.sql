-- A batch is started, then ended, by the Auditor: started once every student of it is finally approved, at the date and time
-- the Auditor gives (after confirming their e-mail and password), ended the same way. batches keeps where it is now (not
-- started, ongoing, ended); batch_runs keeps every start and end, who gave it and when it was recorded (append-only).
ALTER TABLE batches
  ADD COLUMN started_at timestamptz,
  ADD COLUMN started_by uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  ADD COLUMN ended_at   timestamptz,
  ADD COLUMN ended_by   uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  ADD CONSTRAINT ck_batches_run CHECK (ended_at IS NULL OR (started_at IS NOT NULL AND ended_at >= started_at));

CREATE TABLE batch_runs (
  seq           bigserial PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES batches (id) ON DELETE RESTRICT,
  action        varchar(5) NOT NULL CHECK (action IN ('START', 'END')),
  -- The date and time the batch started or ended, as the Auditor gave it.
  at            timestamptz NOT NULL,
  panel_user_id uuid REFERENCES panel_users (id) ON DELETE SET NULL,
  actor_name    varchar(200) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_batch_runs_batch ON batch_runs (batch_id, seq);
CREATE TRIGGER batch_runs_append_only BEFORE UPDATE OR DELETE ON batch_runs FOR EACH ROW EXECUTE FUNCTION refuse_change();
