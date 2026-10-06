CREATE POLICY payroll_intake_employer_read ON public.payroll_intake
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.payroll_employer_access(id));
