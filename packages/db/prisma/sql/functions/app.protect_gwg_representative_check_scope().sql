CREATE OR REPLACE FUNCTION app.protect_gwg_representative_check_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF NEW."gwg_check_id" IS DISTINCT FROM OLD."gwg_check_id" THEN
    RAISE EXCEPTION 'GwG-Vertreter kann nicht in einen anderen Prüfsnapshot verschoben werden.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
