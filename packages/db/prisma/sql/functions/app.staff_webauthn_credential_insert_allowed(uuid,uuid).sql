CREATE OR REPLACE FUNCTION app.staff_webauthn_credential_insert_allowed(requested_tenant_id uuid, credential_staff_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT requested_tenant_id = app.current_tenant_id()
     AND CASE app.current_actor_type()
           WHEN 'SYSTEM' THEN TRUE
           WHEN 'STAFF' THEN credential_staff_user_id = app.current_actor_id()
             AND EXISTS (
               SELECT 1
                 FROM public."staff_user" actor
                WHERE actor."tenant_id" = requested_tenant_id
                  AND actor."id" = app.current_actor_id()
                  AND actor."active" = TRUE
             )
           ELSE FALSE
         END;
$function$;
