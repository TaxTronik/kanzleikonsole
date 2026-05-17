-- =============================================================================
-- S-7: TRUNCATE-Block-Trigger für audit_archive.
--
-- audit_log und audit_seal blockten bisher UPDATE/DELETE/TRUNCATE (siehe
-- 20260510000000_init). audit_archive (iter18) hat nur UPDATE und DELETE
-- abgefangen — TRUNCATE blieb möglich. Ein Owner mit BYPASSRLS + Table-Right
-- konnte so den Index der ausgelagerten Audit-Segmente verlieren; die
-- COMPLIANCE-gelockten NDJSON-Dateien im S3 bleiben zwar erhalten, aber
-- ohne DB-Referenz wäre die `pnpm verify:chain`-Verifikation gebrochen
-- (welcher Segment-Hash gehört zu welchem from/to-Range?).
--
-- TRUNCATE ist STATEMENT-Level — `FOR EACH ROW` ist nicht erlaubt; wir nutzen
-- `FOR EACH STATEMENT`.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.audit_archive_block_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_archive ist insert-only — TRUNCATE blockiert (Hash-Chain-Belege)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_archive_no_truncate ON "audit_archive";
CREATE TRIGGER audit_archive_no_truncate
  BEFORE TRUNCATE ON "audit_archive"
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_archive_block_truncate();
