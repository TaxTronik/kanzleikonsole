CREATE OR REPLACE FUNCTION app.notification_staff_actor_is_active(p_tenant_id uuid, p_staff_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT p_tenant_id = app.current_tenant_id()
         AND p_staff_id = app.current_actor_id()
         AND EXISTS (
    SELECT 1
      FROM public."staff_user" staff
     WHERE staff."id" = p_staff_id
       AND staff."tenant_id" = p_tenant_id
       AND staff."active" = TRUE
  )
$function$;
