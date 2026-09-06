-- Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001
-- Passwort- und TOTP-Sicherheitsresets widerrufen auch vor einem Opt-in
-- registrierte Hardware-Credentials. So kann ein zuvor eingeschleustes
-- Credential nicht spaeter unbemerkt als zweiter Hardware-Faktor aufleben.

BEGIN;

CREATE FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(
  target_staff_user_id UUID,
  expected_actor_auth_revision INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  target_tenant UUID;
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
    RAISE EXCEPTION 'Staff-Sicherheitsreset-Ziel ist fuer diesen Tenant nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR actor_staff_user_id IS NULL
     OR actor_staff_user_id = target_staff_user_id
  THEN
    RAISE EXCEPTION 'Staff-Sicherheitsreset ist fuer diesen Akteur nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

  SELECT
    EXISTS (
      SELECT 1 FROM public."staff_user" actor
       WHERE actor."tenant_id" = target_tenant
         AND actor."id" = actor_staff_user_id
         AND actor."active" = TRUE
         AND actor."auth_revision" = expected_actor_auth_revision
    ),
    EXISTS (
      SELECT 1 FROM public."staff_role" actor_role
       WHERE actor_role."staff_user_id" = actor_staff_user_id
         AND actor_role."role"::TEXT = 'ADMIN'
    ),
    EXISTS (
      SELECT 1 FROM public."staff_role" actor_role
       WHERE actor_role."staff_user_id" = actor_staff_user_id
         AND actor_role."role"::TEXT = 'PARTNER'
    ),
    EXISTS (
      SELECT 1 FROM public."staff_role" target_role
       WHERE target_role."staff_user_id" = target_staff_user_id
         AND target_role."role"::TEXT = 'ADMIN'
    ),
    EXISTS (
      SELECT 1 FROM public."staff_role" target_role
       WHERE target_role."staff_user_id" = target_staff_user_id
         AND target_role."role"::TEXT = 'PARTNER'
    )
    INTO actor_is_active, actor_is_admin, actor_is_partner, target_is_admin, target_is_partner;

  IF NOT EXISTS (
    SELECT 1 FROM public."staff_user" target
     WHERE target."tenant_id" = target_tenant
       AND target."id" = target_staff_user_id
  ) OR NOT actor_is_active OR NOT (actor_is_admin OR actor_is_partner) THEN
    RAISE EXCEPTION 'Staff-Sicherheitsreset ist fuer diesen Akteur nicht zulaessig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF target_is_admin OR (target_is_partner AND NOT actor_is_admin) THEN
    RAISE EXCEPTION 'Die Recovery-Hierarchie erlaubt diesen Sicherheitsreset nicht.'
      USING ERRCODE = 'insufficient_privilege';
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
$function$;

REVOKE ALL ON FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(UUID, INTEGER)
  FROM taxtronik_app;
GRANT EXECUTE ON FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(UUID, INTEGER)
  TO taxtronik_app;

COMMENT ON FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(UUID, INTEGER) IS
  'Widerruft vor dem Opt-in registrierte Hardware-Credentials bei hierarchisch autorisierten Passwort-/TOTP-Sicherheitsresets.';

COMMIT;
