CREATE POLICY mandate_offboarding_document_isolation ON public.mandate_offboarding_document
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
