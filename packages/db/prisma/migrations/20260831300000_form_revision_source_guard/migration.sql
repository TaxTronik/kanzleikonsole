-- Fachkatalog: FORM-SCHEMA-SNAPSHOT-001, DOC-VERSION-IMMUTABILITY-001.
-- A version referenced by a returned submission must retain its original bytes.
-- RLS must not hide a protected reference from a generic document writer.
BEGIN;
CREATE FUNCTION app.guard_form_revision_source_identity() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF ROW(NEW.id,NEW.document_id,NEW.version_no,NEW.storage_bucket,NEW.storage_key,
        NEW.storage_version_id,NEW.sha256,NEW.size_bytes,NEW.created_at,NEW.created_by_id)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.document_id,OLD.version_no,OLD.storage_bucket,OLD.storage_key,
        OLD.storage_version_id,OLD.sha256,OLD.size_bytes,OLD.created_at,OLD.created_by_id)
    AND EXISTS(SELECT 1 FROM public.form_submission_revision_file f WHERE f.document_version_id=OLD.id)
 THEN RAISE EXCEPTION 'Submitted form source identity is immutable'; END IF;
 -- Scan results remain editable: later quarantine must still prevent downloads.
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_form_revision_source_identity() FROM PUBLIC,taxtronik_app;
CREATE TRIGGER document_version_form_revision_identity
BEFORE UPDATE ON document_version FOR EACH ROW EXECUTE FUNCTION app.guard_form_revision_source_identity();
COMMIT;
