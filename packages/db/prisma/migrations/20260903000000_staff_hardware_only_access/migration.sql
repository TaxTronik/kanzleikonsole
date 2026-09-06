-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Hardware-only Staff-Zugang:
-- - der Auth-Stand wird am Staff-Konto versioniert,
-- - WebAuthn-Credentials sind redundant und per Composite-FK an den Tenant
--   ihres Staff-Kontos gebunden,
-- - ENABLE/FORCE RLS trennt Credentials zwischen Tenants und vom Portal,
-- - Hardware-only ist nur mit mindestens zwei aktiven, geraetegebundenen und
--   nicht gesicherten Credentials zulaessig.

BEGIN;

ALTER TABLE public."staff_user"
  ADD COLUMN "hardware_only_enabled_at" TIMESTAMP(3),
  ADD COLUMN "auth_revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "staff_user_auth_revision_check"
    CHECK ("auth_revision" >= 0),
  ADD CONSTRAINT "staff_user_tenant_id_id_key"
    UNIQUE ("tenant_id", "id");

CREATE TABLE public."staff_webauthn_credential" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "staff_user_id" UUID NOT NULL,
  "credential_id" VARCHAR(2048) NOT NULL,
  "public_key" BYTEA NOT NULL,
  "sign_count" BIGINT NOT NULL DEFAULT 0,
  "webauthn_user_id" VARCHAR(128) NOT NULL,
  "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "device_type" VARCHAR(20) NOT NULL,
  "backed_up" BOOLEAN NOT NULL DEFAULT FALSE,
  "aaguid" UUID,
  "label" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "staff_webauthn_credential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_webauthn_credential_credential_id_key" UNIQUE ("credential_id"),
  CONSTRAINT "staff_webauthn_credential_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "staff_webauthn_credential_tenant_id_staff_user_id_fkey"
    FOREIGN KEY ("tenant_id", "staff_user_id")
    REFERENCES public."staff_user"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "staff_webauthn_credential_id_nonempty_check"
    CHECK (BTRIM("credential_id") <> ''),
  CONSTRAINT "staff_webauthn_user_id_nonempty_check"
    CHECK (BTRIM("webauthn_user_id") <> ''),
  CONSTRAINT "staff_webauthn_public_key_check"
    CHECK (OCTET_LENGTH("public_key") BETWEEN 1 AND 4096),
  CONSTRAINT "staff_webauthn_sign_count_check"
    CHECK ("sign_count" >= 0),
  CONSTRAINT "staff_webauthn_device_type_check"
    CHECK ("device_type" IN ('singleDevice', 'multiDevice')),
  CONSTRAINT "staff_webauthn_backed_up_device_check"
    CHECK (NOT "backed_up" OR "device_type" = 'multiDevice'),
  CONSTRAINT "staff_webauthn_label_check"
    CHECK (BTRIM("label") <> ''),
  CONSTRAINT "staff_webauthn_last_used_check"
    CHECK ("last_used_at" IS NULL OR "last_used_at" >= "created_at"),
  CONSTRAINT "staff_webauthn_revoked_check"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE INDEX "staff_webauthn_credential_tenant_id_staff_user_id_idx"
  ON public."staff_webauthn_credential"("tenant_id", "staff_user_id");

-- Fachkatalog: ACCESS-TENANT-RLS-001. Credentials gehoeren ausschliesslich
-- zum gesetzten Tenant und sind nie fuer CLIENT_CONTACT-Sessions sichtbar.
-- Das Bootstrap vergibt CRUD als Default-Privilege; erst zuruecknehmen, dann
-- die fuer Registrierung, Anmeldung und Recovery benoetigten Rechte vergeben.
REVOKE ALL ON public."staff_webauthn_credential" FROM taxtronik_app;

ALTER TABLE public."staff_webauthn_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."staff_webauthn_credential" FORCE ROW LEVEL SECURITY;

CREATE POLICY "staff_webauthn_credential_tenant_isolation"
  ON public."staff_webauthn_credential"
  FOR ALL
  USING (
    "tenant_id" = app.current_tenant_id()
    AND app.current_actor_type() IN ('STAFF', 'SYSTEM')
  )
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND app.current_actor_type() IN ('STAFF', 'SYSTEM')
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public."staff_webauthn_credential" TO taxtronik_app;

-- Serialisiert alle Credential-Mutationen eines Kontos. Ohne diesen Lock
-- koennten zwei parallele Transaktionen bei je drei sichtbaren Schluesseln
-- jeweils einen anderen Schluessel widerrufen und gemeinsam unter zwei fallen.
CREATE OR REPLACE FUNCTION app.lock_staff_hardware_auth_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
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

CREATE TRIGGER "staff_hardware_auth_state_lock"
BEFORE UPDATE OF "hardware_only_enabled_at" ON public."staff_user"
FOR EACH ROW
WHEN (OLD."hardware_only_enabled_at" IS DISTINCT FROM NEW."hardware_only_enabled_at")
EXECUTE FUNCTION app.lock_staff_hardware_auth_state();

CREATE TRIGGER "staff_webauthn_credential_state_lock"
BEFORE INSERT OR UPDATE OR DELETE ON public."staff_webauthn_credential"
FOR EACH ROW EXECUTE FUNCTION app.lock_staff_hardware_auth_state();

-- Der Check laeuft deferred: Zwei Credentials koennen zusammen mit der
-- Aktivierung in derselben Transaktion angelegt werden. Am Commit muss der
-- Endzustand aber immer mindestens zwei geeignete Credentials enthalten.
CREATE OR REPLACE FUNCTION app.enforce_staff_hardware_key_minimum()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
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
     AND credential."backed_up" = FALSE;

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

CREATE CONSTRAINT TRIGGER "staff_hardware_key_minimum"
AFTER INSERT OR UPDATE OF "hardware_only_enabled_at" ON public."staff_user"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_staff_hardware_key_minimum();

CREATE CONSTRAINT TRIGGER "staff_webauthn_key_minimum"
AFTER INSERT OR UPDATE OR DELETE ON public."staff_webauthn_credential"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_staff_hardware_key_minimum();

COMMIT;
