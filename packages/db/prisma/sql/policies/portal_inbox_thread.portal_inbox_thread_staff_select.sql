CREATE POLICY portal_inbox_thread_staff_select ON public.portal_inbox_thread
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.portal_inbox_staff_access(tenant_id, client_id));
