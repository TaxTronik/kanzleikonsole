CREATE POLICY staff_webauthn_credential_hierarchical_select ON public.staff_webauthn_credential
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (app.staff_webauthn_credential_access_allowed(tenant_id, staff_user_id));
