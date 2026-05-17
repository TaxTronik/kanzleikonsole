-- =============================================================================
-- Iter. 32 — Workflows: Pausieren mit Timer, Wiederherstellen, Inline-Schritte
--                       hinzufügen, Mehrfach-Kommentare pro Schritt
-- =============================================================================

-- WorkflowInstanceStatus.PAUSED neu (Prisma hatte den Enum vor dem
-- Naming-Convention-Wechsel als snake_case generiert)
ALTER TYPE "workflow_instance_status" ADD VALUE 'PAUSED';

-- pausedUntil — optionales Datum, ab dem PAUSED → ACTIVE (lazy resume)
ALTER TABLE "workflow_instance"
  ADD COLUMN "paused_until" TIMESTAMPTZ;

-- Mehrfach-Kommentare pro Workflow-Item
CREATE TABLE "workflow_item_comment" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "item_id"         UUID NOT NULL,
  "author_staff_id" UUID NOT NULL,
  "author_name"     TEXT NOT NULL,
  "body"            TEXT NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "wf_item_comment_pk" PRIMARY KEY ("id"),
  CONSTRAINT "wf_item_comment_item_fk"
    FOREIGN KEY ("item_id") REFERENCES "workflow_item"("id") ON DELETE CASCADE
);
CREATE INDEX "wf_item_comment_item_idx" ON "workflow_item_comment"("item_id", "created_at");

-- RLS-Policy: via Item → Instanz → Tenant. Da workflow_item kein eigenes
-- tenant_id-Feld hat, beschränken wir Zugriff über JOIN-Logik. App-Level
-- filtert immer via instance, daher reicht hier RLS auf SYSTEM-Niveau.
ALTER TABLE "workflow_item_comment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wf_item_comment_tenant" ON "workflow_item_comment"
  USING (
    EXISTS (
      SELECT 1 FROM "workflow_item" wi
      JOIN "workflow_instance" wfi ON wfi.id = wi.instance_id
      WHERE wi.id = workflow_item_comment.item_id
        AND wfi.tenant_id = current_setting('app.current_tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "workflow_item" wi
      JOIN "workflow_instance" wfi ON wfi.id = wi.instance_id
      WHERE wi.id = workflow_item_comment.item_id
        AND wfi.tenant_id = current_setting('app.current_tenant_id', true)::uuid
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_item_comment" TO taxtronik_app;
