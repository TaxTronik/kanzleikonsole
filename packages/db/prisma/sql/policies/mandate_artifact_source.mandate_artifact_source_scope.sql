CREATE POLICY mandate_artifact_source_scope ON public.mandate_artifact_source
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (app.mandate_artifact_allowed(artifact_id))
  WITH CHECK (app.mandate_artifact_allowed(artifact_id));
