-- =============================================================================
-- Iter. 18: Audit-Archive — segmentweise Auslagerung des audit_log
-- =============================================================================

CREATE TYPE "audit_archive_mode" AS ENUM ('SOFT','HARD');

CREATE TABLE "audit_archive" (
  "id"                BIGSERIAL PRIMARY KEY,
  "tenant_id"         UUID NOT NULL,
  "from_audit_id"     BIGINT NOT NULL,
  "to_audit_id"       BIGINT NOT NULL,
  "from_occurred_at"  TIMESTAMP(3) NOT NULL,
  "to_occurred_at"    TIMESTAMP(3) NOT NULL,
  "entry_count"       INT NOT NULL,
  "first_prev_hash"   BYTEA NOT NULL,
  "last_this_hash"    BYTEA NOT NULL,
  "file_sha256"       BYTEA NOT NULL,
  "file_size_bytes"   BIGINT NOT NULL,
  "storage_bucket"    TEXT NOT NULL,
  "storage_key"       TEXT NOT NULL,
  "tsa_response_blob" BYTEA,
  "tsa_serial"        TEXT,
  "mode"              "audit_archive_mode" NOT NULL DEFAULT 'SOFT',
  "archived_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_by"       TEXT NOT NULL DEFAULT 'system'
);

CREATE UNIQUE INDEX "audit_archive_tenant_id_from_audit_id_key"
  ON "audit_archive"("tenant_id","from_audit_id");
CREATE INDEX "audit_archive_tenant_id_archived_at_idx"
  ON "audit_archive"("tenant_id","archived_at");

-- Insert-only-Trigger analog audit_log/audit_seal
CREATE OR REPLACE FUNCTION app.audit_archive_block_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_archive ist insert-only (Hash-Chain-Belege)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_archive_no_update
  BEFORE UPDATE ON "audit_archive"
  FOR EACH ROW EXECUTE FUNCTION app.audit_archive_block_mutation();

CREATE TRIGGER audit_archive_no_delete
  BEFORE DELETE ON "audit_archive"
  FOR EACH ROW EXECUTE FUNCTION app.audit_archive_block_mutation();

ALTER TABLE "audit_archive" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_archive_isolation ON "audit_archive"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
