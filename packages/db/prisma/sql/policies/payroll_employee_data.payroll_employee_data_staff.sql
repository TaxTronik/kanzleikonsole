CREATE POLICY payroll_employee_data_staff ON public.payroll_employee_data
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND app.payroll_staff_intake(intake_id)))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND app.payroll_staff_intake(intake_id)));
