CREATE POLICY portal_inbox_read_contact_update ON public.portal_inbox_read
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (((contact_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)))
  WITH CHECK (((contact_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)));
