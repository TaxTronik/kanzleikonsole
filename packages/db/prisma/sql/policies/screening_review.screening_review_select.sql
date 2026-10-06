CREATE POLICY screening_review_select ON public.screening_review
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)))));
