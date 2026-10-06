CREATE OR REPLACE FUNCTION app.purge_gwg_structure_bindings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF OLD.destroyed_at IS NULL AND NEW.destroyed_at IS NOT NULL THEN
  UPDATE gwg_structure_binding SET structure_version_id=NULL,structure_hash=NULL,note=NULL,destroyed_at=NEW.destroyed_at WHERE gwg_check_id=NEW.id AND destroyed_at IS NULL;
 END IF;
 RETURN NEW;
END $function$;
