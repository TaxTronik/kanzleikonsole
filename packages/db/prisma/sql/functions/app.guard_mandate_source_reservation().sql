CREATE OR REPLACE FUNCTION app.guard_mandate_source_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mandate_artifact WHERE id=NEW.artifact_id AND status='RESERVED' AND document_id IS NULL AND document_version_id IS NULL) THEN RAISE EXCEPTION 'artifact sources must be bound before upload'; END IF;
 RETURN NEW;
END $function$;
