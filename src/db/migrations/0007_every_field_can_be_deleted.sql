-- Every field can be deleted in Masters → Form fields, also one the program comes with, and brought back. A deleted field
-- of the program is kept as a switched-off one (its answers stay stored and shown); only "deleted" keeps it out of the list.
-- The rule of 0001 that let only own fields be deleted goes (found by what it says: it was given no name of its own).
DO $$
DECLARE
  rule text;
BEGIN
  FOR rule IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'program_fields'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) = 'CHECK (((deleted_at IS NULL) OR is_custom))'
  LOOP
    EXECUTE format('ALTER TABLE program_fields DROP CONSTRAINT %I', rule);
  END LOOP;
END $$;
