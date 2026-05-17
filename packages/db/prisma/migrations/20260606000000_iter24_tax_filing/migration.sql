-- =============================================================================
-- Iter. 24: Steuererklärungen / Vor-Bescheide (TaxFiling)
--
-- Was die Kanzlei in DATEV/Addison erstellt und ans FA übermittelt — mit
-- der dort angezeigten Berechnung. Wird optional dem Mandant im Portal
-- vorab kommuniziert, lange bevor der echte Bescheid eintrifft.
-- Bei Bescheid-Eingang können wir per (clientId, kind, period) auf das
-- vorhandene TaxFiling matchen und Soll/Ist vergleichen.
-- =============================================================================

CREATE TABLE "tax_filing" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"              UUID NOT NULL,
  "client_id"              UUID NOT NULL,
  "kind"                   "tax_notice_kind" NOT NULL,
  "period"                 TEXT NOT NULL,
  "filing_date"            DATE,
  -- Voraussichtliche Beträge laut DATEV/Addison
  "expected_assessed"      DECIMAL(12,2),
  "expected_prepaid"       DECIMAL(12,2),
  "expected_refund"        DECIMAL(12,2),
  "expected_pay"           DECIMAL(12,2),
  -- Notiz an den Mandanten (Markdown möglich)
  "client_note"            TEXT,
  -- Interne Anmerkung für die Kanzlei
  "internal_note"          TEXT,
  -- Optional: PDF der Berechnung (DATEV-/Addison-Export)
  "document_id"            UUID,
  -- Portal-Freigabe
  "shared_with_client"     BOOLEAN NOT NULL DEFAULT FALSE,
  "shared_at"              TIMESTAMP(3),
  "shared_by"              UUID,
  "created_by_staff"       UUID NOT NULL,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tax_filing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_filing_tenant_client_kind_period_key"
  ON "tax_filing" ("tenant_id", "client_id", "kind", "period");
CREATE INDEX "tax_filing_tenant_client_idx"
  ON "tax_filing" ("tenant_id", "client_id");

ALTER TABLE "tax_filing"
  ADD CONSTRAINT "tax_filing_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "tax_filing"
  ADD CONSTRAINT "tax_filing_client_fk"
  FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE;
ALTER TABLE "tax_filing"
  ADD CONSTRAINT "tax_filing_document_fk"
  FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL;

ALTER TABLE "tax_filing" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_filing_isolation ON "tax_filing"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Optional: TaxNotice kann auf eine TaxFiling verweisen (Soll/Ist-Vergleich)
ALTER TABLE "tax_notice"
  ADD COLUMN "filing_id" UUID;
ALTER TABLE "tax_notice"
  ADD CONSTRAINT "tax_notice_filing_fk"
  FOREIGN KEY ("filing_id") REFERENCES "tax_filing"("id") ON DELETE SET NULL;
