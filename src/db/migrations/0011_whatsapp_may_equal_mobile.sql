-- The WhatsApp number (alternate_mobile_number, "WhatsApp Number" on the form) may be the same as the mobile number: its
-- check "different from Mobile Number" goes. Its other checks (an Indian mobile number, digits, lengths…) stay as they are.
-- A field left with no check at all has none (NULL), as Masters → Form fields saves it.
WITH kept AS (
  SELECT f.id,
         coalesce((SELECT jsonb_agg(r ORDER BY n)
                   FROM jsonb_array_elements(f.validation -> 'rules') WITH ORDINALITY AS a (r, n)
                   WHERE NOT (r ->> 'type' = 'different_from' AND r ->> 'value' = 'mobile_number')), '[]'::jsonb) AS rules,
         coalesce(f.validation -> 'custom', '[]'::jsonb) AS custom
  FROM program_fields f
  WHERE f.key = 'alternate_mobile_number'
    AND f.validation -> 'rules' @> '[{"type": "different_from", "value": "mobile_number"}]'::jsonb
)
UPDATE program_fields f
SET validation = CASE WHEN jsonb_array_length(k.rules) = 0 AND jsonb_array_length(k.custom) = 0 THEN NULL
                      ELSE jsonb_build_object('rules', k.rules, 'custom', k.custom) END
FROM kept k
WHERE k.id = f.id;
