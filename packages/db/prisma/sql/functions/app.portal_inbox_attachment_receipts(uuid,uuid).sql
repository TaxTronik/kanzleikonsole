CREATE OR REPLACE FUNCTION app.portal_inbox_attachment_receipts(p_tenant_id uuid, p_thread_id uuid)
 RETURNS TABLE(attachment_id uuid, message_id uuid, original_name text, mime_type text, size_bytes bigint, decision public.portal_inbox_attachment_decision, rejection_reason text, decided_at timestamp with time zone, download_allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  thread_client_id UUID;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'
     OR app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Nur ein tenantgebundener Portal-Kontakt darf Inbox-Quittungen lesen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT thread.client_id INTO thread_client_id
    FROM public.portal_inbox_thread thread
   WHERE thread.id = p_thread_id
     AND thread.tenant_id = p_tenant_id;
  IF NOT FOUND OR NOT app.portal_inbox_contact_access(p_tenant_id, thread_client_id) THEN
    RAISE EXCEPTION 'Inbox-Thread gehört nicht zum aktuellen Portal-Mandanten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT attachment.id,
           attachment.message_id,
           attachment.original_name::TEXT,
           attachment.mime_type::TEXT,
           attachment.size_bytes,
           attachment.decision,
           CASE WHEN attachment.decision = 'REJECTED'
             THEN attachment.rejection_reason::TEXT ELSE NULL END,
           attachment.decided_at,
           attachment.decision IN ('PENDING_REVIEW', 'ACCEPTED')
      FROM public.portal_inbox_attachment attachment
      JOIN public.portal_inbox_upload_batch batch
        ON batch.id = attachment.batch_id
       AND batch.tenant_id = attachment.tenant_id
       AND batch.client_id = attachment.client_id
      JOIN public.portal_inbox_message message
        ON message.id = attachment.message_id
       AND message.tenant_id = attachment.tenant_id
       AND message.client_id = attachment.client_id
     WHERE attachment.tenant_id = p_tenant_id
       AND attachment.client_id = thread_client_id
       AND message.thread_id = p_thread_id
       AND batch.status = 'CONSUMED'
       AND attachment.scan_status = 'CLEAN'
       AND attachment.decision IN ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED')
     ORDER BY message.created_at, attachment.position, attachment.id;
END;
$function$;
