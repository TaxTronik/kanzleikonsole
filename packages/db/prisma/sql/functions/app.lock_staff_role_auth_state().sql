CREATE OR REPLACE FUNCTION app.lock_staff_role_auth_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  target_staff UUID;
  target_tenant UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."staff_user_id" IS DISTINCT FROM OLD."staff_user_id" THEN
    RAISE EXCEPTION 'Staff-Rollenidentitaet ist unveraenderlich.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_staff := OLD."staff_user_id";
  ELSE
    target_staff := NEW."staff_user_id";
  END IF;

  SELECT staff."tenant_id"
    INTO target_tenant
    FROM public."staff_user" staff
   WHERE staff."id" = target_staff;

  -- Beim ON-DELETE-CASCADE kann der Parent bereits unsichtbar sein. Dessen
  -- eigener Row-Lock serialisiert den Kontoloeschpfad bereits.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff::TEXT,
      0
    )
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
