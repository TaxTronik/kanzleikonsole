-- =============================================================================
-- taxtronik — Migration Iter. 2: Portal, Requests, PhoneNotes
--
-- Enthält:
--   1. Neue Enum-Typen
--   2. Neue Tabellen (client_contact, magic_link, request, request_response, phone_note)
--   3. Indizes & FKs
--   4. RLS-Policies
--   5. GwG-Schranke für request (analog document)
--   6. GRANTs für App-Role
-- =============================================================================

-- 1. Enums --------------------------------------------------------------------
CREATE TYPE "request_status"          AS ENUM ('OPEN', 'IN_PROGRESS', 'RESPONDED', 'CLOSED', 'CANCELLED');
CREATE TYPE "request_priority"        AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "request_response_author" AS ENUM ('STAFF', 'CLIENT_CONTACT');

-- 2. Tabellen -----------------------------------------------------------------

CREATE TABLE "client_contact" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"     UUID         NOT NULL,
    "client_id"     UUID         NOT NULL,
    "email"         CITEXT       NOT NULL,
    "full_name"     TEXT         NOT NULL,
    "active"        BOOLEAN      NOT NULL DEFAULT TRUE,
    "last_login_at" TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_contact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_contact_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_contact_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "client_contact_tenant_id_email_key" ON "client_contact"("tenant_id", "email");
CREATE INDEX "client_contact_tenant_id_client_id_idx" ON "client_contact"("tenant_id", "client_id");

CREATE TABLE "magic_link" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"   UUID         NOT NULL,
    "email"       CITEXT       NOT NULL,
    "token_hash"  TEXT         NOT NULL,
    "expires_at"  TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_link_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "magic_link_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "magic_link_token_hash_idx" ON "magic_link"("token_hash");
CREATE INDEX "magic_link_tenant_id_email_idx" ON "magic_link"("tenant_id", "email");

CREATE TABLE "request" (
    "id"               UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID                 NOT NULL,
    "client_id"        UUID                 NOT NULL,
    "title"            TEXT                 NOT NULL,
    "description"      TEXT                 NOT NULL,
    "priority"         "request_priority"   NOT NULL DEFAULT 'NORMAL',
    "status"           "request_status"     NOT NULL DEFAULT 'OPEN',
    "due_at"           TIMESTAMP(3),
    "created_by_staff" UUID                 NOT NULL,
    "closed_at"        TIMESTAMP(3),
    "closed_by_staff"  UUID,
    "created_at"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3)         NOT NULL,

    CONSTRAINT "request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "request_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "request_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "request_tenant_id_client_id_idx" ON "request"("tenant_id", "client_id");
CREATE INDEX "request_tenant_id_status_idx"    ON "request"("tenant_id", "status");
CREATE INDEX "request_tenant_id_due_at_idx"    ON "request"("tenant_id", "due_at");

CREATE TABLE "request_response" (
    "id"          UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "request_id"  UUID                       NOT NULL,
    "author_type" "request_response_author"  NOT NULL,
    "author_id"   UUID                       NOT NULL,
    "message"     TEXT                       NOT NULL,
    "document_id" UUID,
    "created_at"  TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_response_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "request_response_request_id_fkey"
        FOREIGN KEY ("request_id") REFERENCES "request"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "request_response_document_id_fkey"
        FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "request_response_request_id_idx" ON "request_response"("request_id");

CREATE TABLE "phone_note" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID         NOT NULL,
    "client_id"        UUID,
    "caller_name"      TEXT         NOT NULL,
    "caller_phone"     TEXT,
    "subject"          TEXT         NOT NULL,
    "body"             TEXT         NOT NULL,
    "forward_to_staff" UUID,
    "taken_by_staff"   UUID         NOT NULL,
    "read_at"          TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_note_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "phone_note_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "phone_note_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "phone_note_tenant_id_client_id_idx" ON "phone_note"("tenant_id", "client_id");
CREATE INDEX "phone_note_tenant_id_forward_to_staff_read_at_idx"
    ON "phone_note"("tenant_id", "forward_to_staff", "read_at");

-- 3. RLS-Policies -------------------------------------------------------------

ALTER TABLE "client_contact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_contact_isolation ON "client_contact"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- magic_link wird beim Verifizieren _vor_ dem Setzen des Tenant-Kontexts gelesen.
-- Daher: keine RLS aktivieren — App muss aber über Owner-Verbindung lesen
-- (analog auth-tabellen). Konkret: die Magic-Link-Verify-Route nutzt prismaOwner.
-- Wir aktivieren RLS dennoch defensiv, damit die App-Rolle nichts ohne Kontext sieht;
-- die Verify-Route nutzt Owner.
ALTER TABLE "magic_link" ENABLE ROW LEVEL SECURITY;
CREATE POLICY magic_link_isolation ON "magic_link"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_isolation ON "request"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- request_response: über parent request scoped
ALTER TABLE "request_response" ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_response_isolation ON "request_response"
    USING (EXISTS (
        SELECT 1 FROM "request" r
        WHERE r.id = "request_response"."request_id"
          AND r.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "request" r
        WHERE r.id = "request_response"."request_id"
          AND r.tenant_id = app.current_tenant_id()
    ));

ALTER TABLE "phone_note" ENABLE ROW LEVEL SECURITY;
CREATE POLICY phone_note_isolation ON "phone_note"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- 4. GwG-Schranke für request (analog document) ------------------------------
CREATE OR REPLACE FUNCTION app.enforce_client_active_for_request() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "client" c
        WHERE c.id = NEW.client_id AND c.allow_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Mandant % ist nicht aktiv (GwG-Schranke). Anforderung abgewiesen.',
            NEW.client_id
            USING ERRCODE = 'check_violation', HINT = 'Mandant muss verifiziert sein (Iter. 4: gwg_check.status = VERIFIED).';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER request_client_active_check
    BEFORE INSERT ON "request"
    FOR EACH ROW EXECUTE FUNCTION app.enforce_client_active_for_request();

-- 5. GRANTs für App-Role ------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "client_contact"  TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "magic_link"      TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "request"         TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "request_response" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "phone_note"      TO taxtronik_app;
