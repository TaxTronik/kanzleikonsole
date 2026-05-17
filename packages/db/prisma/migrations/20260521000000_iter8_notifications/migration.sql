-- =============================================================================
-- Iter. 8: In-App-Notifications für Mitarbeiter
-- =============================================================================

CREATE TYPE "notification_kind" AS ENUM (
    'REQUEST_RESPONDED', 'POA_SIGNED', 'GWG_EXPIRY_SOON', 'INVOICE_OVERDUE',
    'PHONE_NOTE_FORWARDED', 'VACATION_DECISION',
    'SYSTEM_BACKUP_FAILED', 'SYSTEM_AUDIT_BREAK'
);

CREATE TABLE "notification" (
    "id"            UUID                NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"     UUID                NOT NULL,
    "staff_id"      UUID,
    "kind"          "notification_kind" NOT NULL,
    "title"         TEXT                NOT NULL,
    "body"          TEXT,
    "href"          TEXT,
    "resource_type" TEXT,
    "resource_id"   TEXT,
    "read_at"       TIMESTAMP(3),
    "created_at"    TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notification_staff_id_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "notification_tenant_id_staff_id_read_at_created_at_idx"
    ON "notification"("tenant_id", "staff_id", "read_at", "created_at");
CREATE INDEX "notification_tenant_id_resource_type_resource_id_idx"
    ON "notification"("tenant_id", "resource_type", "resource_id");

ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_isolation ON "notification"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification" TO taxtronik_app;
