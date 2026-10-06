CREATE POLICY portal_inbox_message_system ON public.portal_inbox_message
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'SYSTEM'::text)))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'SYSTEM'::text)));
