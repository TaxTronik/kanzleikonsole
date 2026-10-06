CREATE OR REPLACE FUNCTION app.guard_gwg_check_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  predecessor_tenant UUID;
  predecessor_client UUID;
  predecessor_created_at TIMESTAMP(3);
BEGIN
  IF NEW."predecessor_check_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT predecessor."tenant_id", predecessor."client_id", predecessor."created_at"
    INTO predecessor_tenant, predecessor_client, predecessor_created_at
    FROM public."gwg_check" predecessor
   WHERE predecessor."id" = NEW."predecessor_check_id";

  IF predecessor_tenant IS NULL
     OR predecessor_tenant IS DISTINCT FROM NEW."tenant_id"
     OR predecessor_client IS DISTINCT FROM NEW."client_id"
     OR predecessor_created_at >= NEW."created_at"
  THEN
    RAISE EXCEPTION 'GwG-Vorgänger muss eine ältere Prüfung desselben Mandanten sein.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$function$;
