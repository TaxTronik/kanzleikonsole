CREATE OR REPLACE FUNCTION app.protect_gwg_check_lineage_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF ROW(
       NEW."tenant_id",
       NEW."client_id",
       NEW."change_scope",
       NEW."predecessor_check_id",
       NEW."created_at"
     )
       IS DISTINCT FROM
     ROW(
       OLD."tenant_id",
       OLD."client_id",
       OLD."change_scope",
       OLD."predecessor_check_id",
       OLD."created_at"
     )
  THEN
    RAISE EXCEPTION 'GwG-Prüfungsscope, Prüfungsanlass und Vorgänger sind nach Anlage unveränderlich.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
