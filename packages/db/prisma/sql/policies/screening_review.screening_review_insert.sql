CREATE POLICY screening_review_insert ON public.screening_review
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)) AND (created_by = app.current_actor_id())));
