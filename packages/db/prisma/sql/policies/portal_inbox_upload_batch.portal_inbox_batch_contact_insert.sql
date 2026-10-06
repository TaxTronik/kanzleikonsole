CREATE POLICY portal_inbox_batch_contact_insert ON public.portal_inbox_upload_batch
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((created_by_contact_id = app.current_actor_id()) AND (status = 'OPEN'::public.portal_inbox_upload_batch_status) AND app.portal_inbox_contact_access(tenant_id, client_id)));
