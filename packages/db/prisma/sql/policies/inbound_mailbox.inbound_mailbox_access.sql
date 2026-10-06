CREATE POLICY inbound_mailbox_access ON public.inbound_mailbox
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.expansion_staff_permission(tenant_id, app.current_actor_id(), 'INBOUND_MAIL_MANAGE'::text)))))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.expansion_staff_permission(tenant_id, app.current_actor_id(), 'INBOUND_MAIL_MANAGE'::text)))));
