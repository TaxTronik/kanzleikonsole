CREATE POLICY mandate_artifact_read ON public.mandate_artifact
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.mandate_artifact_row_allowed(tenant_id, client_id, kind, structure_version_id, requires_payroll_access));
