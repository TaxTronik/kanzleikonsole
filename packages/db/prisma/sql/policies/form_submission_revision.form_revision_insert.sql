CREATE POLICY form_revision_insert ON public.form_submission_revision
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND app.form_revision_scope(submission_id, true)));
