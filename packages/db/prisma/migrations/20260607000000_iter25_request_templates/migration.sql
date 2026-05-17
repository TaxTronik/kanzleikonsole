-- =============================================================================
-- Iter. 25: Anforderungs-Vorlagen (RequestTemplate)
--
-- Standard-Anforderungen (FiBu, Lohnunterlagen, Jahresabschluss, USt-Belege …),
-- die Kanzleien wiederkehrend an Mandanten schicken. Optional kann eine
-- FormTemplate verknüpft sein — beim Erstellen aus der Vorlage wird dann
-- automatisch eine FormSubmission angelegt und an die Anforderung gehängt.
-- =============================================================================

CREATE TABLE "request_template" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"         UUID NOT NULL,
  "name"              TEXT NOT NULL,
  "category"          TEXT,
  "title"             TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "priority"          "request_priority" NOT NULL DEFAULT 'NORMAL',
  "due_after_days"    INT,
  "form_template_id"  UUID,
  "active"            BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order"        INT NOT NULL DEFAULT 0,
  "created_by_staff"  UUID,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "request_template_tenant_name_key" ON "request_template" ("tenant_id", "name");
CREATE INDEX "request_template_tenant_sort_idx" ON "request_template" ("tenant_id", "sort_order");

ALTER TABLE "request_template"
  ADD CONSTRAINT "request_template_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "request_template"
  ADD CONSTRAINT "request_template_form_template_fk"
  FOREIGN KEY ("form_template_id") REFERENCES "form_template"("id") ON DELETE SET NULL;

ALTER TABLE "request_template" ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_template_isolation ON "request_template"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Anforderung kann optional ein bereits angelegtes Formular tragen
ALTER TABLE "request"
  ADD COLUMN "form_submission_id" UUID;
ALTER TABLE "request"
  ADD CONSTRAINT "request_form_submission_fk"
  FOREIGN KEY ("form_submission_id") REFERENCES "form_submission"("id") ON DELETE SET NULL;
