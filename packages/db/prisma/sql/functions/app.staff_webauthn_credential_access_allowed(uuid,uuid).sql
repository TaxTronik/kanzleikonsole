CREATE OR REPLACE FUNCTION app.staff_webauthn_credential_access_allowed(requested_tenant_id uuid, credential_staff_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT requested_tenant_id = app.current_tenant_id()
     AND CASE app.current_actor_type()
           WHEN 'SYSTEM' THEN TRUE
           WHEN 'STAFF' THEN EXISTS (
             SELECT 1
               FROM public."staff_user" actor
              WHERE actor."tenant_id" = requested_tenant_id
                AND actor."id" = app.current_actor_id()
                AND actor."active" = TRUE
                AND (
                  actor."id" = credential_staff_user_id
                  OR (
                    EXISTS (
                      SELECT 1
                        FROM public."staff_role" actor_role
                       WHERE actor_role."staff_user_id" = actor."id"
                         AND actor_role."role" = 'ADMIN'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM public."staff_role" target_role
                       WHERE target_role."staff_user_id" = credential_staff_user_id
                         AND target_role."role" = 'ADMIN'
                    )
                  )
                  OR (
                    EXISTS (
                      SELECT 1
                        FROM public."staff_role" actor_role
                       WHERE actor_role."staff_user_id" = actor."id"
                         AND actor_role."role" = 'PARTNER'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM public."staff_role" target_role
                       WHERE target_role."staff_user_id" = credential_staff_user_id
                         AND target_role."role" IN ('ADMIN', 'PARTNER')
                    )
                  )
                )
           )
           ELSE FALSE
         END;
$function$;
