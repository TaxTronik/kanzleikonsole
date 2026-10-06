CREATE OR REPLACE FUNCTION app.validate_gwg_person_anchor()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.tenant_id,NEW.client_id,NEW.natural_client_id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.client_id,OLD.natural_client_id) THEN
   RAISE EXCEPTION 'Person anchor scope is immutable';
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.client c WHERE c.id=NEW.client_id AND c.tenant_id=NEW.tenant_id AND c.anonymized_at IS NULL) THEN
   RAISE EXCEPTION 'Invalid person anchor scope';
 END IF;
 RETURN NEW;
END $function$;
