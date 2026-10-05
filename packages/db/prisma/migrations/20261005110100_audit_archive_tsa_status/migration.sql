-- AUDIT-ARCHIVE-001 / AUDIT-RFC3161-ANCHOR-001 (audit_archive und ihr
-- Insert-only-Trigger aus 20260531000000_iter18_audit_archive, search_path aus
-- 20260801000800_iter83_rls_hardening).
--
-- Review-Finding F-12. Scheiterte der RFC-3161-Stempel beim Archivieren, blieb
-- das Segment dauerhaft ohne externen Zeitnachweis; nachgestempelt wurde nie.
--  * tsa_status: STAMPED (Token beim Archivieren), PENDING (Token fehlt, ein
--    späterer audit-rotate-Lauf stempelt nach), STAMPED_LATE (nachträglich
--    gestempelt; die genTime im Token zeigt den Zeitpunkt). tsa_stamped_at hält
--    fest, wann der Token gespeichert wurde.
--  * Die Zeile bleibt ein unveränderlicher Beleg: der UPDATE-Trigger erlaubt
--    ausschließlich den einmaligen Übergang PENDING -> STAMPED_LATE, bei dem
--    nur tsa_response_blob, tsa_serial, tsa_status und tsa_stamped_at gesetzt
--    werden. ID-Bereich, Kettenanker, Datei-Hash, Speicherort, Modus und
--    Archivierungszeitpunkt bleiben unveränderlich; DELETE und TRUNCATE bleiben
--    gesperrt. Der Worker prüft vorher Größe, SHA-256 und Kette des gesperrten
--    Objekts und den Token gegen Datei-Hash und Trust-Roots.
--  * Bestand: Segmente mit Token werden STAMPED, ohne Token PENDING und damit
--    beim nächsten Lauf nachgestempelt.
BEGIN;

SET LOCAL row_security = off;

ALTER TABLE "audit_archive"
  ADD COLUMN "tsa_status" TEXT,
  ADD COLUMN "tsa_stamped_at" TIMESTAMPTZ(6);

-- Übergangsfassung nur für die Einordnung des Bestands in dieser Migration.
CREATE FUNCTION app.audit_archive_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF (NEW."id", NEW."tenant_id", NEW."from_audit_id", NEW."to_audit_id",
      NEW."from_occurred_at", NEW."to_occurred_at", NEW."entry_count",
      NEW."first_prev_hash", NEW."last_this_hash", NEW."file_sha256",
      NEW."file_size_bytes", NEW."storage_bucket", NEW."storage_key", NEW."mode",
      NEW."archived_at", NEW."archived_by", NEW."tsa_response_blob", NEW."tsa_serial",
      NEW."tsa_stamped_at")
     IS NOT DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."from_audit_id", OLD."to_audit_id",
      OLD."from_occurred_at", OLD."to_occurred_at", OLD."entry_count",
      OLD."first_prev_hash", OLD."last_this_hash", OLD."file_sha256",
      OLD."file_size_bytes", OLD."storage_bucket", OLD."storage_key", OLD."mode",
      OLD."archived_at", OLD."archived_by", OLD."tsa_response_blob", OLD."tsa_serial",
      OLD."tsa_stamped_at")
     AND OLD."tsa_status" IS NULL
     AND NEW."tsa_status" =
       (CASE WHEN OLD."tsa_response_blob" IS NULL THEN 'PENDING' ELSE 'STAMPED' END) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_archive ist insert-only (Hash-Chain-Belege)';
END;
$function$;

DROP TRIGGER "audit_archive_no_update" ON "audit_archive";
CREATE TRIGGER "audit_archive_guard_update"
  BEFORE UPDATE ON "audit_archive"
  FOR EACH ROW EXECUTE FUNCTION app.audit_archive_guard_update();

UPDATE "audit_archive"
   SET "tsa_status" = CASE WHEN "tsa_response_blob" IS NULL THEN 'PENDING' ELSE 'STAMPED' END
 WHERE "tsa_status" IS NULL;

ALTER TABLE "audit_archive"
  ALTER COLUMN "tsa_status" SET NOT NULL,
  ADD CONSTRAINT "audit_archive_tsa_status_check"
    CHECK ("tsa_status" IN ('STAMPED', 'PENDING', 'STAMPED_LATE')),
  ADD CONSTRAINT "audit_archive_tsa_status_blob_check"
    CHECK (("tsa_status" = 'PENDING') = ("tsa_response_blob" IS NULL));

-- Endfassung: nur noch der einmalige Nachstempel eines PENDING-Segments.
CREATE OR REPLACE FUNCTION app.audit_archive_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF (NEW."id", NEW."tenant_id", NEW."from_audit_id", NEW."to_audit_id",
      NEW."from_occurred_at", NEW."to_occurred_at", NEW."entry_count",
      NEW."first_prev_hash", NEW."last_this_hash", NEW."file_sha256",
      NEW."file_size_bytes", NEW."storage_bucket", NEW."storage_key", NEW."mode",
      NEW."archived_at", NEW."archived_by")
     IS NOT DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."from_audit_id", OLD."to_audit_id",
      OLD."from_occurred_at", OLD."to_occurred_at", OLD."entry_count",
      OLD."first_prev_hash", OLD."last_this_hash", OLD."file_sha256",
      OLD."file_size_bytes", OLD."storage_bucket", OLD."storage_key", OLD."mode",
      OLD."archived_at", OLD."archived_by")
     AND OLD."tsa_status" = 'PENDING'
     AND OLD."tsa_response_blob" IS NULL
     AND OLD."tsa_serial" IS NULL
     AND NEW."tsa_status" = 'STAMPED_LATE'
     AND NEW."tsa_response_blob" IS NOT NULL
     AND NEW."tsa_stamped_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_archive ist insert-only (Hash-Chain-Belege)';
END;
$function$;

-- Nachstempel-Kandidaten je Tenant (audit-rotate) und Rückstandskennzahl.
CREATE INDEX "audit_archive_tsa_pending_idx"
  ON "audit_archive" ("tenant_id", "from_audit_id")
  WHERE "tsa_status" = 'PENDING';

COMMIT;
