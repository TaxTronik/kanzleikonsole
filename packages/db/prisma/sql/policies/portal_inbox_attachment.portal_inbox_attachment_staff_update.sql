CREATE POLICY portal_inbox_attachment_staff_update ON public.portal_inbox_attachment
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (app.portal_inbox_staff_access(tenant_id, client_id))
  WITH CHECK (app.portal_inbox_staff_access(tenant_id, client_id));
