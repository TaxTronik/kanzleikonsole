-- =============================================================================
-- iter86 — USt je Position (§ 14 Abs. 4 Nr. 8 UStG: Entgelt-Ausweis
-- aufgeschlüsselt nach Steuersätzen).
--
-- Der Steuersatz wandert vom Rechnungskopf an die Position:
--   - invoice_position.vat_rate NOT NULL (Backfill aus dem Kopf-Satz)
--   - invoice.vat_rate wird NULLABLE: bei Mischsätzen gibt es keinen
--     einheitlichen Kopf-Satz mehr (NULL); bei einheitlichem Satz bleibt er
--     redundant gesetzt (Anzeige/CSV-Komfort, Bestandsdaten unverändert).
--
-- Backfill-Hinweis: invoice_position_protect (iter85) blockiert Updates an
-- Positionen festgeschriebener Rechnungen — auch für den Owner. Der Backfill
-- ist KEINE inhaltliche Änderung (er materialisiert den bereits im Kopf
-- festgeschriebenen Satz an der Position), daher wird der Trigger gezielt
-- für genau dieses Statement deaktiviert (Tabellen-Owner-Recht, kein
-- Superuser nötig). Migrationen laufen in einer Transaktion — zwischen
-- DISABLE und ENABLE kann kein anderes Statement einreden.
-- =============================================================================

ALTER TABLE "invoice_position" ADD COLUMN "vat_rate" DECIMAL(5,2);

ALTER TABLE "invoice_position" DISABLE TRIGGER invoice_position_protect;

UPDATE "invoice_position" p
SET vat_rate = i.vat_rate
FROM "invoice" i
WHERE i.id = p.invoice_id;

ALTER TABLE "invoice_position" ENABLE TRIGGER invoice_position_protect;

ALTER TABLE "invoice_position" ALTER COLUMN "vat_rate" SET NOT NULL;

ALTER TABLE "invoice" ALTER COLUMN "vat_rate" DROP NOT NULL;
