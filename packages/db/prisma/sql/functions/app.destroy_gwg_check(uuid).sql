CREATE OR REPLACE FUNCTION app.destroy_gwg_check(p_check_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  check_tenant UUID;
  check_client UUID;
  lifecycle_lock_key TEXT;
BEGIN
  SELECT gc."tenant_id", gc."client_id"
    INTO check_tenant, check_client
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Pruefung nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  IF app.current_tenant_id() IS NULL OR check_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Pruefung gehoert nicht zum aktuellen Tenant.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  lifecycle_lock_key :=
    'gwg-check-lifecycle:' || check_tenant::TEXT || ':' || check_client::TEXT;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(lifecycle_lock_key, 0)
  );

  RETURN app.destroy_gwg_check_locked_impl(p_check_id);
END;
$function$;
