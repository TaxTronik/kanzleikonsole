-- § 147 Abs. 3 AO unterscheidet 10 Jahre (Abs. 1 Nr. 1), 8 Jahre
-- (Buchungsbelege, Nr. 4) und 6 Jahre für die sonstigen Unterlagen, darunter
-- Handels-/Geschäftsbriefe. Der bisherige pauschale 10-Jahres-Vertragstyp
-- war daher fachlich zu breit.
--
-- Bereits COMPLIANCE-gelockte Dokumente behalten ihren alten 10-Jahres-Typ:
-- deren physische Frist kann nicht nachträglich verkürzt werden. Neue Uploads
-- erhalten einen aktiven 6-Jahres-Typ mit demselben Legacy-Classification-Key.

UPDATE "document_type"
SET "active" = FALSE,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "builtin" = TRUE
  AND "classification_key" = 'GOBD_CONTRACT'
  AND "retention_years" = 10;

INSERT INTO "document_type" (
  "tenant_id",
  "name",
  "tier",
  "builtin",
  "classification_key",
  "active",
  "sort_order",
  "retention_years",
  "updated_at"
)
SELECT
  t."id",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "document_type" by_name
      WHERE by_name."tenant_id" = t."id"
        AND by_name."name" = 'Vertrag / Geschäftsbrief'
    ) THEN 'Vertrag / Geschäftsbrief (System ' || LEFT(t."id"::TEXT, 8) || ')'
    ELSE 'Vertrag / Geschäftsbrief'
  END,
  'GOBD'::"document_protection_tier",
  TRUE,
  'GOBD_CONTRACT',
  TRUE,
  20,
  6,
  CURRENT_TIMESTAMP
FROM "tenant" t
WHERE NOT EXISTS (
  SELECT 1
  FROM "document_type" dt
  WHERE dt."tenant_id" = t."id"
    AND dt."classification_key" = 'GOBD_CONTRACT'
    AND dt."active" = TRUE
    AND dt."retention_years" = 6
);
