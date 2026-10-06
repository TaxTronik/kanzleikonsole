CREATE OR REPLACE FUNCTION app.notification_staff_can_access_client(p_tenant_id uuid, p_staff_id uuid, p_client_id uuid)
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
      JOIN public."client" client
        ON client."id" = p_client_id
       AND client."tenant_id" = p_tenant_id
     WHERE staff."id" = p_staff_id
       AND staff."tenant_id" = p_tenant_id
       AND staff."active" = TRUE
       AND (
         EXISTS (
           SELECT 1
             FROM public."staff_role" staff_role
            WHERE staff_role."staff_user_id" = staff."id"
              AND staff_role."role" IN (
                'ADMIN'::public."staff_role_name",
                'PARTNER'::public."staff_role_name"
              )
         )
         OR (
           client."vertraulich" = FALSE
           AND NOT EXISTS (
             SELECT 1
               FROM public."tenant_setting" setting
              WHERE setting."tenant_id" = p_tenant_id
                AND setting."key" = 'access'
                AND setting."value" ->> 'clientAccessMode' = 'RESTRICTED'
           )
         )
         OR EXISTS (
           SELECT 1
             FROM public."client_responsibility" responsibility
            WHERE responsibility."tenant_id" = p_tenant_id
              AND responsibility."client_id" = p_client_id
              AND responsibility."staff_id" = p_staff_id
              AND responsibility."role" IN (
                'BERUFSTRAEGER'::public."client_responsibility_role",
                'HAUPTBEARBEITER'::public."client_responsibility_role"
              )
         )
       )
  )
$function$;
