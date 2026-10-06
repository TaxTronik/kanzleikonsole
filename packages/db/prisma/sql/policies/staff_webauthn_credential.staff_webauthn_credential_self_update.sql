CREATE POLICY staff_webauthn_credential_self_update ON public.staff_webauthn_credential
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (app.staff_webauthn_credential_insert_allowed(tenant_id, staff_user_id))
  WITH CHECK (app.staff_webauthn_credential_insert_allowed(tenant_id, staff_user_id));
