CREATE POLICY portal_inbox_read_contact_select ON public.portal_inbox_read
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((contact_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)));
