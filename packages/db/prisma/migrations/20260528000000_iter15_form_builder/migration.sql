-- =============================================================================
-- Iter. 15: Form-Builder — eigene Anfrage-Formulare an Mandanten
-- =============================================================================

CREATE TYPE "form_field_type" AS ENUM (
  'TEXT','TEXTAREA','NUMBER','MONEY','DATE','EMAIL','PHONE',
  'SELECT','MULTISELECT','CHECKBOX','FILE','INFO_TEXT'
);

CREATE TYPE "form_submission_status" AS ENUM (
  'PENDING','DRAFT','SUBMITTED','REVIEWED'
);

CREATE TABLE "form_template" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        UUID NOT NULL,
  "name"             TEXT NOT NULL,
  "description"      TEXT,
  "intro_md"         TEXT,
  "active"           BOOLEAN NOT NULL DEFAULT TRUE,
  "created_by_staff" UUID NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "form_template_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "form_template_tenant_id_name_key" ON "form_template"("tenant_id","name");
CREATE INDEX "form_template_tenant_id_idx" ON "form_template"("tenant_id");

ALTER TABLE "form_template" ENABLE ROW LEVEL SECURITY;
CREATE POLICY form_template_isolation ON "form_template"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

CREATE TABLE "form_field" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id"   UUID NOT NULL,
  "position"      INT NOT NULL,
  "key"           TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "type"          "form_field_type" NOT NULL,
  "required"      BOOLEAN NOT NULL DEFAULT FALSE,
  "options"       JSONB,
  "help_text"     TEXT,
  "default_value" TEXT,
  "min_value"     TEXT,
  "max_value"     TEXT,
  CONSTRAINT "form_field_template_fkey"
    FOREIGN KEY ("template_id") REFERENCES "form_template"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "form_field_template_id_position_key" ON "form_field"("template_id","position");
CREATE UNIQUE INDEX "form_field_template_id_key_key" ON "form_field"("template_id","key");
CREATE INDEX "form_field_template_id_idx" ON "form_field"("template_id");

ALTER TABLE "form_field" ENABLE ROW LEVEL SECURITY;
CREATE POLICY form_field_isolation ON "form_field"
  USING (EXISTS (
    SELECT 1 FROM "form_template" t
    WHERE t.id = "form_field"."template_id"
      AND t.tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "form_template" t
    WHERE t.id = "form_field"."template_id"
      AND t.tenant_id = app.current_tenant_id()
  ));

CREATE TABLE "form_submission" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             UUID NOT NULL,
  "template_id"           UUID NOT NULL,
  "client_id"             UUID NOT NULL,
  "request_id"            UUID,
  "status"                "form_submission_status" NOT NULL DEFAULT 'PENDING',
  "name"                  TEXT NOT NULL,
  "answers"               JSONB NOT NULL DEFAULT '{}'::jsonb,
  "submitted_by_contact"  UUID,
  "submitted_at"          TIMESTAMP(3),
  "reviewed_at"           TIMESTAMP(3),
  "reviewed_by_staff"     UUID,
  "review_notes"          TEXT,
  "created_by_staff"      UUID NOT NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "form_submission_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "form_submission_template_fkey"
    FOREIGN KEY ("template_id") REFERENCES "form_template"("id") ON DELETE RESTRICT,
  CONSTRAINT "form_submission_client_fkey"
    FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE
);

CREATE INDEX "form_submission_tenant_id_client_id_status_idx"
  ON "form_submission"("tenant_id","client_id","status");
CREATE INDEX "form_submission_tenant_id_status_created_at_idx"
  ON "form_submission"("tenant_id","status","created_at");

ALTER TABLE "form_submission" ENABLE ROW LEVEL SECURITY;
CREATE POLICY form_submission_isolation ON "form_submission"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
