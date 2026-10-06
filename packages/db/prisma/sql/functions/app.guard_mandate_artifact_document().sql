CREATE OR REPLACE FUNCTION app.guard_mandate_artifact_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM mandate_artifact a WHERE a.document_id=OLD.id AND (a.classification IS DISTINCT FROM NEW.classification::text OR a.requires_payroll_access IS DISTINCT FROM NEW.requires_payroll_access OR NEW.shared_with_client_at IS NOT NULL OR NEW.mime_type IS DISTINCT FROM OLD.mime_type)) THEN RAISE EXCEPTION 'artifact protection and private delivery are immutable'; END IF;
 RETURN NEW;
END $function$;
