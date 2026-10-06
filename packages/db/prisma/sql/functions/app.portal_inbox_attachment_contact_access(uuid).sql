CREATE OR REPLACE FUNCTION app.portal_inbox_attachment_contact_access(p_attachment_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.portal_inbox_attachment attachment
    JOIN public.portal_inbox_upload_batch batch ON batch.id = attachment.batch_id
    WHERE attachment.id = p_attachment_id
      AND batch.tenant_id = attachment.tenant_id
      AND batch.client_id = attachment.client_id
      AND app.portal_inbox_contact_access(attachment.tenant_id, attachment.client_id)
      AND (
        (
          batch.status = 'OPEN'
          AND batch.created_by_contact_id = app.current_actor_id()
        )
        OR (
          batch.status = 'CONSUMED'
          AND attachment.message_id IS NOT NULL
          AND attachment.scan_status = 'CLEAN'
          AND attachment.decision IN ('PENDING_REVIEW', 'ACCEPTED')
        )
      )
  )
$function$;
