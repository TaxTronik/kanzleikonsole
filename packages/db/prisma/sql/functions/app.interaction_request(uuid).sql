CREATE OR REPLACE FUNCTION app.interaction_request(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.client_interaction i JOIN public.client_contact c ON c.id=app.current_actor_id() AND c.client_id=i.client_id AND c.tenant_id=i.tenant_id AND c.active WHERE i.request_id=p_request_id AND i.tenant_id=app.current_tenant_id() AND app.current_actor_type()='CLIENT_CONTACT');
$function$;
