CREATE OR REPLACE FUNCTION app.ensure_gwg_natural_person_anchor()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.gwg_person_anchor(tenant_id,client_id,natural_client_id)
 SELECT c.tenant_id,c.id,c.id FROM public.client c WHERE c.id=NEW.client_id AND c.kind='NATPERS' AND c.anonymized_at IS NULL
 ON CONFLICT(natural_client_id) DO NOTHING;
 RETURN NEW;
END $function$;
