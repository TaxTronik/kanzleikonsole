-- =============================================================================
-- iter69: Wiederverwendbare Prompt-Vorlagen für Recherche-Aufträge (kanzleiweit).
--
-- Der Berater wählt im Composer eine Vorlage (Titel + Prompt) und kann eigene
-- anlegen — geteilt über die ganze Kanzlei. Tenant-scoped mit RLS (Muster
-- iter60/iter63). `created_by_id` ist eine reine Mitarbeiter-UUID ohne FK
-- (Mitarbeiter werden deaktiviert, nicht gelöscht).
-- =============================================================================

-- CreateTable
CREATE TABLE "risk_prompt_template" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_prompt_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_prompt_template_tenant_id_title_idx" ON "risk_prompt_template"("tenant_id", "title");

-- AddForeignKey
ALTER TABLE "risk_prompt_template" ADD CONSTRAINT "risk_prompt_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row Level Security — tenant-Isolation (Backstop).
-- =============================================================================
ALTER TABLE "risk_prompt_template" ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_prompt_template_isolation ON "risk_prompt_template"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_prompt_template" TO taxtronik_app;
