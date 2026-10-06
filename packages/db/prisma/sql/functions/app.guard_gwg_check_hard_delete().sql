CREATE OR REPLACE FUNCTION app.guard_gwg_check_hard_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- Das Skelett ist der Vernichtungsnachweis. Nur die FK-Kaskade eines bereits
  -- geloeschten Tenants darf den Datensatz physisch mit entfernen.
  IF EXISTS (
    SELECT 1 FROM public."tenant" t WHERE t."id" = OLD."tenant_id"
  ) THEN
    RAISE EXCEPTION 'GwG-Check darf nicht hart geloescht werden; kontrollierte Vernichtung verwenden.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$function$;
