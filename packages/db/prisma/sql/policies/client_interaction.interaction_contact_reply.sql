CREATE POLICY interaction_contact_reply ON public.client_interaction
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'CLIENT_CONTACT'::text) AND (contact_id = app.current_actor_id()) AND (EXISTS ( SELECT 1
   FROM public.client_contact c
  WHERE ((c.id = client_interaction.contact_id) AND (c.client_id = client_interaction.client_id) AND c.active)))))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (contact_id = app.current_actor_id())));
