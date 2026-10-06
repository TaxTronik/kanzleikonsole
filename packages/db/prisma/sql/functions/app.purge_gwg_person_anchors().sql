CREATE OR REPLACE FUNCTION app.purge_gwg_person_anchors()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE target_client UUID;
BEGIN
 IF TG_TABLE_NAME='client' THEN target_client:=NEW.id; ELSE target_client:=NEW.client_id; END IF;
 DELETE FROM public.gwg_person_link l WHERE EXISTS (
 SELECT 1 FROM public.gwg_person_anchor a WHERE a.client_id=target_client AND a.id IN(l.from_anchor_id,l.to_anchor_id) AND (
  (TG_TABLE_NAME='client') OR (
   NOT EXISTS(SELECT 1 FROM public.gwg_beneficial_owner o JOIN public.gwg_check g ON g.id=o.gwg_check_id WHERE o.person_anchor_id=a.id AND g.destroyed_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM public.gwg_representative r JOIN public.gwg_check g ON g.id=r.gwg_check_id WHERE r.person_anchor_id=a.id AND g.destroyed_at IS NULL)
   AND (a.natural_client_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.gwg_check g WHERE g.client_id=target_client AND g.destroyed_at IS NULL))
  )));
 DELETE FROM public.gwg_person_anchor a WHERE a.client_id=target_client
 AND NOT EXISTS(SELECT 1 FROM public.gwg_beneficial_owner o WHERE o.person_anchor_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM public.gwg_representative r WHERE r.person_anchor_id=a.id)
 AND (a.natural_client_id IS NULL OR TG_TABLE_NAME='client' OR NOT EXISTS(SELECT 1 FROM public.gwg_check g WHERE g.client_id=target_client AND g.destroyed_at IS NULL));
 RETURN NEW;
END $function$;
