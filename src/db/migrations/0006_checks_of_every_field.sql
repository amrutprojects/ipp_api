-- The program's own fields lose the checks written in the code: from now on everything a field is checked by beyond its
-- type is in Masters → Form fields, where it can be changed or taken away. Each field gets the checks it always had, next to
-- the ones an ADMIN already gave it: a rule of a kind it already has is not added (its own limit stays), nor own checks to a
-- field that already has some. A field given another type than it comes with gets none (they were not applied to it).
WITH defaults (key, type, rules, custom) AS (VALUES
  ('first_name', 'TEXT', '[{"type":"letters"},{"type":"max_length","value":100}]'::jsonb, '[]'::jsonb),
  ('last_name', 'TEXT', '[{"type":"letters"},{"type":"max_length","value":100}]'::jsonb, '[]'::jsonb),
  ('father_name', 'TEXT', '[{"type":"letters"},{"type":"max_length","value":150}]'::jsonb, '[]'::jsonb),
  ('mother_name', 'TEXT', '[{"type":"letters"},{"type":"max_length","value":150}]'::jsonb, '[]'::jsonb),
  ('email', 'TEXT', '[{"type":"email"}]'::jsonb, '[]'::jsonb),
  ('date_of_birth', 'DATE', '[{"type":"not_future"},{"type":"min_age","value":14},{"type":"max_age","value":100}]'::jsonb, '[]'::jsonb),
  ('current_address', 'TEXTAREA', '[{"type":"max_length","value":500}]'::jsonb, '[]'::jsonb),
  ('permanent_address', 'TEXTAREA', '[{"type":"max_length","value":500}]'::jsonb, '[]'::jsonb),
  ('landmark', 'TEXT', '[{"type":"max_length","value":150}]'::jsonb, '[]'::jsonb),
  ('pin_code', 'TEXT', '[{"type":"pin_code"}]'::jsonb, '[]'::jsonb),
  ('taluka', 'TEXT', '[{"type":"max_length","value":100}]'::jsonb, '[]'::jsonb),
  ('aadhaar_number', 'TEXT', '[{"type":"aadhaar"}]'::jsonb, '[]'::jsonb),
  ('mobile_number', 'TEXT', '[{"type":"indian_mobile"}]'::jsonb, '[]'::jsonb),
  ('alternate_mobile_number', 'TEXT', '[{"type":"indian_mobile"},{"type":"different_from","value":"mobile_number"}]'::jsonb, '[]'::jsonb),
  ('alternate_email', 'TEXT', '[{"type":"email"},{"type":"different_from","value":"email"}]'::jsonb, '[]'::jsonb),
  ('disability_type', 'TEXT', '[{"type":"max_length","value":100}]'::jsonb, '[]'::jsonb),
  ('disability_certificate_number', 'TEXT', '[]'::jsonb, '[{"kind":"REGEX","source":"[A-Za-z0-9/-]{4,50}","flags":"","message_en":"Use 4–50 characters: letters, digits, / and - only","message_mr":"४–५० वर्ण वापरा: फक्त इंग्रजी अक्षरे, अंक, / आणि -"}]'::jsonb),
  ('qualification_name', 'TEXT', '[{"type":"max_length","value":150}]'::jsonb, '[]'::jsonb),
  ('qualification_stream', 'TEXT', '[{"type":"max_length","value":150}]'::jsonb, '[]'::jsonb),
  ('qualification_board', 'TEXT', '[{"type":"max_length","value":200}]'::jsonb, '[]'::jsonb),
  ('qualification_completed_on', 'DATE', '[{"type":"not_future"},{"type":"min_date","value":"1940-01-01"}]'::jsonb, '[]'::jsonb),
  ('score', 'NUMBER', '[{"type":"max_decimals","value":2},{"type":"min_value","value":0},{"type":"grading_scale"}]'::jsonb, '[]'::jsonb)
), merged AS (
  SELECT f.id,
         coalesce(f.validation -> 'rules', '[]'::jsonb) || coalesce((
           SELECT jsonb_agg(r ORDER BY n) FROM jsonb_array_elements(d.rules) WITH ORDINALITY AS a (r, n)
           WHERE NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(coalesce(f.validation -> 'rules', '[]'::jsonb)) e WHERE e ->> 'type' = r ->> 'type')
         ), '[]'::jsonb) AS rules,
         CASE WHEN jsonb_array_length(coalesce(f.validation -> 'custom', '[]'::jsonb)) = 0 THEN d.custom
              ELSE f.validation -> 'custom' END AS custom
  FROM program_fields f JOIN defaults d ON d.key = f.key AND d.type = f.type
  WHERE NOT f.is_custom
)
UPDATE program_fields f SET validation = jsonb_build_object('rules', m.rules, 'custom', m.custom)
FROM merged m WHERE m.id = f.id AND (jsonb_array_length(m.rules) > 0 OR jsonb_array_length(m.custom) > 0);
