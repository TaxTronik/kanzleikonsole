-- =============================================================================
-- taxtronik — Initiale Migration (Iteration 1: Foundation)
--
-- Enthält:
--   1. Extensions
--   2. Enum-Typen
--   3. Tabellen (passend zum Prisma-Schema)
--   4. Indizes & Constraints
--   5. Helper-Funktionen für RLS-Kontext (current_tenant_id, current_actor_id)
--   6. RLS-Policies auf allen tenant-scoped Tabellen
--   7. Audit-Trigger (insert-only auf audit_log und audit_seal)
--   8. document_version-Trigger (UPDATE/DELETE auf immutable=true blockieren)
--   9. GwG-Schranke (Stub für Iter. 1; vollständig ab Iter. 4 mit gwg_check)
--  10. GRANTs für die App-Role
--  11. BYPASSRLS für den Owner (für Migrationen und Wartung)
--
-- Diese Migration ist hand-written und wird von Prisma als „bereits angewendet"
-- erkannt, sobald der Migration-Hash im _prisma_migrations-Tabelle landet.
-- =============================================================================

-- 1. Extensions ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";

-- 2. Enum-Typen ---------------------------------------------------------------
CREATE TYPE "staff_role_name" AS ENUM ('EMPLOYEE', 'PARTNER', 'ADMIN');
CREATE TYPE "client_kind" AS ENUM ('NATPERS', 'JURPERS', 'PERSGES');
CREATE TYPE "document_classification" AS ENUM (
    'GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX', 'GWG_EVIDENCE',
    'PERSONNEL', 'STAFF_PRIVATE', 'GENERAL'
);
CREATE TYPE "audit_actor_type" AS ENUM ('STAFF', 'CLIENT_CONTACT', 'SYSTEM');

-- 3. Tabellen -----------------------------------------------------------------

CREATE TABLE "tenant" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "slug"       TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

CREATE TABLE "tenant_setting" (
    "tenant_id"  UUID         NOT NULL,
    "key"        TEXT         NOT NULL,
    "value"      JSONB        NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("tenant_id", "key"),
    CONSTRAINT "tenant_setting_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "staff_user" (
    "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"          UUID         NOT NULL,
    "email"              CITEXT       NOT NULL,
    "full_name"          TEXT         NOT NULL,
    "password_hash"      TEXT         NOT NULL,
    "totp_secret_enc"    TEXT,
    "totp_enrolled_at"   TIMESTAMP(3),
    "totp_backup_codes"  JSONB,
    "active"             BOOLEAN      NOT NULL DEFAULT TRUE,
    "locked_until"       TIMESTAMP(3),
    "last_login_at"      TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_user_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "staff_user_tenant_id_email_key" ON "staff_user"("tenant_id", "email");
CREATE INDEX "staff_user_tenant_id_idx" ON "staff_user"("tenant_id");

CREATE TABLE "staff_role" (
    "staff_user_id" UUID            NOT NULL,
    "role"          "staff_role_name" NOT NULL,
    "granted_at"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_role_pkey" PRIMARY KEY ("staff_user_id", "role"),
    CONSTRAINT "staff_role_staff_user_id_fkey"
        FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "client" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"    UUID         NOT NULL,
    "kind"         "client_kind" NOT NULL,
    "name"         TEXT         NOT NULL,
    "datev_no"     TEXT,
    "allow_active" BOOLEAN      NOT NULL DEFAULT FALSE,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "client_tenant_id_datev_no_key" ON "client"("tenant_id", "datev_no");
CREATE INDEX "client_tenant_id_idx" ON "client"("tenant_id");

CREATE TABLE "document" (
    "id"              UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"       UUID                       NOT NULL,
    "client_id"       UUID,
    "owner_staff_id"  UUID,
    "title"           TEXT                       NOT NULL,
    "classification"  "document_classification"  NOT NULL,
    "mime_type"       TEXT                       NOT NULL,
    "retention_until" TIMESTAMP(3),
    "created_at"      TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3)               NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "document_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "document_tenant_id_client_id_idx" ON "document"("tenant_id", "client_id");
CREATE INDEX "document_tenant_id_classification_idx" ON "document"("tenant_id", "classification");

CREATE TABLE "document_version" (
    "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
    "document_id"       UUID         NOT NULL,
    "version_no"        INTEGER      NOT NULL,
    "storage_bucket"    TEXT         NOT NULL,
    "storage_key"       TEXT         NOT NULL,
    "sha256"            BYTEA        NOT NULL,
    "size_bytes"        BIGINT       NOT NULL,
    "immutable"         BOOLEAN      NOT NULL DEFAULT FALSE,
    "scan_status"       TEXT         NOT NULL DEFAULT 'PENDING',
    "scan_completed_at" TIMESTAMP(3),
    "created_by_id"     UUID         NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_version_document_id_fkey"
        FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "document_version_document_id_version_no_key" ON "document_version"("document_id", "version_no");
CREATE INDEX "document_version_document_id_idx" ON "document_version"("document_id");

CREATE TABLE "audit_log" (
    "id"            BIGSERIAL          NOT NULL,
    "tenant_id"     UUID               NOT NULL,
    "occurred_at"   TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type"    "audit_actor_type" NOT NULL,
    "actor_id"      UUID,
    "action"        TEXT               NOT NULL,
    "resource_type" TEXT               NOT NULL,
    "resource_id"   TEXT,
    "before"        JSONB,
    "after"         JSONB,
    "ip"            INET,
    "user_agent"    TEXT,
    "prev_hash"     BYTEA              NOT NULL,
    "this_hash"     BYTEA              NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_log_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON UPDATE CASCADE
);
CREATE INDEX "audit_log_tenant_id_occurred_at_idx" ON "audit_log"("tenant_id", "occurred_at");
CREATE INDEX "audit_log_tenant_id_resource_type_resource_id_idx" ON "audit_log"("tenant_id", "resource_type", "resource_id");

CREATE TABLE "audit_seal" (
    "id"                BIGSERIAL    NOT NULL,
    "tenant_id"         UUID         NOT NULL,
    "seal_date"         DATE         NOT NULL,
    "top_audit_id"      BIGINT       NOT NULL,
    "top_hash"          BYTEA        NOT NULL,
    "tsa_request_blob"  BYTEA,
    "tsa_response_blob" BYTEA,
    "tsa_serial"        TEXT,
    "sealed_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealed_by"         TEXT         NOT NULL DEFAULT 'system',

    CONSTRAINT "audit_seal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_seal_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "audit_seal_tenant_id_seal_date_key" ON "audit_seal"("tenant_id", "seal_date");
CREATE INDEX "audit_seal_tenant_id_seal_date_idx" ON "audit_seal"("tenant_id", "seal_date");

-- 5. Helper-Funktionen für RLS-Kontext ---------------------------------------
-- Pro Request setzt die App via `SET LOCAL app.current_tenant_id = '...'` etc.
-- Diese Funktionen lesen die Werte und werden in den Policies verwendet.

-- Schema 'app' muss zuerst existieren, bevor Funktionen darin angelegt werden.
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO PUBLIC;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS UUID AS $$
DECLARE
    v TEXT;
BEGIN
    v := current_setting('app.current_tenant_id', TRUE);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION app.current_actor_id() RETURNS UUID AS $$
DECLARE
    v TEXT;
BEGIN
    v := current_setting('app.current_actor_id', TRUE);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION app.current_actor_type() RETURNS TEXT AS $$
BEGIN
    RETURN current_setting('app.current_actor_type', TRUE);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 6. RLS-Policies -------------------------------------------------------------
-- Pattern: tenant_id muss mit der Session-Variable übereinstimmen.
-- Wenn keine Session-Variable gesetzt ist, sieht die App-Role NICHTS.
-- Owner-Role (taxtronik) hat BYPASSRLS und umgeht das (siehe Punkt 11).

ALTER TABLE "tenant_setting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_setting_isolation ON "tenant_setting"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "staff_user" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_user_isolation ON "staff_user"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "staff_role" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_role_isolation ON "staff_role"
    USING (EXISTS (
        SELECT 1 FROM "staff_user" su
        WHERE su.id = "staff_role"."staff_user_id"
          AND su.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "staff_user" su
        WHERE su.id = "staff_role"."staff_user_id"
          AND su.tenant_id = app.current_tenant_id()
    ));

ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_isolation ON "client"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_isolation ON "document"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "document_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_version_isolation ON "document_version"
    USING (EXISTS (
        SELECT 1 FROM "document" d
        WHERE d.id = "document_version"."document_id"
          AND d.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "document" d
        WHERE d.id = "document_version"."document_id"
          AND d.tenant_id = app.current_tenant_id()
    ));

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_isolation ON "audit_log"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "audit_seal" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_seal_isolation ON "audit_seal"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Tenant-Tabelle selbst: nur Owner sieht alles. App-Role darf nur eigenen Tenant lesen.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_read ON "tenant"
    FOR SELECT USING ("id" = app.current_tenant_id());

-- 7. Audit-Trigger: insert-only ----------------------------------------------
-- audit_log und audit_seal dürfen niemals geändert oder gelöscht werden,
-- auch nicht vom Owner. Ein Restore aus Backup ist die einzige Ausnahme,
-- aber der bricht naturgemäß die Hash-Chain — siehe ADR.

CREATE OR REPLACE FUNCTION app.prevent_modification() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Tabelle % ist append-only und darf weder geändert noch gelöscht werden (Operation: %)',
        TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_modify
    BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_log"
    FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();

CREATE TRIGGER audit_seal_no_modify
    BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_seal"
    FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();

-- 8. document_version-Trigger: immutable schützt vor Änderung -----------------
CREATE OR REPLACE FUNCTION app.protect_immutable_document_version() RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.immutable = TRUE) THEN
        -- Erlaubt: Übergang scan_status PENDING -> CLEAN/INFECTED, scan_completed_at setzen.
        -- Sonst: Verboten.
        IF (OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
            OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
            OR OLD.sha256 IS DISTINCT FROM NEW.sha256
            OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
            OR OLD.immutable IS DISTINCT FROM NEW.immutable
            OR OLD.version_no IS DISTINCT FROM NEW.version_no
            OR OLD.document_id IS DISTINCT FROM NEW.document_id
            OR OLD.created_at IS DISTINCT FROM NEW.created_at
            OR OLD.created_by_id IS DISTINCT FROM NEW.created_by_id) THEN
            RAISE EXCEPTION 'document_version ist immutable, Inhaltsfelder dürfen nicht geändert werden'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF (TG_OP = 'DELETE' AND OLD.immutable = TRUE) THEN
        RAISE EXCEPTION 'document_version ist immutable und darf nicht gelöscht werden'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_version_immutable_protect
    BEFORE UPDATE OR DELETE ON "document_version"
    FOR EACH ROW EXECUTE FUNCTION app.protect_immutable_document_version();

-- 9. GwG-Schranke (Iter. 1: Stub) --------------------------------------------
-- Dokumente an einen Mandanten dürfen nur angelegt werden, wenn der Mandant
-- `allow_active = TRUE` hat. In Iter. 1 wird `allow_active` manuell gesetzt;
-- ab Iter. 4 erst durch verifizierten gwg_check.
-- request/invoice-Trigger kommen mit den jeweiligen Tabellen.

CREATE OR REPLACE FUNCTION app.enforce_client_active_for_document() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.client_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "client" c
            WHERE c.id = NEW.client_id AND c.allow_active = TRUE
        ) THEN
            RAISE EXCEPTION 'Mandant % ist nicht aktiv (GwG-Schranke). Dokumentenanlage abgewiesen.',
                NEW.client_id
                USING ERRCODE = 'check_violation', HINT = 'Mandant muss verifiziert sein (Iter. 4: gwg_check.status = VERIFIED).';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_client_active_check
    BEFORE INSERT ON "document"
    FOR EACH ROW EXECUTE FUNCTION app.enforce_client_active_for_document();

-- 10. GRANTs für die App-Role -------------------------------------------------
-- Der Postgres-Init-Skript (postgres-init.sql) hat bereits Default-Privileges
-- gesetzt, aber die existierenden Tabellen brauchen explizite GRANTs.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO taxtronik_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taxtronik_app;
GRANT USAGE ON SCHEMA app TO taxtronik_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO taxtronik_app;

-- App-Role darf NICHT direkt in audit_log/audit_seal löschen oder modifizieren
-- (auch wenn Trigger das ohnehin blockt — Defense in Depth).
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM taxtronik_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_seal" FROM taxtronik_app;

-- 11. Owner-Privilegien -------------------------------------------------------
-- Owner braucht BYPASSRLS für Migrationen, Wartung und Verifikation der
-- Hash-Chain. Im Compose ist taxtronik der DB-Superuser und hat das implizit.
-- Folgende Zeile ist defensiv und idempotent.
DO $$
BEGIN
    EXECUTE 'ALTER ROLE taxtronik BYPASSRLS';
EXCEPTION WHEN OTHERS THEN
    -- In Cloud-Postgres-Setups kann das fehlschlagen; Migration soll trotzdem laufen.
    RAISE NOTICE 'Konnte BYPASSRLS für Owner nicht setzen: %', SQLERRM;
END $$;
