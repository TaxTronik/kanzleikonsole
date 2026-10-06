CREATE OR REPLACE FUNCTION app.guard_assistance_revision_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE c RECORD;
BEGIN
 SELECT * INTO c FROM client_assistance_case WHERE id=NEW.case_id;
 IF c.id IS NULL OR NEW.revision<>c.revision OR NEW.answers IS DISTINCT FROM c.answers OR NEW.status<>c.status OR NEW.actor_id IS DISTINCT FROM app.current_actor_id() OR NEW.actor_type IS DISTINCT FROM app.current_actor_type() THEN RAISE EXCEPTION 'invalid revision event'; END IF;
 IF NEW.snapshot_hash !~ '^[0-9a-f]{64}$' OR NEW.snapshot->>'caseId' IS DISTINCT FROM c.id::text OR NEW.snapshot->>'kind' IS DISTINCT FROM c.kind OR NEW.snapshot->>'status' IS DISTINCT FROM c.status OR (NEW.snapshot->>'revision')::integer IS DISTINCT FROM c.revision OR NEW.snapshot->'answers' IS DISTINCT FROM c.answers OR NEW.snapshot->'schema' IS DISTINCT FROM c.schema_snapshot THEN RAISE EXCEPTION 'invalid revision snapshot'; END IF;
 IF NEW.source_version_id IS DISTINCT FROM c.source_document_version_id OR NEW.external_version_id IS DISTINCT FROM c.external_document_version_id OR NEW.snapshot->>'sourceVersionId' IS DISTINCT FROM c.source_document_version_id::text OR NEW.snapshot->>'sourceHash' IS DISTINCT FROM c.source_hash OR NEW.snapshot->>'externalVersionId' IS DISTINCT FROM c.external_document_version_id::text OR NEW.snapshot->>'externalHash' IS DISTINCT FROM c.external_document_hash THEN RAISE EXCEPTION 'invalid source snapshot'; END IF;
 RETURN NEW;
END $function$;
