CREATE OR REPLACE FUNCTION app.portal_inbox_contact_access(p_tenant_id uuid, p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT p_tenant_id = app.current_tenant_id()
    AND app.current_actor_type() = 'CLIENT_CONTACT'
    AND EXISTS (
      SELECT 1
      FROM public.client_contact contact
      JOIN public.client client
        ON client.id = contact.client_id
       AND client.tenant_id = contact.tenant_id
      JOIN public.tenant_setting setting
        ON setting.tenant_id = contact.tenant_id
       AND setting.key = 'portal.features'
      WHERE contact.id = app.current_actor_id()
        AND contact.tenant_id = p_tenant_id
        AND contact.client_id = p_client_id
        AND contact.active
        AND client.allow_active
        AND client.mandate_ended_at IS NULL
        AND client.anonymized_at IS NULL
        AND setting.value ->> 'clientInbox' = 'true'
    )
$function$;
