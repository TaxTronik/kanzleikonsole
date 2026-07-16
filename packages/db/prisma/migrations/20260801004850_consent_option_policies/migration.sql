-- Consent catalog v2: office-defined required and recommended options.
--
-- The catalog intentionally remains tenant-scoped JSON because custom options
-- are ordered definitions rather than relational consent evidence. Existing
-- immutable ClientConsent snapshots are not changed. Only the current catalog
-- is upgraded, with both policies disabled for every legacy option.

WITH upgraded AS (
  SELECT
    ts."tenant_id",
    ts."key",
    jsonb_set(
      jsonb_set(ts."value", '{version}', '2'::jsonb, TRUE),
      '{options}',
      COALESCE(
        (
          SELECT jsonb_agg(
            CASE
              WHEN jsonb_typeof(entry.option) = 'object' THEN
                entry.option || jsonb_build_object(
                  'required', FALSE,
                  'recommended', FALSE
                )
              ELSE entry.option
            END
            ORDER BY entry.ordinality
          )
          FROM jsonb_array_elements(ts."value" -> 'options')
            WITH ORDINALITY AS entry(option, ordinality)
        ),
        '[]'::jsonb
      ),
      TRUE
    ) AS "value"
  FROM "tenant_setting" ts
  WHERE ts."key" = 'privacy.consent_options'
    AND jsonb_typeof(ts."value") = 'object'
    AND ts."value" ->> 'version' = '1'
    AND jsonb_typeof(ts."value" -> 'options') = 'array'
)
UPDATE "tenant_setting" ts
SET
  "value" = upgraded."value",
  "updated_at" = CURRENT_TIMESTAMP
FROM upgraded
WHERE ts."tenant_id" = upgraded."tenant_id"
  AND ts."key" = upgraded."key";
