CREATE POLICY payroll_attachment_employer_read ON public.payroll_attachment
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((app.payroll_employer_access(intake_id) AND (audience = 'EMPLOYER'::text) AND (uploaded_by = app.current_actor_id())));
