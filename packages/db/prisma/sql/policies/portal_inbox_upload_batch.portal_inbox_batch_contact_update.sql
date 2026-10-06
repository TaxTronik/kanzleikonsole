CREATE POLICY portal_inbox_batch_contact_update ON public.portal_inbox_upload_batch
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (((created_by_contact_id = app.current_actor_id()) AND (status = 'OPEN'::public.portal_inbox_upload_batch_status) AND app.portal_inbox_contact_access(tenant_id, client_id)))
  WITH CHECK (((created_by_contact_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)));
