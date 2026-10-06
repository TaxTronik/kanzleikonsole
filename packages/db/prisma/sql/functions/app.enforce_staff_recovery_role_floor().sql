CREATE OR REPLACE FUNCTION app.enforce_staff_recovery_role_floor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  target_tenant UUID;
  actor_staff_user_id UUID := app.current_actor_id();
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'STAFF' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW."role" IS NOT DISTINCT FROM OLD."role"
     AND NEW."staff_user_id" IS NOT DISTINCT FROM OLD."staff_user_id"
  THEN
    RETURN NEW;
  END IF;

  IF OLD."role"::TEXT = 'ADMIN' THEN
    RAISE EXCEPTION
      'Die ADMIN-Rolle darf durch einen Staff-Akteur nicht entzogen werden.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."role"::TEXT = 'PARTNER' THEN
    SELECT target."tenant_id"
      INTO target_tenant
      FROM public."staff_user" target
     WHERE target."id" = OLD."staff_user_id";

    IF NOT FOUND OR actor_staff_user_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public."staff_user" actor
        JOIN public."staff_role" actor_role
          ON actor_role."staff_user_id" = actor."id"
       WHERE actor."id" = actor_staff_user_id
         AND actor."tenant_id" = target_tenant
         AND actor."active" = TRUE
         AND actor_role."role"::TEXT = 'ADMIN'
    ) THEN
      RAISE EXCEPTION
        'Die PARTNER-Rolle darf nur durch einen aktiven ADMIN desselben Tenants entzogen werden.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
