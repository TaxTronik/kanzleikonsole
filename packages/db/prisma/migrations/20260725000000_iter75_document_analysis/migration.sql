-- iter75: Dokumente optional an einen Sachverhalt (RiskAnalysis) binden — der
-- „Aktenregal"-Tab im Subsumtions-Workspace zeigt die Docs dieser Analyse und
-- setzt analysis_id beim Upload (analog workflow_item_id). SET NULL: das Dokument
-- überlebt das Löschen der Analyse (GoBD/Aufbewahrung). document ist bereits ein
-- Tenant-Table mit RLS + GRANT — kein neuer RLS-Block nötig (nur eine Spalte).

ALTER TABLE "document" ADD COLUMN "analysis_id" UUID;

ALTER TABLE "document" ADD CONSTRAINT "document_analysis_fk"
    FOREIGN KEY ("analysis_id") REFERENCES "risk_analysis"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "document_tenant_id_analysis_id_idx" ON "document"("tenant_id", "analysis_id");
