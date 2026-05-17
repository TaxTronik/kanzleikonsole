-- =============================================================================
-- Iter. 20: Custom-Felder am Mandanten
--
-- Kanzleien definieren eigene Felder (z. B. „Branche",
-- „Geschäftsbereich", „Mitarbeiteranzahl") die am Mandant erfasst und
-- bearbeitet werden können. Pro Mandantentyp (NATPERS/JURPERS/PERSGES)
-- konfigurierbar oder „für alle Typen". Werte werden in einer schlanken
-- value-Tabelle gehalten — keine dynamischen Spalten am client.
-- =============================================================================

CREATE TYPE "client_custom_field_type" AS ENUM (
  'TEXT', 'TEXTAREA', 'NUMBER', 'MONEY', 'DATE', 'SELECT', 'CHECKBOX', 'URL'
);

CREATE TABLE "client_custom_field_def" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL,
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "type"        "client_custom_field_type" NOT NULL,
  "options"     JSONB,
  "applies_to"  "client_kind"[],
  "position"    INT NOT NULL DEFAULT 0,
  "help_text"   TEXT,
  "active"      BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_custom_field_def_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_custom_field_def_tenant_key_key"
  ON "client_custom_field_def" ("tenant_id", "key");
CREATE INDEX "client_custom_field_def_tenant_position_idx"
  ON "client_custom_field_def" ("tenant_id", "position");

ALTER TABLE "client_custom_field_def"
  ADD CONSTRAINT "client_custom_field_def_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

ALTER TABLE "client_custom_field_def" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_custom_field_def_isolation ON "client_custom_field_def"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Werte pro Mandant + Feld
-- -----------------------------------------------------------------------------

CREATE TABLE "client_custom_field_value" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL,
  "client_id"   UUID NOT NULL,
  "field_id"    UUID NOT NULL,
  "value"       JSONB,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by"  UUID,
  CONSTRAINT "client_custom_field_value_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_custom_field_value_client_field_key"
  ON "client_custom_field_value" ("client_id", "field_id");
CREATE INDEX "client_custom_field_value_tenant_client_idx"
  ON "client_custom_field_value" ("tenant_id", "client_id");

ALTER TABLE "client_custom_field_value"
  ADD CONSTRAINT "client_custom_field_value_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "client_custom_field_value"
  ADD CONSTRAINT "client_custom_field_value_client_fk"
  FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE;
ALTER TABLE "client_custom_field_value"
  ADD CONSTRAINT "client_custom_field_value_field_fk"
  FOREIGN KEY ("field_id") REFERENCES "client_custom_field_def"("id") ON DELETE CASCADE;

ALTER TABLE "client_custom_field_value" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_custom_field_value_isolation ON "client_custom_field_value"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
