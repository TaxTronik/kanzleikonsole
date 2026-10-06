CREATE OR REPLACE FUNCTION app.prevent_modification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
    RAISE EXCEPTION 'Tabelle % ist append-only und darf weder geändert noch gelöscht werden (Operation: %)',
        TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$function$;
