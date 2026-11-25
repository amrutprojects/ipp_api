-- Own fields: more types (CHECKBOXES stores a JSON list of the chosen values), and the checks an ADMIN gives to one:
-- { "rules": [{ "type": …, "value"?: … }], "custom": [{ "kind": "REGEX" | "JS", "source": …, … }] }; NULL = none.
ALTER TABLE program_fields DROP CONSTRAINT program_fields_type_check;
ALTER TABLE program_fields
  ADD CONSTRAINT ck_program_fields_type CHECK (
    type IN ('TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'DROPDOWN')
    OR (is_custom AND type IN ('EMAIL', 'MOBILE', 'URL', 'TIME', 'MONTH', 'YEAR', 'RADIO', 'CHECKBOXES', 'YES_NO', 'CONSENT'))),
  ADD COLUMN validation jsonb,
  ADD CONSTRAINT ck_program_fields_validation CHECK (validation IS NULL OR (is_custom AND jsonb_typeof(validation) = 'object'));

-- The values a stored answer stands for: the ones of a JSON list, else the answer itself.
CREATE FUNCTION chosen_values(v text) RETURNS SETOF text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF left(v, 1) = '[' THEN
    BEGIN
      RETURN QUERY SELECT jsonb_array_elements_text(v::jsonb);
      RETURN;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;
  RETURN NEXT v;
END $$;
