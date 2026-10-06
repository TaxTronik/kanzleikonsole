CREATE OR REPLACE FUNCTION app.guard_gwg_cross_role_person_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF NEW."linked_beneficial_owner_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public."gwg_beneficial_owner" owner
     WHERE owner."id" = NEW."linked_beneficial_owner_id"
       AND owner."gwg_check_id" = NEW."gwg_check_id"
  ) THEN
    RAISE EXCEPTION 'Verknüpfte Rollenidentität gehört nicht zu diesem GwG-Snapshot.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$function$;
