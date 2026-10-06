CREATE POLICY portal_inbox_read_staff_select ON public.portal_inbox_read
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.portal_inbox_staff_access(tenant_id, client_id));
