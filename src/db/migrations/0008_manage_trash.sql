-- Hide records from the management list without changing student access, applications or approvals.
ALTER TABLE student_accounts ADD COLUMN manage_deleted_at timestamptz;
CREATE INDEX idx_student_accounts_manage_trash ON student_accounts (manage_deleted_at DESC) WHERE manage_deleted_at IS NOT NULL AND deleted_at IS NULL;
