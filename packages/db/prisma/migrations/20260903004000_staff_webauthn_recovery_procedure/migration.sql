-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Fremde Credential-Zeilen sind fuer die App-Rolle nicht mehr allgemein
-- aktualisierbar. Der administrative Break-glass-Widerruf laeuft stattdessen
-- ueber eine schmale SECURITY-DEFINER-Prozedur, die Recovery-Hierarchie und
-- den mit Rollenwechseln gemeinsamen Advisory Lock selbst erzwingt.

BEGIN;

DROP POLICY "staff_webauthn_credential_hierarchical_update"
  ON public."staff_webauthn_credential";

CREATE POLICY "staff_webauthn_credential_self_update"
  ON public."staff_webauthn_credential"
  FOR UPDATE
  USING (
    app.staff_webauthn_credential_insert_allowed("tenant_id", "staff_user_id")
  )
  WITH CHECK (
    app.staff_webauthn_credential_insert_allowed("tenant_id", "staff_user_id")
  );

-- Actor-Deaktivierung und Revisionserhoehung muessen denselben Kontolock wie
-- Rollen-, Credential- und Recovery-Aenderungen verwenden. Sonst koennte ein
-- bereits wartender Recovery-Aufruf nach dem Entzug weiterarbeiten.
DROP TRIGGER "staff_hardware_auth_state_lock" ON public."staff_user";

CREATE TRIGGER "staff_hardware_auth_state_lock"
BEFORE UPDATE OF "hardware_only_enabled_at", "active", "auth_revision"
ON public."staff_user"
FOR EACH ROW
WHEN (
  OLD."hardware_only_enabled_at" IS DISTINCT FROM NEW."hardware_only_enabled_at"
  OR OLD."active" IS DISTINCT FROM NEW."active"
  OR OLD."auth_revision" IS DISTINCT FROM NEW."auth_revision"
)
EXECUTE FUNCTION app.lock_staff_hardware_auth_state();

CREATE OR REPLACE FUNCTION app.revoke_staff_webauthn_credentials_for_recovery(
  target_staff_user_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_tenant UUID;
  target_hardware_only_enabled_at TIMESTAMP(3);
  actor_type TEXT := app.current_actor_type();
  actor_staff_user_id UUID := app.current_actor_id();
  actor_is_active BOOLEAN := FALSE;
  actor_is_admin BOOLEAN := FALSE;
  actor_is_partner BOOLEAN := FALSE;
  target_is_admin BOOLEAN := FALSE;
  target_is_partner BOOLEAN := FALSE;
  revoked_count INTEGER := 0;
BEGIN
  SELECT target."tenant_id"
    INTO target_tenant
    FROM public."staff_user" target
   WHERE target."id" = target_staff_user_id;

  IF NOT FOUND OR target_tenant IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'Staff-Recovery-Ziel ist fuer diesen Tenant nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF actor_type = 'STAFF' THEN
    IF actor_staff_user_id IS NULL OR actor_staff_user_id = target_staff_user_id THEN
      RAISE EXCEPTION 'Der eigene Hardware-Zugang darf nicht administrativ wiederhergestellt werden.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Actor und Ziel werden global in UUID-Reihenfolge gelockt. Dadurch sind
    -- parallele Recovery-Aufrufe untereinander deadlock-frei und Rollen- oder
    -- Kontostatusaenderungen an beiden Konten vollstaendig serialisiert.
    IF actor_staff_user_id::TEXT < target_staff_user_id::TEXT THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'staff-hardware-auth:' || target_tenant::TEXT || ':' || actor_staff_user_id::TEXT,
          0
        )
      );
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff_user_id::TEXT,
          0
        )
      );
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff_user_id::TEXT,
          0
        )
      );
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'staff-hardware-auth:' || target_tenant::TEXT || ':' || actor_staff_user_id::TEXT,
          0
        )
      );
    END IF;
  ELSIF actor_type = 'SYSTEM' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'staff-hardware-auth:' || target_tenant::TEXT || ':' || target_staff_user_id::TEXT,
        0
      )
    );
  ELSE
    RAISE EXCEPTION 'Hardware-Recovery ist fuer diesen Akteur nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Die Funktion ist absichtlich VOLATILE: Nach einem Warten auf den Lock
  -- erhalten diese Befehle unter READ COMMITTED einen frischen Snapshot und
  -- sehen zuvor committed Rollenwechsel am Ziel.
  SELECT target."hardware_only_enabled_at"
    INTO target_hardware_only_enabled_at
    FROM public."staff_user" target
   WHERE target."tenant_id" = target_tenant
     AND target."id" = target_staff_user_id;

  IF NOT FOUND OR target_hardware_only_enabled_at IS NULL THEN
    RAISE EXCEPTION 'Fuer dieses Konto ist kein Hardware-only-Zugang aktiv.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF actor_type = 'STAFF' THEN
    SELECT
      EXISTS (
        SELECT 1
          FROM public."staff_user" actor
         WHERE actor."tenant_id" = target_tenant
           AND actor."id" = actor_staff_user_id
           AND actor."active" = TRUE
      ),
      EXISTS (
        SELECT 1
          FROM public."staff_role" actor_role
         WHERE actor_role."staff_user_id" = actor_staff_user_id
           AND actor_role."role" = 'ADMIN'
      ),
      EXISTS (
        SELECT 1
          FROM public."staff_role" actor_role
         WHERE actor_role."staff_user_id" = actor_staff_user_id
           AND actor_role."role" = 'PARTNER'
      ),
      EXISTS (
        SELECT 1
          FROM public."staff_role" target_role
         WHERE target_role."staff_user_id" = target_staff_user_id
           AND target_role."role" = 'ADMIN'
      ),
      EXISTS (
        SELECT 1
          FROM public."staff_role" target_role
         WHERE target_role."staff_user_id" = target_staff_user_id
           AND target_role."role" = 'PARTNER'
      )
      INTO
        actor_is_active,
        actor_is_admin,
        actor_is_partner,
        target_is_admin,
        target_is_partner;

    IF NOT actor_is_active OR NOT (actor_is_admin OR actor_is_partner) THEN
      RAISE EXCEPTION 'Hardware-Recovery ist fuer diesen Akteur nicht zulaessig.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF target_is_admin OR (target_is_partner AND NOT actor_is_admin) THEN
      RAISE EXCEPTION 'Die Recovery-Hierarchie erlaubt diesen Hardware-Widerruf nicht.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  UPDATE public."staff_webauthn_credential" credential
     SET "revoked_at" = CURRENT_TIMESTAMP,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE credential."tenant_id" = target_tenant
     AND credential."staff_user_id" = target_staff_user_id
     AND credential."revoked_at" IS NULL;

  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  RETURN revoked_count;
END;
$$;

REVOKE ALL ON FUNCTION app.revoke_staff_webauthn_credentials_for_recovery(UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_staff_webauthn_credentials_for_recovery(UUID)
  TO taxtronik_app;

COMMIT;
