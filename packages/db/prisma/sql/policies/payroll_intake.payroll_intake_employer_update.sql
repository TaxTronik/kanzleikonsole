CREATE POLICY payroll_intake_employer_update ON public.payroll_intake
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (app.payroll_employer_access(id))
  WITH CHECK (app.payroll_employer_access(id));
