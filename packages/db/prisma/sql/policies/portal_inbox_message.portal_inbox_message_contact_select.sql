CREATE POLICY portal_inbox_message_contact_select ON public.portal_inbox_message
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.portal_inbox_contact_access(tenant_id, client_id));
