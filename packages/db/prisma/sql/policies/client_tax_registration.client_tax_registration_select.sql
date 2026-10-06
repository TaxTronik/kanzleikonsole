CREATE POLICY client_tax_registration_select ON public.client_tax_registration
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)) OR ((app.current_actor_type() = 'CLIENT_CONTACT'::text) AND (EXISTS ( SELECT 1
   FROM public.client_contact c
  WHERE ((c.id = app.current_actor_id()) AND (c.tenant_id = client_tax_registration.tenant_id) AND (c.client_id = client_tax_registration.client_id) AND c.active)))))));
