CREATE POLICY campaign_entry_staff ON public.year_end_campaign_entry
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)));
