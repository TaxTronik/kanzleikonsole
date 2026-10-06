CREATE POLICY gwg_structure_binding_create ON public.gwg_structure_binding
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((created_by = app.current_actor_id()) AND (app.current_actor_type() = 'STAFF'::text) AND app.gwg_structure_binding_allowed(tenant_id, client_id, gwg_check_id, structure_version_id)));
