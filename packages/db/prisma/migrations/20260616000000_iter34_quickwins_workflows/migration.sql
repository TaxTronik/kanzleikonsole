-- =============================================================================
-- Iter. 34 — Quick-Wins + Workflow-Praxis
--
-- Bündel von Orga-Features:
--   - A/B/C-Mandanten-Priorität
--   - Akten-Notiz (intern, nur Kanzlei)
--   - Empfangsbestätigung pro Dokument
--   - Briefkopf-Setting (in tenant_setting JSON — kein Schema-Change)
--   - Wiedervorlage (`client_reminder`)
--   - Pendelordner-Tracker (`pending_binder`)
-- =============================================================================

CREATE TYPE "ClientPriority" AS ENUM ('A', 'B', 'C');

ALTER TABLE "client"
  ADD COLUMN "priority"       "ClientPriority",
  ADD COLUMN "internal_notes" TEXT;
CREATE INDEX "client_tenant_priority_idx" ON "client"("tenant_id", "priority");

ALTER TABLE "document"
  ADD COLUMN "acknowledged_at"        TIMESTAMPTZ,
  ADD COLUMN "acknowledged_by_staff"  UUID;

-- =============================================================================
-- Wiedervorlage
-- =============================================================================
CREATE TABLE "client_reminder" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"         UUID NOT NULL,
  "client_id"         UUID NOT NULL,
  "due_date"          DATE NOT NULL,
  "subject"           TEXT NOT NULL,
  "notes"             TEXT,
  "created_by_staff"  UUID NOT NULL,
  "assignee_staff_id" UUID,
  "done_at"           TIMESTAMPTZ,
  "done_by_staff"     UUID,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ NOT NULL,
  CONSTRAINT "client_reminder_pk" PRIMARY KEY ("id"),
  CONSTRAINT "client_reminder_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "client_reminder_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE
);
CREATE INDEX "client_reminder_due_idx" ON "client_reminder"("tenant_id", "due_date", "done_at");
CREATE INDEX "client_reminder_assignee_idx" ON "client_reminder"("assignee_staff_id", "done_at");

ALTER TABLE "client_reminder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_reminder_tenant" ON "client_reminder"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "client_reminder" TO taxtronik_app;

-- =============================================================================
-- Pendelordner
-- =============================================================================
CREATE TYPE "PendingBinderStatus" AS ENUM ('PREPARED', 'WITH_CLIENT', 'RETURNED', 'COMPLETED');

CREATE TABLE "pending_binder" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"           UUID NOT NULL,
  "client_id"           UUID NOT NULL,
  "label"               TEXT NOT NULL,
  "contents"            TEXT,
  "status"              "PendingBinderStatus" NOT NULL DEFAULT 'PREPARED',
  "sent_at"             TIMESTAMPTZ,
  "expected_return_at"  DATE,
  "returned_at"         TIMESTAMPTZ,
  "completed_at"        TIMESTAMPTZ,
  "created_by_staff"    UUID NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ NOT NULL,
  CONSTRAINT "pending_binder_pk" PRIMARY KEY ("id"),
  CONSTRAINT "pending_binder_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "pending_binder_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE
);
CREATE INDEX "pending_binder_status_idx" ON "pending_binder"("tenant_id", "status");
CREATE INDEX "pending_binder_client_idx" ON "pending_binder"("client_id", "status");

ALTER TABLE "pending_binder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pending_binder_tenant" ON "pending_binder"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_binder" TO taxtronik_app;
