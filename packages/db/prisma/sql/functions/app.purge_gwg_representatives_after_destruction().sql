CREATE OR REPLACE FUNCTION app.purge_gwg_representatives_after_destruction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  authorized_check_destruction BOOLEAN;
BEGIN
  authorized_check_destruction := COALESCE((
    current_setting('app.gwg_destroy_check_id', TRUE) = OLD."id"::TEXT
    AND CURRENT_USER = (
      SELECT pg_get_userbyid(p.proowner)
        FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
    )
  ), FALSE);

  IF NOT authorized_check_destruction THEN
    RAISE EXCEPTION 'GwG-Vertreter duerfen nur kontrolliert vernichtet werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  DELETE FROM public."gwg_representative"
   WHERE "gwg_check_id" = NEW."id";
  RETURN NEW;
END;
$function$;
