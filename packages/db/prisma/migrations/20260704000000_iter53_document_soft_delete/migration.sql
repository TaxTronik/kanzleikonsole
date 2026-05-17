-- =============================================================================
-- iter53: Soft-Delete für document.
--
-- GoBD-Belege (10 J.) und GwG-Nachweise (5 J.) liegen unter SeaweedFS
-- Object-Lock COMPLIANCE — die Bytes sind bis zum retention_until physisch
-- NICHT löschbar (gesetzliche Aufbewahrung, § 147 AO / § 8 Abs. 4 GwG).
-- "Löschen" im UI darf daher nur ausblenden: deleted_at markiert das
-- Dokument als entfernt, die Datei im Object-Store bleibt unangetastet,
-- ein Audit-Eintrag dokumentiert wer/wann/warum, Wiederherstellung möglich.
--
-- Bewusst KEIN DB-Trigger/Constraint: das eigentliche Aufbewahrungs-Enforcement
-- sitzt im Object-Store (Object-Lock), nicht in dieser Spalte. deleted_at ist
-- reine Sichtbarkeits-Logik.
-- =============================================================================

ALTER TABLE "document"
  ADD COLUMN "deleted_at"       TIMESTAMPTZ(6),
  ADD COLUMN "deleted_by_staff" UUID,
  ADD COLUMN "delete_reason"    TEXT;

-- Listen filtern fast immer auf deleted_at IS NULL je Tenant.
CREATE INDEX "document_tenant_id_deleted_at_idx"
  ON "document" ("tenant_id", "deleted_at");
