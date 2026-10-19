CREATE POLICY tcms_nachricht_zustellung_isolation ON public.tcms_nachricht_zustellung
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
