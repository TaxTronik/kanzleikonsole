CREATE OR REPLACE FUNCTION app.assign_gwg_person_anchor()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE scope_tenant UUID; scope_client UUID; linked_anchor UUID;
BEGIN
 SELECT tenant_id,client_id INTO scope_tenant,scope_client FROM public.gwg_check WHERE id=NEW.gwg_check_id;
 IF TG_OP='UPDATE' THEN
  IF NEW.person_anchor_id IS NULL AND OLD.person_anchor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.gwg_person_anchor WHERE id=OLD.person_anchor_id) THEN
   RETURN NEW;
  END IF;
 END IF;
 IF TG_TABLE_NAME='gwg_representative' THEN
  IF NEW.linked_beneficial_owner_id IS NOT NULL THEN
    SELECT person_anchor_id INTO linked_anchor FROM public.gwg_beneficial_owner
    WHERE id=NEW.linked_beneficial_owner_id AND gwg_check_id=NEW.gwg_check_id;
    NEW.person_anchor_id:=linked_anchor;
  END IF;
 END IF;
 IF NEW.person_anchor_id IS NULL THEN
   INSERT INTO public.gwg_person_anchor(tenant_id,client_id) VALUES(scope_tenant,scope_client) RETURNING id INTO NEW.person_anchor_id;
 ELSIF NOT EXISTS(SELECT 1 FROM public.gwg_person_anchor WHERE id=NEW.person_anchor_id AND tenant_id=scope_tenant AND client_id=scope_client) THEN
   RAISE EXCEPTION 'Invalid person anchor scope';
 END IF;
 RETURN NEW;
END $function$;
