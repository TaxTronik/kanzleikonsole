CREATE OR REPLACE FUNCTION app.portal_inbox_unique_assignee(p_tenant_id uuid, p_client_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(candidate.staff_id))[1] ELSE NULL END
  FROM (
    SELECT DISTINCT responsibility.staff_id
    FROM public.client_responsibility responsibility
    WHERE responsibility.tenant_id = p_tenant_id
      AND responsibility.client_id = p_client_id
      AND responsibility.role = 'HAUPTBEARBEITER'
      AND app.portal_inbox_staff_recipient_access(
        p_tenant_id,
        responsibility.staff_id,
        p_client_id
      )
  ) candidate
$function$;
