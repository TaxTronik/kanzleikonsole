CREATE OR REPLACE FUNCTION app.portal_inbox_staff_access(p_tenant_id uuid, p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT p_tenant_id = app.current_tenant_id()
    AND app.current_actor_type() = 'STAFF'
    AND app.expansion_staff_permission(
      p_tenant_id,
      app.current_actor_id(),
      'PORTAL_INBOX_MANAGE'
    )
    AND app.notification_staff_can_access_client(
      p_tenant_id,
      app.current_actor_id(),
      p_client_id
    )
$function$;
