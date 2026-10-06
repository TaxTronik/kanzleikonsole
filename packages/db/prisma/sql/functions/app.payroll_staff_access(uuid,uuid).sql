CREATE OR REPLACE FUNCTION app.payroll_staff_access(tid uuid, cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 SELECT tid=app.current_tenant_id() AND app.current_actor_type()='STAFF'
  AND app.expansion_staff_permission(tid,app.current_actor_id(),'PAYROLL_MANAGE')
  AND app.notification_staff_can_access_client(tid,app.current_actor_id(),cid);
$function$;
