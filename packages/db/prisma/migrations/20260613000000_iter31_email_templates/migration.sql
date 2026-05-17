-- =============================================================================
-- Iter. 31 — E-Mail-Vorlagen
-- =============================================================================

CREATE TABLE "email_template" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"        UUID NOT NULL,
  "name"             TEXT NOT NULL,
  "category"         TEXT,
  "subject"          TEXT NOT NULL,
  "body_md"          TEXT NOT NULL,
  "active"           BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order"       INT NOT NULL DEFAULT 0,
  "created_by_staff" UUID,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ NOT NULL,
  CONSTRAINT "email_template_pk" PRIMARY KEY ("id"),
  CONSTRAINT "email_template_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "email_template_tenant_name_unique" ON "email_template"("tenant_id", "name");
CREATE INDEX "email_template_tenant_sort_idx" ON "email_template"("tenant_id", "sort_order");

-- RLS-Policy analog zu request_template
ALTER TABLE "email_template" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_template_tenant_isolation" ON "email_template"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_template" TO taxtronik_app;
