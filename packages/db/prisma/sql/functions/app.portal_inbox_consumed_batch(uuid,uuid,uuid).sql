CREATE OR REPLACE FUNCTION app.portal_inbox_consumed_batch(p_batch_id uuid, p_tenant_id uuid, p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT app.portal_inbox_contact_access(p_tenant_id, p_client_id)
    AND EXISTS (
      SELECT 1 FROM public.portal_inbox_upload_batch batch
      WHERE batch.id = p_batch_id
        AND batch.tenant_id = p_tenant_id
        AND batch.client_id = p_client_id
        AND batch.status = 'CONSUMED'
    )
$function$;
