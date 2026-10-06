CREATE POLICY form_revision_read ON public.form_submission_revision
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND app.form_revision_scope(submission_id)));
