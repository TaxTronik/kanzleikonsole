CREATE POLICY payroll_employer_grant_staff ON public.payroll_employer_grant
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND app.payroll_staff_intake(intake_id)))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND app.payroll_staff_intake(intake_id)));
