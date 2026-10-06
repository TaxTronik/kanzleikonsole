CREATE OR REPLACE FUNCTION app.lock_staff_account_recovery(target_staff_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  target_tenant UUID;
BEGIN
  SELECT target."tenant_id"
    INTO target_tenant
    FROM public."staff_user" target
   WHERE target."id" = target_staff_user_id;

  IF NOT FOUND OR target_tenant IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'Staff-Recovery-Ziel ist fuer diesen Tenant nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF app.current_actor_type() = 'STAFF' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public."staff_user" actor
        JOIN public."staff_role" actor_role
          ON actor_role."staff_user_id" = actor."id"
       WHERE actor."tenant_id" = target_tenant
         AND actor."id" = app.current_actor_id()
         AND actor."active" = TRUE
         AND actor_role."role" IN ('ADMIN', 'PARTNER')
    ) THEN
      RAISE EXCEPTION 'Staff-Recovery-Lock ist fuer diesen Akteur nicht zulaessig.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF app.current_actor_type() <> 'SYSTEM' THEN
    RAISE EXCEPTION 'Staff-Recovery-Lock ist fuer diesen Akteur nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff_user_id::TEXT,
      0
    )
  );
END;
$function$;
