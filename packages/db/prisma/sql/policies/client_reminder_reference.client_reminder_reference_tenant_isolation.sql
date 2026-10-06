CREATE POLICY client_reminder_reference_tenant_isolation ON public.client_reminder_reference
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text]))))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text]))));
