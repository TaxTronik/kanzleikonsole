CREATE POLICY sanctions_source_state_select ON public.sanctions_source_state
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_actor_is_active(tenant_id, app.current_actor_id())))));
