CREATE OR REPLACE FUNCTION app.guard_gwg_structure_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE g RECORD; latest_revision INTEGER;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF pg_trigger_depth()>1 AND OLD.destroyed_at IS NULL AND NEW.destroyed_at IS NOT NULL AND NEW.structure_version_id IS NULL AND NEW.structure_hash IS NULL AND NEW.note IS NULL
   AND (to_jsonb(NEW)-'structure_version_id'-'structure_hash'-'note'-'destroyed_at')=(to_jsonb(OLD)-'structure_version_id'-'structure_hash'-'note'-'destroyed_at')
   AND EXISTS(SELECT 1 FROM gwg_check WHERE id=NEW.gwg_check_id AND destroyed_at=NEW.destroyed_at) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'GwG structure bindings are immutable';
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'GwG structure bindings are immutable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('gwg-check-lifecycle:'||NEW.tenant_id::text||':'||NEW.client_id::text,0));
 SELECT * INTO g FROM gwg_check WHERE id=NEW.gwg_check_id FOR UPDATE;
 IF g.id IS NULL OR g.tenant_id<>NEW.tenant_id OR g.client_id<>NEW.client_id OR g.status<>'DRAFT' OR g.destroyed_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM gwg_check newer WHERE newer.client_id=g.client_id AND newer.tenant_id=g.tenant_id AND (newer.created_at,newer.id)>(g.created_at,g.id)) THEN RAISE EXCEPTION 'latest open draft check required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM mandate_structure_version WHERE id=NEW.structure_version_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND content_hash=NEW.structure_hash)
 OR NOT EXISTS(SELECT 1 FROM staff_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id AND active) OR NEW.destroyed_at IS NOT NULL OR NEW.note IS NULL OR length(trim(NEW.note))<10 THEN RAISE EXCEPTION 'invalid bound structure version'; END IF;
 SELECT coalesce(max(revision),0) INTO latest_revision FROM gwg_structure_binding WHERE gwg_check_id=NEW.gwg_check_id;
 IF NEW.revision<>latest_revision+1 THEN RAISE EXCEPTION 'stale structure binding revision'; END IF;
 RETURN NEW;
END $function$;
