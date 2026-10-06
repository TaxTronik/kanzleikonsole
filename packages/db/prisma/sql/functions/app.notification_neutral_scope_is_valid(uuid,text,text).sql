CREATE OR REPLACE FUNCTION app.notification_neutral_scope_is_valid(p_tenant_id uuid, p_resource_type text, p_resource_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT scope.resource_is_known
         AND scope.resource_was_found
         AND scope.resolved_client_id IS NULL
    FROM app.notification_resource_scope(
      p_tenant_id,
      p_resource_type,
      p_resource_id
    ) scope
$function$;
