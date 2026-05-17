-- =============================================================================
-- Iter. 3 Vorschau: Zeiterfassung (TimeEntry)
-- Vacation/Sick/Storage/Training folgen separat.
-- =============================================================================

CREATE TABLE "time_entry" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"   UUID         NOT NULL,
    "staff_id"    UUID         NOT NULL,
    "client_id"   UUID,
    "description" TEXT         NOT NULL,
    "started_at"  TIMESTAMP(3) NOT NULL,
    "ended_at"    TIMESTAMP(3),
    "billable"    BOOLEAN      NOT NULL DEFAULT TRUE,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "time_entry_staff_id_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "time_entry_tenant_id_staff_id_started_at_idx" ON "time_entry"("tenant_id", "staff_id", "started_at");
CREATE INDEX "time_entry_tenant_id_client_id_started_at_idx" ON "time_entry"("tenant_id", "client_id", "started_at");

ALTER TABLE "time_entry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY time_entry_isolation ON "time_entry"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "time_entry" TO taxtronik_app;
