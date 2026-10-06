CREATE POLICY document_payroll_restriction ON public.document
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (((NOT requires_payroll_access) OR (app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.expansion_staff_permission(tenant_id, app.current_actor_id(), 'PAYROLL_MANAGE'::text))))
  WITH CHECK (((NOT requires_payroll_access) OR (app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND app.expansion_staff_permission(tenant_id, app.current_actor_id(), 'PAYROLL_MANAGE'::text))));
