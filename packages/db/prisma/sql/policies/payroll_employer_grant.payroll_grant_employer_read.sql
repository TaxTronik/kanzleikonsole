CREATE POLICY payroll_grant_employer_read ON public.payroll_employer_grant
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (contact_id = app.current_actor_id()) AND app.payroll_employer_access(intake_id)));
