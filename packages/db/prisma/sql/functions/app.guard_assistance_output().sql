CREATE OR REPLACE FUNCTION app.guard_assistance_output()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE c RECORD; r RECORD;
BEGIN
 SELECT * INTO r FROM client_assistance_revision WHERE id=NEW.revision_id;
 SELECT * INTO c FROM client_assistance_case WHERE id=r.case_id;
 IF c.id IS NULL OR NEW.snapshot_hash IS DISTINCT FROM r.snapshot_hash OR r.snapshot_hash='' THEN RAISE EXCEPTION 'invalid output snapshot'; END IF;
 IF TG_OP='INSERT' AND (NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NEW.actor_type IS DISTINCT FROM app.current_actor_type()) THEN RAISE EXCEPTION 'invalid output actor'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.revision_id,NEW.format,NEW.generator_version,NEW.snapshot_hash,NEW.manifest,NEW.created_by,NEW.actor_type,NEW.created_at) IS DISTINCT FROM (OLD.revision_id,OLD.format,OLD.generator_version,OLD.snapshot_hash,OLD.manifest,OLD.created_by,OLD.actor_type,OLD.created_at) THEN RAISE EXCEPTION 'immutable output identity'; END IF;
  IF OLD.status='READY' OR (OLD.status='PENDING' AND (NEW.document_version_id,NEW.output_hash) IS DISTINCT FROM (OLD.document_version_id,OLD.output_hash)) OR NOT ((OLD.status='RESERVED' AND NEW.status='PENDING') OR (OLD.status='PENDING' AND NEW.status='READY')) THEN RAISE EXCEPTION 'invalid output transition'; END IF;
 END IF;
 IF NEW.document_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.document_version_id AND d.tenant_id=c.tenant_id AND d.client_id=c.client_id AND encode(v.sha256,'hex')=NEW.output_hash AND (NEW.status<>'READY' OR (v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL))) THEN RAISE EXCEPTION 'invalid output document'; END IF;
 RETURN NEW;
END $function$;
