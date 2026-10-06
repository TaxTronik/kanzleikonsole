CREATE POLICY portal_inbox_message_staff_insert ON public.portal_inbox_message
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((author_type = 'STAFF'::public.portal_inbox_author_type) AND (author_id = app.current_actor_id()) AND app.portal_inbox_staff_access(tenant_id, client_id)));
