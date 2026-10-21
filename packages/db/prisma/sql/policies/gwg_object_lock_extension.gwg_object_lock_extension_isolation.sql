CREATE POLICY gwg_object_lock_extension_isolation ON public.gwg_object_lock_extension
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
