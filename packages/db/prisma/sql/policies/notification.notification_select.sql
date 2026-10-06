CREATE POLICY notification_select ON public.notification
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_actor_is_active(tenant_id, app.current_actor_id()) AND ((staff_id IS NULL) OR (staff_id = app.current_actor_id())) AND (((client_id IS NULL) AND app.notification_neutral_scope_is_valid(tenant_id, resource_type, resource_id)) OR (app.notification_resource_matches_client(tenant_id, resource_type, resource_id, client_id) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)))))));
