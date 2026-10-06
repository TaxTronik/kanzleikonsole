CREATE OR REPLACE FUNCTION app.form_revision_scope(sid uuid, write_access boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.form_submission s WHERE s.id=sid AND s.tenant_id=app.current_tenant_id() AND
 ((app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(s.tenant_id,app.current_actor_id(),s.client_id))
 OR (NOT write_access AND app.current_actor_type()='CLIENT_CONTACT' AND EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=app.current_actor_id() AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id AND c.active))));
$function$;
