-- PORTAL-INBOX-SUBMISSION-001 / ACCESS-SEARCH-SCOPE-001
-- Basistabellen bleiben fail-closed für abgelehnte/gesperrte Bytes. Eine
-- separate Projektion liefert nur sichere Metadaten und neutrale Reason-Codes.
BEGIN;

ALTER TABLE public.portal_inbox_attachment
  ALTER COLUMN rejection_reason TYPE VARCHAR(64);
ALTER TABLE public.portal_inbox_attachment
  ADD CONSTRAINT portal_inbox_attachment_rejection_code_check
  CHECK (
    rejection_reason IS NULL
    OR rejection_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'
  );

-- Die frühere Helper-Policy fragte die gerade einzufügende Zeile erneut ab.
-- INSERT ... RETURNING konnte sie deshalb noch nicht sehen. Die direkte
-- Policy prüft ausschließlich Zeilenfelder und den bereits persistierten Batch.
DROP POLICY portal_inbox_attachment_contact_select
  ON public.portal_inbox_attachment;
CREATE POLICY portal_inbox_attachment_contact_select
  ON public.portal_inbox_attachment
  FOR SELECT
  USING (
    app.portal_inbox_contact_access(tenant_id, client_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.portal_inbox_upload_batch batch
        WHERE batch.id = portal_inbox_attachment.batch_id
          AND batch.tenant_id = portal_inbox_attachment.tenant_id
          AND batch.client_id = portal_inbox_attachment.client_id
          AND batch.status = 'OPEN'
          AND batch.created_by_contact_id = app.current_actor_id()
      )
      OR (
        message_id IS NOT NULL
        AND scan_status = 'CLEAN'
        AND decision IN ('PENDING_REVIEW', 'ACCEPTED')
        AND EXISTS (
          SELECT 1 FROM public.portal_inbox_upload_batch batch
          WHERE batch.id = portal_inbox_attachment.batch_id
            AND batch.tenant_id = portal_inbox_attachment.tenant_id
            AND batch.client_id = portal_inbox_attachment.client_id
            AND batch.status = 'CONSUMED'
        )
      )
    )
  );

CREATE FUNCTION app.portal_inbox_attachment_receipts(
  p_tenant_id UUID,
  p_thread_id UUID
) RETURNS TABLE (
  attachment_id UUID,
  message_id UUID,
  original_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  decision public.portal_inbox_attachment_decision,
  rejection_reason TEXT,
  decided_at TIMESTAMPTZ,
  download_allowed BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
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
$$;

REVOKE ALL ON FUNCTION app.portal_inbox_attachment_receipts(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_inbox_attachment_receipts(UUID, UUID) TO taxtronik_app;

COMMIT;
