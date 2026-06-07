-- iter74: Workflow-Instanzen optional an einen Sachverhalt (RiskAnalysis) binden.
-- Aus dem Subsumtions-Tab „Aufgaben" gestartete Workflows gehören zu genau dieser
-- Analyse. SET NULL: ein Workflow überlebt das Löschen der Analyse (Aufbewahrung).
-- workflow_instance ist bereits ein Tenant-Table mit RLS + GRANT — kein neuer
-- RLS-Block nötig (nur eine zusätzliche Spalte auf der bestehenden Tabelle).

ALTER TABLE "workflow_instance" ADD COLUMN "analysis_id" UUID;

ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_analysis_fk"
    FOREIGN KEY ("analysis_id") REFERENCES "risk_analysis"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "workflow_instance_tenant_id_analysis_id_idx" ON "workflow_instance"("tenant_id", "analysis_id");
