-- Die Legacy-Recovery-Migration 20260801004400 musste die historische
-- Immutability-Funktion neu aufbauen, hatte dabei aber storage_version_id aus
-- der geschützten Storage-Identität verloren. Seit zweiphasige Uploads eine
-- PENDING-Zeile atomar auf immutable+CLEAN finalisieren, muss die danach
-- gebundene konkrete S3-Version wieder dauerhaft eingefroren sein.

-- Ein zweiphasiger Upload muss Bucket/Key/Hash bereits VOR dem PUT immutable
-- journalisieren können. Nur PENDING darf deshalb vorübergehend ohne konkrete
-- S3-Version existieren; jede andere neue/aktualisierte immutable Zeile braucht
-- weiterhin sofort eine nichtleere storage_version_id.
ALTER TABLE "document_version"
  DROP CONSTRAINT IF EXISTS "document_version_locked_storage_version_check";

ALTER TABLE "document_version"
  ADD CONSTRAINT "document_version_locked_storage_version_check"
  CHECK (
    NOT "immutable"
    OR ("storage_version_id" IS NOT NULL AND btrim("storage_version_id") <> '')
    OR (
      "scan_status" = 'PENDING'
      AND "scan_completed_at" IS NULL
      AND "storage_version_id" IS NULL
    )
  )
  NOT VALID;

CREATE OR REPLACE FUNCTION app.protect_immutable_document_version()
RETURNS TRIGGER AS $$
DECLARE
  authorized_document TEXT;
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.immutable = TRUE) THEN
    -- Einzige erlaubte Mutation einer immutable PENDING-Absicht: Die zuvor
    -- unbekannte konkrete Objektversion ergänzen und denselben Datensatz in
    -- einem Schritt auf CLEAN setzen. Sämtliche vorbereiteten Identitätsfelder
    -- müssen bytegenau gleich bleiben.
    IF (OLD.scan_status = 'PENDING'
        AND OLD.scan_completed_at IS NULL
        AND OLD.storage_version_id IS NULL
        AND NEW.scan_status = 'CLEAN'
        AND NEW.scan_completed_at IS NOT NULL
        AND NEW.storage_version_id IS NOT NULL
        AND btrim(NEW.storage_version_id) <> ''
        AND OLD.id IS NOT DISTINCT FROM NEW.id
        AND OLD.storage_bucket IS NOT DISTINCT FROM NEW.storage_bucket
        AND OLD.storage_key IS NOT DISTINCT FROM NEW.storage_key
        AND OLD.sha256 IS NOT DISTINCT FROM NEW.sha256
        AND OLD.size_bytes IS NOT DISTINCT FROM NEW.size_bytes
        AND OLD.immutable IS NOT DISTINCT FROM NEW.immutable
        AND OLD.version_no IS NOT DISTINCT FROM NEW.version_no
        AND OLD.document_id IS NOT DISTINCT FROM NEW.document_id
        AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
        AND OLD.created_by_id IS NOT DISTINCT FROM NEW.created_by_id) THEN
      RETURN NEW;
    END IF;

    IF (OLD.id IS DISTINCT FROM NEW.id
        OR OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
        OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
        OR OLD.storage_version_id IS DISTINCT FROM NEW.storage_version_id
        OR OLD.sha256 IS DISTINCT FROM NEW.sha256
        OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
        OR OLD.immutable IS DISTINCT FROM NEW.immutable
        OR OLD.scan_status IS DISTINCT FROM NEW.scan_status
        OR OLD.scan_completed_at IS DISTINCT FROM NEW.scan_completed_at
        OR OLD.version_no IS DISTINCT FROM NEW.version_no
        OR OLD.document_id IS DISTINCT FROM NEW.document_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.created_by_id IS DISTINCT FROM NEW.created_by_id) THEN
      RAISE EXCEPTION 'document_version ist immutable, Inhaltsfelder dürfen nicht geändert werden'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP = 'DELETE' AND OLD.immutable = TRUE) THEN
    authorized_document := current_setting('app.gwg_destroy_document_id', TRUE);
    IF authorized_document = OLD.document_id::TEXT
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
       )
       AND EXISTS (
         SELECT 1 FROM "document" d
          WHERE d."id" = OLD.document_id
            AND d."classification" = 'GWG_EVIDENCE'
            AND d."gwg_destruction_requested_at" IS NOT NULL
            AND d."gwg_destroyed_at" IS NULL
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'document_version ist immutable und darf nicht gelöscht werden'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Mutable Alt-/NONE-Versionen behalten ihre bisherigen Update-Pfade.
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_immutable_document_version()
  SET search_path = pg_catalog, public, app, pg_temp;
