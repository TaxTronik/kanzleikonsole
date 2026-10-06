CREATE POLICY portal_inbox_thread_contact_insert ON public.portal_inbox_thread
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((created_by_contact_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)));
