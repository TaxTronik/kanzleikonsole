-- =============================================================================
-- Iter. 11: Mandanten-Admin
--
-- Drei Änderungen:
--   1. client.addison_no — zweite Mandantennummer (parallel zu DATEV)
--   2. client_contact.notifications_enabled — Mandant kann Mails abstellen
--   3. client_responsibility — Bearbeiter-Zuordnung pro Mandant
-- =============================================================================

-- 1. Addison-Nummer
ALTER TABLE "client" ADD COLUMN "addison_no" TEXT;
CREATE UNIQUE INDEX "client_tenant_id_addison_no_key"
    ON "client"("tenant_id","addison_no")
    WHERE "addison_no" IS NOT NULL;

-- 2. Portal-Notification-Setting
ALTER TABLE "client_contact"
    ADD COLUMN "notifications_enabled" BOOLEAN NOT NULL DEFAULT TRUE;

-- 3. Bearbeiter-Zuordnung
CREATE TYPE "client_responsibility_role" AS ENUM (
    'HAUPTBEARBEITER','VERTRETER','FACHLICH'
);

CREATE TABLE "client_responsibility" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"  UUID NOT NULL,
    "client_id"  UUID NOT NULL,
    "staff_id"   UUID NOT NULL,
    "role"       "client_responsibility_role" NOT NULL DEFAULT 'HAUPTBEARBEITER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_responsibility_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "client_responsibility_staff_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "client_responsibility_client_id_staff_id_role_key"
    ON "client_responsibility"("client_id","staff_id","role");

CREATE INDEX "client_responsibility_tenant_id_staff_id_idx"
    ON "client_responsibility"("tenant_id","staff_id");

ALTER TABLE "client_responsibility" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_responsibility_isolation ON "client_responsibility"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
