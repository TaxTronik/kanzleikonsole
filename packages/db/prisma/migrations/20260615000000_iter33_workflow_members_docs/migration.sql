-- =============================================================================
-- Iter. 33 — Workflow-Mitglieder + Dokumente pro Schritt
-- =============================================================================

-- Document → optionale Workflow-Item-Verknüpfung. SetNull beim Item-Delete,
-- damit das Dokument GoBD-konform erhalten bleibt.
ALTER TABLE "document"
  ADD COLUMN "workflow_item_id" UUID,
  ADD CONSTRAINT "document_workflow_item_fk"
    FOREIGN KEY ("workflow_item_id") REFERENCES "workflow_item"("id") ON DELETE SET NULL;
CREATE INDEX "document_workflow_item_idx" ON "document"("workflow_item_id");

-- WorkflowInstanceMember — Team pro Instanz
CREATE TABLE "workflow_instance_member" (
  "instance_id" UUID NOT NULL,
  "staff_id"    UUID NOT NULL,
  "role"        TEXT,
  "added_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "added_by"    UUID NOT NULL,
  CONSTRAINT "wf_instance_member_pk" PRIMARY KEY ("instance_id", "staff_id"),
  CONSTRAINT "wf_instance_member_instance_fk"
    FOREIGN KEY ("instance_id") REFERENCES "workflow_instance"("id") ON DELETE CASCADE
);
CREATE INDEX "wf_instance_member_staff_idx" ON "workflow_instance_member"("staff_id");

ALTER TABLE "workflow_instance_member" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wf_instance_member_tenant" ON "workflow_instance_member"
  USING (
    EXISTS (
      SELECT 1 FROM "workflow_instance" wfi
      WHERE wfi.id = workflow_instance_member.instance_id
        AND wfi.tenant_id = current_setting('app.current_tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "workflow_instance" wfi
      WHERE wfi.id = workflow_instance_member.instance_id
        AND wfi.tenant_id = current_setting('app.current_tenant_id', true)::uuid
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_instance_member" TO taxtronik_app;
