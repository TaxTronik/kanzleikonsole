CREATE POLICY inbound_message_access ON public.inbound_message
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM public.inbound_mailbox b
  WHERE (b.id = inbound_message.mailbox_id))) AND ((app.current_actor_type() = 'SYSTEM'::text) OR app.inbound_message_staff_visible(app.current_tenant_id(), app.current_actor_id(), id))))
  WITH CHECK (((app.current_actor_type() = 'SYSTEM'::text) AND (EXISTS ( SELECT 1
   FROM public.inbound_mailbox b
  WHERE (b.id = inbound_message.mailbox_id)))));
