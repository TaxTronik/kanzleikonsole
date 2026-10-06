CREATE OR REPLACE FUNCTION app.portal_inbox_staff_recipient_access(p_tenant_id uuid, p_staff_id uuid, p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT p_tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1
      FROM public.staff_user staff
      JOIN public.client client
        ON client.id = p_client_id
       AND client.tenant_id = p_tenant_id
      WHERE staff.id = p_staff_id
        AND staff.tenant_id = p_tenant_id
        AND staff.active
        AND (
          EXISTS (
            SELECT 1 FROM public.staff_role role
            WHERE role.staff_user_id = staff.id
              AND role.role IN ('ADMIN', 'PARTNER')
          )
          OR EXISTS (
            SELECT 1 FROM public.staff_permission permission
            WHERE permission.staff_user_id = staff.id
              AND permission.permission = 'PORTAL_INBOX_MANAGE'
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM public.staff_role role
            WHERE role.staff_user_id = staff.id
              AND role.role IN ('ADMIN', 'PARTNER')
          )
          OR (
            client.vertraulich = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM public.tenant_setting setting
              WHERE setting.tenant_id = p_tenant_id
                AND setting.key = 'access'
                AND setting.value ->> 'clientAccessMode' = 'RESTRICTED'
            )
          )
          OR EXISTS (
            SELECT 1 FROM public.client_responsibility responsibility
            WHERE responsibility.tenant_id = p_tenant_id
              AND responsibility.client_id = p_client_id
              AND responsibility.staff_id = staff.id
              AND responsibility.role IN ('BERUFSTRAEGER', 'HAUPTBEARBEITER')
          )
        )
    )
$function$;
