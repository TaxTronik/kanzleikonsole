-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Spiegelt die Recovery-Hierarchie der Staff-Actions in der Credential-RLS:
-- - jeder aktive Staff-Nutzer darf die eigenen Credentials verwalten,
-- - ADMIN darf fremde EMPLOYEE-/PARTNER-, aber keine ADMIN-Credentials verwalten,
-- - PARTNER darf nur fremde EMPLOYEE-Credentials verwalten,
-- - SYSTEM bleibt innerhalb des gesetzten Tenants zugelassen.

BEGIN;

ALTER TABLE public."staff_webauthn_credential"
  ADD COLUMN "attestation_verified_at" TIMESTAMP(3) NOT NULL,
  ADD COLUMN "attestation_format" VARCHAR(32) NOT NULL,
  ADD CONSTRAINT "staff_webauthn_attestation_format_check"
    CHECK (BTRIM("attestation_format") <> '');

COMMENT ON COLUMN public."staff_webauthn_credential"."attestation_verified_at" IS
  'Serverseitiger Zeitpunkt der erfolgreichen, vertrauenswuerdigen Attestation-Pruefung.';
COMMENT ON COLUMN public."staff_webauthn_credential"."attestation_format" IS
  'Vom Server verifiziertes WebAuthn-Attestation-Format.';

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
     AND credential."attestation_verified_at" IS NOT NULL
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
                  OR (
                    EXISTS (
                      SELECT 1
                        FROM public."staff_role" actor_role
                       WHERE actor_role."staff_user_id" = actor."id"
                         AND actor_role."role" = 'ADMIN'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM public."staff_role" target_role
                       WHERE target_role."staff_user_id" = credential_staff_user_id
                         AND target_role."role" = 'ADMIN'
                    )
                  )
                  OR (
                    EXISTS (
                      SELECT 1
                        FROM public."staff_role" actor_role
                       WHERE actor_role."staff_user_id" = actor."id"
                         AND actor_role."role" = 'PARTNER'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM public."staff_role" target_role
                       WHERE target_role."staff_user_id" = credential_staff_user_id
                         AND target_role."role" IN ('ADMIN', 'PARTNER')
                    )
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

CREATE OR REPLACE FUNCTION app.staff_webauthn_credential_insert_allowed(
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
           WHEN 'STAFF' THEN credential_staff_user_id = app.current_actor_id()
             AND EXISTS (
               SELECT 1
                 FROM public."staff_user" actor
                WHERE actor."tenant_id" = requested_tenant_id
                  AND actor."id" = app.current_actor_id()
                  AND actor."active" = TRUE
             )
           ELSE FALSE
         END;
$$;

REVOKE ALL ON FUNCTION app.staff_webauthn_credential_insert_allowed(UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.staff_webauthn_credential_insert_allowed(UUID, UUID)
  TO taxtronik_app;

DROP POLICY "staff_webauthn_credential_least_privilege"
  ON public."staff_webauthn_credential";

CREATE POLICY "staff_webauthn_credential_hierarchical_select"
  ON public."staff_webauthn_credential"
  FOR SELECT
  USING (
    app.staff_webauthn_credential_access_allowed("tenant_id", "staff_user_id")
  );

CREATE POLICY "staff_webauthn_credential_hierarchical_update"
  ON public."staff_webauthn_credential"
  FOR UPDATE
  USING (
    app.staff_webauthn_credential_access_allowed("tenant_id", "staff_user_id")
  )
  WITH CHECK (
    app.staff_webauthn_credential_access_allowed("tenant_id", "staff_user_id")
  );

CREATE POLICY "staff_webauthn_credential_self_insert"
  ON public."staff_webauthn_credential"
  FOR INSERT
  WITH CHECK (
    app.staff_webauthn_credential_insert_allowed("tenant_id", "staff_user_id")
  );

-- Recovery und Rollenwechsel muessen denselben transaktionsweiten Lock vor
-- ihrem entscheidenden Read halten. Dadurch sieht der Read nach einem Warten
-- den bereits committed Rollenstand und arbeitet nicht mit einem alten
-- Statement-Snapshot weiter.
CREATE OR REPLACE FUNCTION app.lock_staff_account_recovery(
  target_staff_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_tenant UUID;
BEGIN
  SELECT target."tenant_id"
    INTO target_tenant
    FROM public."staff_user" target
   WHERE target."id" = target_staff_user_id;

  IF NOT FOUND OR target_tenant IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'Staff-Recovery-Ziel ist fuer diesen Tenant nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF app.current_actor_type() = 'STAFF' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public."staff_user" actor
        JOIN public."staff_role" actor_role
          ON actor_role."staff_user_id" = actor."id"
       WHERE actor."tenant_id" = target_tenant
         AND actor."id" = app.current_actor_id()
         AND actor."active" = TRUE
         AND actor_role."role" IN ('ADMIN', 'PARTNER')
    ) THEN
      RAISE EXCEPTION 'Staff-Recovery-Lock ist fuer diesen Akteur nicht zulaessig.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF app.current_actor_type() <> 'SYSTEM' THEN
    RAISE EXCEPTION 'Staff-Recovery-Lock ist fuer diesen Akteur nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff_user_id::TEXT,
      0
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION app.lock_staff_account_recovery(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_staff_account_recovery(UUID) TO taxtronik_app;

CREATE OR REPLACE FUNCTION app.lock_staff_role_auth_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_staff UUID;
  target_tenant UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."staff_user_id" IS DISTINCT FROM OLD."staff_user_id" THEN
    RAISE EXCEPTION 'Staff-Rollenidentitaet ist unveraenderlich.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_staff := OLD."staff_user_id";
  ELSE
    target_staff := NEW."staff_user_id";
  END IF;

  SELECT staff."tenant_id"
    INTO target_tenant
    FROM public."staff_user" staff
   WHERE staff."id" = target_staff;

  -- Beim ON-DELETE-CASCADE kann der Parent bereits unsichtbar sein. Dessen
  -- eigener Row-Lock serialisiert den Kontoloeschpfad bereits.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
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

REVOKE ALL ON FUNCTION app.lock_staff_role_auth_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_staff_role_auth_state() FROM taxtronik_app;

CREATE TRIGGER "staff_role_auth_state_lock"
BEFORE INSERT OR UPDATE OR DELETE ON public."staff_role"
FOR EACH ROW EXECUTE FUNCTION app.lock_staff_role_auth_state();

COMMIT;
