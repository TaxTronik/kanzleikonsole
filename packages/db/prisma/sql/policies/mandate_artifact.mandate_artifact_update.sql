CREATE POLICY mandate_artifact_update ON public.mandate_artifact
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (app.mandate_artifact_row_allowed(tenant_id, client_id, kind, structure_version_id, requires_payroll_access))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
