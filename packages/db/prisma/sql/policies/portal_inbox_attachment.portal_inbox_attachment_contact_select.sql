CREATE POLICY portal_inbox_attachment_contact_select ON public.portal_inbox_attachment
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((app.portal_inbox_owned_open_batch(batch_id) OR ((message_id IS NOT NULL) AND (scan_status = 'CLEAN'::public.portal_inbox_attachment_scan_status) AND (decision = ANY (ARRAY['PENDING_REVIEW'::public.portal_inbox_attachment_decision, 'ACCEPTED'::public.portal_inbox_attachment_decision])) AND app.portal_inbox_consumed_batch(batch_id, tenant_id, client_id))));
