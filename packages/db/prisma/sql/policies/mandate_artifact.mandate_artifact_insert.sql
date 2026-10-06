CREATE POLICY mandate_artifact_insert ON public.mandate_artifact
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((app.current_actor_type() = 'STAFF'::text) AND (created_by = app.current_actor_id()) AND app.mandate_artifact_row_allowed(tenant_id, client_id, kind, structure_version_id, requires_payroll_access)));
