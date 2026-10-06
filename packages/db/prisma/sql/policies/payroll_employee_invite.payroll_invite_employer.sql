CREATE POLICY payroll_invite_employer ON public.payroll_employee_invite
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (app.payroll_employer_access(intake_id))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND app.payroll_employer_access(intake_id)));
