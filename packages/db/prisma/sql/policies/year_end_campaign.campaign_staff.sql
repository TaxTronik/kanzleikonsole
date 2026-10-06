CREATE POLICY campaign_staff ON public.year_end_campaign
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_actor_is_active(tenant_id, app.current_actor_id())))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_actor_is_active(tenant_id, app.current_actor_id())));
