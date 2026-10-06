CREATE OR REPLACE FUNCTION app.guard_mandate_artifact_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND NEW.document_version_id IS NULL AND OLD.document_version_id IS NOT NULL AND (to_jsonb(NEW)-'document_version_id')=(to_jsonb(OLD)-'document_version_id') THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable artifact source'; END IF;
 IF NOT EXISTS(SELECT 1 FROM mandate_artifact a JOIN document_version v ON v.id=NEW.document_version_id JOIN document d ON d.id=v.document_id WHERE a.id=NEW.artifact_id AND a.tenant_id=d.tenant_id AND a.client_id=d.client_id AND encode(v.sha256,'hex')=NEW.source_hash) THEN RAISE EXCEPTION 'invalid artifact source'; END IF;
 RETURN NEW;
END $function$;
