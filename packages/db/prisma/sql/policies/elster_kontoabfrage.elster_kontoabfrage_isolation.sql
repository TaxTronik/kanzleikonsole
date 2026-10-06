CREATE POLICY elster_kontoabfrage_isolation ON public.elster_kontoabfrage
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
