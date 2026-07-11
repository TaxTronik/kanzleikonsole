-- =============================================================================
-- Datei-Typen tragen neben der Schutzstufe die fachliche 6-/8-/10-Jahresfrist.
-- Damit werden § 147 AO/§ 14b UStG nicht mehr pauschal als zehn Jahre modelliert.
-- =============================================================================

ALTER TABLE "document_type" ADD COLUMN "retention_years" INTEGER;

UPDATE "document_type"
SET "retention_years" = CASE
  WHEN "tier" = 'GWG'::"document_protection_tier" THEN 5
  WHEN "tier" = 'GOBD'::"document_protection_tier"
       AND "classification_key" = 'GOBD_INVOICE' THEN 8
  WHEN "tier" = 'GOBD'::"document_protection_tier" THEN 10
  ELSE NULL
END;

ALTER TABLE "document_type"
  ADD CONSTRAINT "document_type_retention_years_check"
  CHECK (
    ("tier" = 'NONE'::"document_protection_tier" AND "retention_years" IS NULL)
    OR (
      "tier" = 'GWG'::"document_protection_tier"
      AND "retention_years" IS NOT NULL
      AND "retention_years" = 5
    )
    OR (
      "tier" = 'GOBD'::"document_protection_tier"
      AND "retention_years" IS NOT NULL
      AND "retention_years" IN (6, 8, 10)
    )
  );
