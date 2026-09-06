-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Forward-Haertung fuer Staff-WebAuthn-Credentials:
-- - nur Credentials mit ausschliesslich physischen Transporten zaehlen fuer
--   die Zwei-Schluessel-Invariante,
-- - sicherheitsentscheidende Klassifizierungsmerkmale sind nach Registrierung
--   unveraenderlich,
-- - die App widerruft Credentials ausschliesslich per revoked_at und erhaelt
--   deshalb kein physisches DELETE-Recht.

BEGIN;

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

CREATE OR REPLACE FUNCTION app.enforce_staff_hardware_key_minimum()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_tenant UUID;
  target_staff UUID;
  hardware_only_enabled TIMESTAMP(3);
  eligible_credentials INTEGER;
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

  SELECT su."hardware_only_enabled_at"
    INTO hardware_only_enabled
    FROM public."staff_user" su
   WHERE su."tenant_id" = target_tenant
     AND su."id" = target_staff;

  -- Beim Loeschen des Staff-Kontos darf dessen ON DELETE CASCADE nicht durch
  -- die Credential-Invariante blockiert werden.
  IF NOT FOUND OR hardware_only_enabled IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INTEGER
    INTO eligible_credentials
    FROM public."staff_webauthn_credential" credential
   WHERE credential."tenant_id" = target_tenant
     AND credential."staff_user_id" = target_staff
     AND credential."revoked_at" IS NULL
     AND credential."device_type" = 'singleDevice'
     AND credential."backed_up" = FALSE
     AND pg_catalog.cardinality(credential."transports") > 0
     AND credential."transports" <@ ARRAY['ble', 'nfc', 'smart-card', 'usb']::TEXT[];

  IF eligible_credentials < 2 THEN
    RAISE EXCEPTION
      'Hardware-only-Zugang erfordert mindestens zwei aktive, geraetegebundene Sicherheitsschluessel.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app.enforce_staff_hardware_key_minimum() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_staff_hardware_key_minimum() FROM taxtronik_app;

-- Widerruf bleibt ein UPDATE auf revoked_at. Physische Deletes sind weder im
-- Self-Service noch im administrativen Recovery-Pfad erforderlich.
REVOKE DELETE ON TABLE public."staff_webauthn_credential" FROM taxtronik_app;

COMMIT;
