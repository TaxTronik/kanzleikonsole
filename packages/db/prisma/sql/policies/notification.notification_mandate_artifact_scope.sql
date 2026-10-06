CREATE POLICY notification_mandate_artifact_scope ON public.notification
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (((resource_type IS DISTINCT FROM 'document'::text) OR app.mandate_artifact_document_allowed(tenant_id, resource_id)))
  WITH CHECK (((resource_type IS DISTINCT FROM 'document'::text) OR app.mandate_artifact_document_allowed(tenant_id, resource_id)));
