-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Praezisiert die Credential-RLS auf das Least-Privilege-Modell:
-- - aktive Staff-Nutzer verwalten die eigenen Credentials,
-- - aktive ADMIN/PARTNER duerfen Recovery fuer fremde Staff-Konten desselben
--   Tenants durchfuehren,
-- - SYSTEM bleibt fuer tenantgebundene Betriebsablaeufe zugelassen,
-- - CLIENT_CONTACT und tenantfremde Akteure bleiben ausgeschlossen.

BEGIN;

-- Sicherheitsentscheidende Triggerfunktionen brauchen keine frei aufloesbaren
-- Anwendungs-Schemas im search_path; alle Relationen sind voll qualifiziert.
ALTER FUNCTION app.lock_staff_hardware_auth_state()
  SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION app.enforce_staff_hardware_key_minimum()
  SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION app.staff_webauthn_credential_access_allowed(
  requested_tenant_id UUID,
  credential_staff_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT requested_tenant_id = app.current_tenant_id()
     AND CASE app.current_actor_type()
           WHEN 'SYSTEM' THEN TRUE
           WHEN 'STAFF' THEN EXISTS (
             SELECT 1
               FROM public."staff_user" actor
              WHERE actor."tenant_id" = requested_tenant_id
                AND actor."id" = app.current_actor_id()
                AND actor."active" = TRUE
                AND (
                  actor."id" = credential_staff_user_id
                  OR EXISTS (
                    SELECT 1
                      FROM public."staff_role" actor_role
                     WHERE actor_role."staff_user_id" = actor."id"
                       AND actor_role."role" IN ('ADMIN', 'PARTNER')
                  )
                )
           )
           ELSE FALSE
         END;
$$;

REVOKE ALL ON FUNCTION app.staff_webauthn_credential_access_allowed(UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.staff_webauthn_credential_access_allowed(UUID, UUID)
  TO taxtronik_app;

DROP POLICY "staff_webauthn_credential_tenant_isolation"
  ON public."staff_webauthn_credential";

CREATE POLICY "staff_webauthn_credential_least_privilege"
  ON public."staff_webauthn_credential"
  FOR ALL
  USING (
    app.staff_webauthn_credential_access_allowed("tenant_id", "staff_user_id")
  )
  WITH CHECK (
    app.staff_webauthn_credential_access_allowed("tenant_id", "staff_user_id")
  );

COMMIT;
