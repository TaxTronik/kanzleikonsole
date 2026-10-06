CREATE POLICY portal_inbox_thread_contact_select ON public.portal_inbox_thread
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.portal_inbox_contact_access(tenant_id, client_id));
