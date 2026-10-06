CREATE POLICY form_revision_file_insert ON public.form_submission_revision_file
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.form_submission_revision r
  WHERE ((r.id = form_submission_revision_file.revision_id) AND app.form_revision_scope(r.submission_id, true)))));
