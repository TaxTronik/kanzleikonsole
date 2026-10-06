CREATE OR REPLACE FUNCTION app.notification_resource_matches_client(p_tenant_id uuid, p_resource_type text, p_resource_id text, p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT scope.resource_is_known
         AND scope.resource_was_found
         AND scope.resolved_client_id = p_client_id
    FROM app.notification_resource_scope(
      p_tenant_id,
      p_resource_type,
      p_resource_id
    ) scope
$function$;
