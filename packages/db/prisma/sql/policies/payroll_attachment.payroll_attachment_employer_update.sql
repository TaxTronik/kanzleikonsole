CREATE POLICY payroll_attachment_employer_update ON public.payroll_attachment
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((app.payroll_employer_access(intake_id) AND (audience = 'EMPLOYER'::text) AND (uploaded_by = app.current_actor_id())))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND app.payroll_employer_access(intake_id) AND (audience = 'EMPLOYER'::text) AND (uploaded_by = app.current_actor_id())));
