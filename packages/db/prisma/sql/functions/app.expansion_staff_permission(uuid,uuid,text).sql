CREATE OR REPLACE FUNCTION app.expansion_staff_permission(tid uuid, sid uuid, wanted text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT tid=app.current_tenant_id() AND sid=app.current_actor_id() AND app.current_actor_type()='STAFF'
 AND EXISTS(SELECT 1 FROM public.staff_user s WHERE s.id=sid AND s.tenant_id=tid AND s.active AND (
 EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=sid AND r.role::text IN ('ADMIN','PARTNER'))
 OR EXISTS(SELECT 1 FROM public.staff_permission p WHERE p.staff_user_id=sid AND p.permission::text=wanted)))
$function$;
