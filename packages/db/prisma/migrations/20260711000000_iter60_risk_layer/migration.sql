-- =============================================================================
-- iter60: Risk-Layer / TCMS-Integrationsschicht (§4).
--
-- Persistiert Analyse-Läufe der externen Risk-Engine und die erkannten/berater-
-- gesetzten Markierungen. Die Engine selbst ist zustandslos — TaxTronik ist die
-- datenführende, mandantentragende Hülle. Beide Tabellen sind tenant-scoped mit
-- RLS (wie der Rest), Delegation verweist auf das bestehende `request`.
--
-- TCMS-/Graph-Rohstoff (Normketten, Governance-Matrix) liegt erstklassig als
-- Spalten auf risk_marking — NICHT als Blob. raw_result hält zusätzlich den
-- vollständigen Engine-Output für Audit/Replay.
--
-- created_by_id / verantwortlich_id sind reine Mitarbeiter-UUIDs ohne FK (wie
-- request.created_by_staff) — Mitarbeiter werden deaktiviert, nicht gelöscht.
-- =============================================================================

-- CreateEnum
CREATE TYPE "risk_herkunft" AS ENUM ('WOERTLICH', 'MUSTER', 'TRIGGER', 'EMBEDDING', 'LLM', 'BERATER');

-- CreateEnum
CREATE TYPE "governance_typ" AS ENUM ('FP', 'FF', 'IN');

-- CreateEnum
CREATE TYPE "risk_stufe" AS ENUM ('NIEDRIG', 'MITTEL', 'HOCH');

-- CreateEnum
CREATE TYPE "risk_wk" AS ENUM ('SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG');

-- CreateEnum
CREATE TYPE "risk_status" AS ENUM ('OFFEN', 'IN_PRUEFUNG', 'KONTROLLIERT', 'AKZEPTIERT');

-- CreateTable
CREATE TABLE "risk_analysis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "document_id" UUID,
    "text_hash" TEXT NOT NULL,
    "katalog_version" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "raw_result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_marking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "analysis_id" UUID NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "matched_text" TEXT NOT NULL,
    "herkunft" "risk_herkunft" NOT NULL,
    "begriff_id" TEXT,
    "begriff" TEXT NOT NULL,
    "norm_anker" TEXT[],
    "normketten" JSONB,
    "governance_typ" "governance_typ",
    "schadensintensitaet" "risk_stufe",
    "wahrscheinlichkeit" "risk_wk",
    "kaskadenreichweite" INTEGER,
    "kontrolle" TEXT,
    "verantwortlich_id" UUID,
    "status" "risk_status" NOT NULL DEFAULT 'OFFEN',
    "notiz" TEXT,
    "reminder_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "risk_marking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_analysis_tenant_id_client_id_idx" ON "risk_analysis"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "risk_analysis_tenant_id_document_id_idx" ON "risk_analysis"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "risk_analysis_tenant_id_created_at_idx" ON "risk_analysis"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "risk_marking_tenant_id_analysis_id_idx" ON "risk_marking"("tenant_id", "analysis_id");

-- CreateIndex
CREATE INDEX "risk_marking_tenant_id_status_idx" ON "risk_marking"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "risk_marking_tenant_id_reminder_id_idx" ON "risk_marking"("tenant_id", "reminder_id");

-- AddForeignKey
ALTER TABLE "risk_analysis" ADD CONSTRAINT "risk_analysis_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_analysis" ADD CONSTRAINT "risk_analysis_client_fk" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "risk_analysis" ADD CONSTRAINT "risk_analysis_document_fk" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "risk_marking" ADD CONSTRAINT "risk_marking_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_marking" ADD CONSTRAINT "risk_marking_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "risk_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_marking" ADD CONSTRAINT "risk_marking_reminder_fk" FOREIGN KEY ("reminder_id") REFERENCES "client_reminder"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- =============================================================================
-- Row Level Security — tenant-Isolation (Backstop zur App-Filterung).
-- Identisches Muster wie alle mandantenbezogenen Tabellen: nur Zeilen des
-- aktuellen Tenants sind sicht-/schreibbar; taxtronik_app (RLS-gebundene Rolle)
-- bekommt DML-Rechte, der Owner behält BYPASSRLS.
-- =============================================================================
ALTER TABLE "risk_analysis" ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_analysis_isolation ON "risk_analysis"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_analysis" TO taxtronik_app;

ALTER TABLE "risk_marking" ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_marking_isolation ON "risk_marking"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_marking" TO taxtronik_app;
