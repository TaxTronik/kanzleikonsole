CREATE POLICY portal_inbox_attachment_staff_select ON public.portal_inbox_attachment
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.portal_inbox_staff_access(tenant_id, client_id));
