CREATE OR REPLACE FUNCTION app.validate_gwg_person_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.gwg_person_anchor a JOIN public.gwg_person_anchor b ON b.id=NEW.to_anchor_id
 WHERE a.id=NEW.from_anchor_id AND a.tenant_id=NEW.tenant_id AND b.tenant_id=NEW.tenant_id AND a.client_id<>b.client_id) THEN
   RAISE EXCEPTION 'Invalid person link scope';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_user s WHERE s.id=NEW.created_by AND s.tenant_id=NEW.tenant_id) THEN
   RAISE EXCEPTION 'Invalid person link actor';
 END IF;
 RETURN NEW;
END $function$;
