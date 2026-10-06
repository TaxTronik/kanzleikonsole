CREATE POLICY portal_inbox_batch_contact_select ON public.portal_inbox_upload_batch
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((created_by_contact_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)));
