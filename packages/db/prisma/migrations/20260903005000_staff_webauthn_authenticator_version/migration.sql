-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Persistiert die bei der Registrierung serverseitig attestierte
-- Authenticator-/Firmware-Version. Bestandsdaten bleiben NULL und werden von
-- der Trust-Policy fail-closed behandelt.

BEGIN;

ALTER TABLE public."staff_webauthn_credential"
  ADD COLUMN "authenticator_version" BIGINT,
  ADD CONSTRAINT "staff_webauthn_authenticator_version_range_check"
    CHECK (
      "authenticator_version" IS NULL
      OR "authenticator_version" BETWEEN 0 AND 4294967295
    );

COMMENT ON COLUMN public."staff_webauthn_credential"."authenticator_version" IS
  'Bei der Registrierung serverseitig attestierte Authenticator-/Firmware-Version (uint32); NULL fuer Bestandsdaten ohne verifizierte Provenienz.';

CREATE OR REPLACE FUNCTION app.lock_staff_hardware_auth_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_tenant UUID;
  target_staff UUID;
BEGIN
  IF TG_TABLE_NAME = 'staff_user' THEN
    target_tenant := NEW."tenant_id";
    target_staff := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_tenant := OLD."tenant_id";
    target_staff := OLD."staff_user_id";
  ELSE
    target_tenant := NEW."tenant_id";
    target_staff := NEW."staff_user_id";
  END IF;

  IF TG_TABLE_NAME = 'staff_webauthn_credential' AND TG_OP = 'UPDATE' THEN
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."staff_user_id" IS DISTINCT FROM OLD."staff_user_id"
       OR NEW."credential_id" IS DISTINCT FROM OLD."credential_id"
       OR NEW."public_key" IS DISTINCT FROM OLD."public_key"
       OR NEW."webauthn_user_id" IS DISTINCT FROM OLD."webauthn_user_id"
       OR NEW."transports" IS DISTINCT FROM OLD."transports"
       OR NEW."device_type" IS DISTINCT FROM OLD."device_type"
       OR NEW."backed_up" IS DISTINCT FROM OLD."backed_up"
       OR NEW."attestation_verified_at" IS DISTINCT FROM OLD."attestation_verified_at"
       OR NEW."attestation_format" IS DISTINCT FROM OLD."attestation_format"
       OR NEW."authenticator_version" IS DISTINCT FROM OLD."authenticator_version"
       OR NEW."aaguid" IS DISTINCT FROM OLD."aaguid"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'WebAuthn-Credential-Identitaet ist unveraenderlich.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff::TEXT,
      0
    )
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.lock_staff_hardware_auth_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_staff_hardware_auth_state() FROM taxtronik_app;

COMMIT;
