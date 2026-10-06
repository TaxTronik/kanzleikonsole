CREATE POLICY gwg_structure_binding_read ON public.gwg_structure_binding
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.gwg_structure_binding_allowed(tenant_id, client_id, gwg_check_id, structure_version_id));
