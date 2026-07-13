-- S3 Object Lock setzt Bucket-Versionierung voraus. Für eine tatsächliche
-- Vernichtung muss die konkrete Objektversion gelöscht werden; DeleteObject
-- nur mit Bucket+Key erzeugt sonst lediglich einen Delete Marker.

ALTER TABLE "document_version"
  ADD COLUMN "storage_version_id" TEXT;

-- Legacy-Zeilen dürfen bis zur Storage-Inventur noch NULL enthalten. Neue
-- Object-Lock-Zeilen müssen dagegen immer auf die konkrete S3-Version zeigen.
-- NOT VALID überspringt nur die Bestandsprüfung; neue/aktualisierte Zeilen
-- werden sofort gegen die Bedingung geprüft.
ALTER TABLE "document_version"
  ADD CONSTRAINT "document_version_locked_storage_version_check"
  CHECK (NOT "immutable" OR "storage_version_id" IS NOT NULL)
  NOT VALID;

-- Die neue Referenz ist Teil der unveränderbaren Storage-Identität. Die
-- bestehende Schutzfunktion muss sie daher genauso einfrieren wie Bucket/Key.
CREATE OR REPLACE FUNCTION app.protect_immutable_document_version()
RETURNS TRIGGER AS $$
DECLARE
  authorized_document TEXT;
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.immutable = TRUE) THEN
        IF (OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
            OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
            OR OLD.storage_version_id IS DISTINCT FROM NEW.storage_version_id
            OR OLD.sha256 IS DISTINCT FROM NEW.sha256
            OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
            OR OLD.immutable IS DISTINCT FROM NEW.immutable
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
              WHERE p.oid = 'app.destroy_gwg_document_versions(uuid)'::regprocedure
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

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp;
