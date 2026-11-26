-- Retain document codes and file references when built-in documents are removed.
DO $$
DECLARE
  rule text;
  matches integer := 0;
BEGIN
  FOR rule IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'program_documents'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%is_system%'
      AND pg_get_constraintdef(oid) ILIKE '%deleted_at%'
  LOOP
    matches := matches + 1;
    EXECUTE format('ALTER TABLE program_documents DROP CONSTRAINT %I', rule);
  END LOOP;
  IF matches <> 1 THEN
    RAISE EXCEPTION 'Expected one system-document deletion constraint, found %', matches;
  END IF;
END $$;
