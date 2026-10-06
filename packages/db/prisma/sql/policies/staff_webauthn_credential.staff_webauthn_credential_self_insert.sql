CREATE POLICY staff_webauthn_credential_self_insert ON public.staff_webauthn_credential
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (app.staff_webauthn_credential_insert_allowed(tenant_id, staff_user_id));
