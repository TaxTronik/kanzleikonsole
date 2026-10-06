CREATE OR REPLACE FUNCTION app.guard_structure_version_children()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mandate_structure_version v WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id AND v.xmin=pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'structure version is sealed; save a new version';
 END IF;
 RETURN NEW;
END $function$;
