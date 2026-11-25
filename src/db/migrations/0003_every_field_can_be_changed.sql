-- No field of the form is fixed any more: each one can be switched off, made optional, moved to the other step, and given
-- another type and checks. is_core is not read any more; it stays, so that a server still running the code from before this
-- keeps working while the new one is started.
UPDATE program_fields SET is_core = false WHERE is_core;
COMMENT ON COLUMN program_fields.is_core IS 'Not used since migration 0003: no field is fixed.';

ALTER TABLE program_fields DROP CONSTRAINT ck_program_fields_type, DROP CONSTRAINT ck_program_fields_validation;
ALTER TABLE program_fields
  ADD CONSTRAINT ck_program_fields_type CHECK (
    type IN ('TEXT', 'TEXTAREA', 'EMAIL', 'MOBILE', 'URL', 'NUMBER', 'DATE', 'TIME', 'MONTH', 'YEAR', 'DROPDOWN', 'RADIO',
             'CHECKBOXES', 'YES_NO', 'CONSENT')),
  ADD CONSTRAINT ck_program_fields_validation CHECK (validation IS NULL OR jsonb_typeof(validation) = 'object');

-- The Aadhaar number may be switched off or optional: a submitted form has all of it (number, index, last digits) or none.
ALTER TABLE applications DROP CONSTRAINT ck_applications_submitted;
ALTER TABLE applications ADD CONSTRAINT ck_applications_submitted CHECK (
  status = 'DRAFT' OR (submitted_at IS NOT NULL AND declared_at IS NOT NULL AND registration_code IS NOT NULL
                       AND basic_completed_at IS NOT NULL AND main_completed_at IS NOT NULL
                       AND num_nulls(aadhaar_enc, aadhaar_index, aadhaar_last4) IN (0, 3)));
