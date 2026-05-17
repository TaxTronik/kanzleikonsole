-- =============================================================================
-- Iter. 14: Workflow-Builder (Checklisten-Templates pro Mandant)
-- =============================================================================

CREATE TYPE "workflow_instance_status" AS ENUM ('ACTIVE','COMPLETED','CANCELLED');

CREATE TABLE "workflow_template" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"        UUID NOT NULL,
    "name"             TEXT NOT NULL,
    "description"      TEXT,
    "default_skill_id" UUID,
    "active"           BOOLEAN NOT NULL DEFAULT TRUE,
    "created_by_staff" UUID NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflow_template_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_template_default_skill_fkey"
        FOREIGN KEY ("default_skill_id") REFERENCES "staff_skill"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "workflow_template_tenant_id_name_key" ON "workflow_template"("tenant_id","name");
CREATE INDEX "workflow_template_tenant_id_idx" ON "workflow_template"("tenant_id");

ALTER TABLE "workflow_template" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_template_isolation ON "workflow_template"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

CREATE TABLE "workflow_step" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "template_id"    UUID NOT NULL,
    "position"       INT NOT NULL,
    "title"          TEXT NOT NULL,
    "description"    TEXT,
    "due_after_days" INT,
    "skill_id"       UUID,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_step_template_fkey"
        FOREIGN KEY ("template_id") REFERENCES "workflow_template"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_step_skill_fkey"
        FOREIGN KEY ("skill_id") REFERENCES "staff_skill"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "workflow_step_template_id_position_key" ON "workflow_step"("template_id","position");
CREATE INDEX "workflow_step_template_id_idx" ON "workflow_step"("template_id");

-- Indirekte RLS via Subquery
ALTER TABLE "workflow_step" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_step_isolation ON "workflow_step"
    USING (EXISTS (
        SELECT 1 FROM "workflow_template" t
        WHERE t.id = "workflow_step"."template_id"
          AND t.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "workflow_template" t
        WHERE t.id = "workflow_step"."template_id"
          AND t.tenant_id = app.current_tenant_id()
    ));

CREATE TABLE "workflow_instance" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"        UUID NOT NULL,
    "client_id"        UUID NOT NULL,
    "template_id"      UUID NOT NULL,
    "name"             TEXT NOT NULL,
    "status"           "workflow_instance_status" NOT NULL DEFAULT 'ACTIVE',
    "started_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"     TIMESTAMP(3),
    "started_by_staff" UUID NOT NULL,
    "notes"            TEXT,
    CONSTRAINT "workflow_instance_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_instance_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_instance_template_fkey"
        FOREIGN KEY ("template_id") REFERENCES "workflow_template"("id") ON DELETE RESTRICT
);

CREATE INDEX "workflow_instance_tenant_id_client_id_status_idx"
    ON "workflow_instance"("tenant_id","client_id","status");
CREATE INDEX "workflow_instance_tenant_id_status_started_at_idx"
    ON "workflow_instance"("tenant_id","status","started_at");

ALTER TABLE "workflow_instance" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_instance_isolation ON "workflow_instance"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

CREATE TABLE "workflow_item" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "instance_id"       UUID NOT NULL,
    "position"          INT NOT NULL,
    "title"             TEXT NOT NULL,
    "description"       TEXT,
    "assignee_staff_id" UUID,
    "skill_id"          UUID,
    "due_date"          DATE,
    "done_at"           TIMESTAMP(3),
    "done_by_staff"     UUID,
    "notes"             TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflow_item_instance_fkey"
        FOREIGN KEY ("instance_id") REFERENCES "workflow_instance"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_item_skill_fkey"
        FOREIGN KEY ("skill_id") REFERENCES "staff_skill"("id") ON DELETE SET NULL
);

CREATE INDEX "workflow_item_instance_id_position_idx" ON "workflow_item"("instance_id","position");
CREATE INDEX "workflow_item_assignee_staff_id_done_at_idx" ON "workflow_item"("assignee_staff_id","done_at");

ALTER TABLE "workflow_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_item_isolation ON "workflow_item"
    USING (EXISTS (
        SELECT 1 FROM "workflow_instance" i
        WHERE i.id = "workflow_item"."instance_id"
          AND i.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "workflow_instance" i
        WHERE i.id = "workflow_item"."instance_id"
          AND i.tenant_id = app.current_tenant_id()
    ));
