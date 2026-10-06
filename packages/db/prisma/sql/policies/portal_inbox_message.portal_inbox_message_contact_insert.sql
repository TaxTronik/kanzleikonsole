CREATE POLICY portal_inbox_message_contact_insert ON public.portal_inbox_message
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((author_type = 'CLIENT_CONTACT'::public.portal_inbox_author_type) AND (author_id = app.current_actor_id()) AND app.portal_inbox_contact_access(tenant_id, client_id)));
