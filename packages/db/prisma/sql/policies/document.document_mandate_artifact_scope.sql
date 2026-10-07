CREATE POLICY document_mandate_artifact_scope ON public.document
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((NOT has_mandate_artifact) OR app.mandate_artifact_document_allowed(tenant_id, (id)::text))))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND ((NOT has_mandate_artifact) OR app.mandate_artifact_document_allowed(tenant_id, (id)::text))));
