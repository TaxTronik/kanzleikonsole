CREATE POLICY payroll_intake_staff ON public.payroll_intake
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (app.payroll_staff_access(tenant_id, client_id))
  WITH CHECK (app.payroll_staff_access(tenant_id, client_id));
