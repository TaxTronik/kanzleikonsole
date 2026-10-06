CREATE POLICY tenant_self_read ON public.tenant
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((id = app.current_tenant_id()));
