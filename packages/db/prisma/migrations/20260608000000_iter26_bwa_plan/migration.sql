-- =============================================================================
-- Iter. 26: BWA-Planrechnung (Mandanten-Self-Service-Planung)
--
-- Mandant erstellt im Portal eine Planrechnung pro Jahr — Wizard-basiert:
-- Basis-BWA wählen → KPIs prozentual oder absolut anpassen → speichern.
-- Mehrere Versionen pro Mandant + Jahr möglich.
--
-- Bewusst flach gehalten: 6 KPI-Achsen (Erlöse, Personalkosten, sonstige
-- Kosten, Abschreibungen, Materialeinsatz, Sonstiges) — eine Position pro
-- Achse. Detailgrad wie BWA-Position 1990/3030/3150 etc.
-- =============================================================================

CREATE TABLE "bwa_plan" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       UUID NOT NULL,
  "client_id"       UUID NOT NULL,
  "name"            TEXT NOT NULL,
  "year"            INT NOT NULL,
  -- Optionale Basis-Periode (BwaPeriod), aus der initial gefüllt wurde.
  "base_period_id"  UUID,
  -- Markdown-Notiz / Annahmen
  "notes"           TEXT,
  -- Plan-Status (DRAFT: Mandant arbeitet noch; FINAL: festgehalten)
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "created_by"      UUID NOT NULL,
  "created_by_type" TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bwa_plan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bwa_plan_tenant_client_year_idx" ON "bwa_plan" ("tenant_id","client_id","year" DESC);

ALTER TABLE "bwa_plan"
  ADD CONSTRAINT "bwa_plan_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "bwa_plan"
  ADD CONSTRAINT "bwa_plan_client_fk"
  FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE;
ALTER TABLE "bwa_plan"
  ADD CONSTRAINT "bwa_plan_base_period_fk"
  FOREIGN KEY ("base_period_id") REFERENCES "bwa_period"("id") ON DELETE SET NULL;

ALTER TABLE "bwa_plan" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bwa_plan_isolation ON "bwa_plan"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Eine Zeile pro KPI-Achse
CREATE TABLE "bwa_plan_line" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_id"   UUID NOT NULL,
  -- Achse: REVENUE | PERSONNEL | OTHER_COSTS | DEPRECIATION | MATERIAL | OTHER_INCOME
  "axis"      TEXT NOT NULL,
  -- Geplanter Betrag (Jahreswert, EUR)
  "amount"    DECIMAL(14,2) NOT NULL,
  -- Optional: Notiz zur Annahme
  "note"      TEXT,
  CONSTRAINT "bwa_plan_line_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bwa_plan_line_plan_axis_key" ON "bwa_plan_line" ("plan_id","axis");

ALTER TABLE "bwa_plan_line"
  ADD CONSTRAINT "bwa_plan_line_plan_fk"
  FOREIGN KEY ("plan_id") REFERENCES "bwa_plan"("id") ON DELETE CASCADE;
