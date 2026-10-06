CREATE OR REPLACE FUNCTION app.portal_inbox_owned_open_batch(p_batch_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.portal_inbox_upload_batch batch
    WHERE batch.id = p_batch_id
      AND batch.created_by_contact_id = app.current_actor_id()
      AND batch.status = 'OPEN'
      AND batch.expires_at > CURRENT_TIMESTAMP
      AND app.portal_inbox_contact_access(batch.tenant_id, batch.client_id)
  )
$function$;
