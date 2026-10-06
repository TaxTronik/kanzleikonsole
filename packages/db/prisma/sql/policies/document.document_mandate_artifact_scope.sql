CREATE POLICY document_mandate_artifact_scope ON public.document
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (app.mandate_artifact_document_allowed(tenant_id, (id)::text))
  WITH CHECK (app.mandate_artifact_document_allowed(tenant_id, (id)::text));
