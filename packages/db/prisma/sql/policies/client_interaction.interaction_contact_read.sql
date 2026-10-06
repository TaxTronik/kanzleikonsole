CREATE POLICY interaction_contact_read ON public.client_interaction
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'CLIENT_CONTACT'::text) AND (contact_id = app.current_actor_id()) AND (EXISTS ( SELECT 1
   FROM public.client_contact c
  WHERE ((c.id = client_interaction.contact_id) AND (c.client_id = client_interaction.client_id) AND (c.tenant_id = client_interaction.tenant_id) AND c.active)))));
