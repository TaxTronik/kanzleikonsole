CREATE POLICY n8n_outbox_isolation ON public.n8n_outbox
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK (((tenant_id = app.current_tenant_id()) OR (tenant_id IS NULL)));
