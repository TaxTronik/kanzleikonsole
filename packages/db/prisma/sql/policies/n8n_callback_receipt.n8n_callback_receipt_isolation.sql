CREATE POLICY n8n_callback_receipt_isolation ON public.n8n_callback_receipt
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
