-- INV-STORNO-REFERENCE-001 / INV-TIME-ENTRY-CLAIM-001 / WORKFLOW-DEPENDENCY-001.
-- (tax_notice.filing_id: keine Katalogregel mit eigenem Bezug.)
--
-- Verhaltensneutral; Review-Finding D-05. Seit der FK-Index-Bereinigung
-- 20260801001800_iter93_fk_indexes sind wieder Fremdschlüssel ohne führenden
-- Index entstanden. Praktisch relevant sind drei, weil sie bei Löschungen der
-- Elternzeile (FK-Prüfung) UND von Lesern genutzt werden:
--  * time_entry.invoice_id: Storno gibt die Leistungen der stornierten
--    Rechnung frei (UPDATE ... WHERE invoice_id = ?); beim Löschen eines
--    Rechnungsentwurfs setzt die FK-Aktion invoice_id auf NULL. Bisher las
--    beides den ganzen Tenant-Bereich von (tenant_id, client_id, billable,
--    invoice_id) bzw. die ganze Tabelle.
--  * workflow_dependency.successor_item_id: Bereitschaft der Workflow-Schritte
--    (Vorgänger der sichtbaren Schritte) und die Cascade beim Löschen eines
--    Schritts; bisher Seq Scan (nur (predecessor, successor) war indiziert).
--  * tax_notice.filing_id: Bescheide einer Erklärung (Relation) und SET NULL
--    beim Löschen einer Erklärung; bisher Seq Scan.
-- Einspaltig, damit auch die FK-Prüfung (ohne Tenant-Bedingung) sie nutzt.
--
-- Weitere FK ohne führenden Index prüft `pnpm verify:fk-indexes` im db-Job
-- (Allowlist für Akteur-Spalten und den dokumentierten Bestand).
--
-- Aufwand beim Deploy: CREATE INDEX sperrt Schreibzugriffe auf die Tabelle
-- während des Aufbaus (Schreiber sind gestoppt). Gemessen: 400.000
-- Zeiteinträge, 48.000 Abhängigkeiten, 100.000 Bescheide zusammen unter 1 s.
BEGIN;

CREATE INDEX "time_entry_invoice_id_idx" ON "time_entry" ("invoice_id");

CREATE INDEX "workflow_dependency_successor_item_id_idx"
  ON "workflow_dependency" ("successor_item_id");

CREATE INDEX "tax_notice_filing_id_idx" ON "tax_notice" ("filing_id");

COMMIT;
