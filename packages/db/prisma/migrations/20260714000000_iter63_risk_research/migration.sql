-- =============================================================================
-- iter63: Rechercheauftrag → n8n (anonymisiert) + Rechercheergebnisse-Ablage.
--
-- risk_research_request: ein an n8n relayter Rechercheauftrag. Der ausgehende
--   Payload ist ANONYMISIERT (§ 203). `mapping` (Platzhalter→Original) wird NIE
--   an n8n gesendet — nur lokal zur De-Anonymisierung der Antwort, daher sensibel
--   und RLS-geschützt. Korrelation über die id (opaker Token).
-- risk_research_result: von n8n zurückgelieferte Antwort; via Korrelation
--   automatisch einer Markierung zugeordnet, sonst heuristisch vorgeschlagen.
--
-- Beide tenant-scoped mit RLS (Muster iter60).
-- =============================================================================

-- CreateEnum
CREATE TYPE "research_request_status" AS ENUM ('SENT', 'ANSWERED', 'FAILED');

-- CreateEnum
CREATE TYPE "research_result_status" AS ENUM ('NEU', 'ZUGEORDNET', 'VERWORFEN');

-- CreateTable
CREATE TABLE "risk_research_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "analysis_id" UUID NOT NULL,
    "marking_id" UUID,
    "prompt" TEXT,
    "include_sachverhalt" BOOLEAN NOT NULL DEFAULT false,
    "anonymized_payload" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "status" "research_request_status" NOT NULL DEFAULT 'SENT',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_research_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_research_result" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "research_request_id" UUID,
    "marking_id" UUID,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "source" TEXT,
    "status" "research_result_status" NOT NULL DEFAULT 'NEU',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_research_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_research_request_tenant_id_analysis_id_idx" ON "risk_research_request"("tenant_id", "analysis_id");

-- CreateIndex
CREATE INDEX "risk_research_request_tenant_id_marking_id_idx" ON "risk_research_request"("tenant_id", "marking_id");

-- CreateIndex
CREATE INDEX "risk_research_result_tenant_id_status_idx" ON "risk_research_result"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "risk_research_result_tenant_id_marking_id_idx" ON "risk_research_result"("tenant_id", "marking_id");

-- AddForeignKey
ALTER TABLE "risk_research_request" ADD CONSTRAINT "risk_research_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_research_request" ADD CONSTRAINT "risk_research_request_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "risk_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_research_request" ADD CONSTRAINT "risk_research_request_marking_fk" FOREIGN KEY ("marking_id") REFERENCES "risk_marking"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "risk_research_result" ADD CONSTRAINT "risk_research_result_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_research_result" ADD CONSTRAINT "risk_research_result_request_fk" FOREIGN KEY ("research_request_id") REFERENCES "risk_research_request"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "risk_research_result" ADD CONSTRAINT "risk_research_result_marking_fk" FOREIGN KEY ("marking_id") REFERENCES "risk_marking"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- =============================================================================
-- Row Level Security — tenant-Isolation (Backstop). `mapping` ist sensibel
-- (Original-Mandantendaten zur De-Anonymisierung) → RLS besonders wichtig.
-- =============================================================================
ALTER TABLE "risk_research_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_research_request_isolation ON "risk_research_request"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_research_request" TO taxtronik_app;

ALTER TABLE "risk_research_result" ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_research_result_isolation ON "risk_research_result"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_research_result" TO taxtronik_app;
