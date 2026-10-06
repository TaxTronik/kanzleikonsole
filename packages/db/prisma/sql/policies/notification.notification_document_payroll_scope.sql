CREATE POLICY notification_document_payroll_scope ON public.notification
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (((resource_type IS DISTINCT FROM 'document'::text) OR app.document_payroll_scope_allowed(tenant_id, resource_id)))
  WITH CHECK (((resource_type IS DISTINCT FROM 'document'::text) OR app.document_payroll_scope_allowed(tenant_id, resource_id)));
