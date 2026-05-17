-- =============================================================================
-- Iter. 22: Status-Maschinen-Builder
--
-- Kanzlei definiert eigene Zustandsautomaten (z. B.
-- „Mandanten-Onboarding-Phase", „Steuererklärungs-Workflow").
-- Drei Tabellen:
--   * state_machine        — Definition (Name, Geltungsbereich)
--   * state_machine_state  — Zustände (Knoten)
--   * state_machine_transition — Übergänge (Kanten)
--
-- Das eigentliche Anwenden an Ressourcen (Mandant, GwG-Check, …)
-- folgt in einem späteren Schritt — hier wird nur der Editor mit
-- Persistenz bereitgestellt.
-- =============================================================================

CREATE TABLE "state_machine" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL,
  "slug"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "applies_to"  TEXT,
  "active"      BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_machine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "state_machine_tenant_slug_key"
  ON "state_machine" ("tenant_id", "slug");

ALTER TABLE "state_machine"
  ADD CONSTRAINT "state_machine_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

ALTER TABLE "state_machine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY state_machine_isolation ON "state_machine"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Zustände
-- ---------------------------------------------------------------------------

CREATE TABLE "state_machine_state" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL,
  "machine_id"  UUID NOT NULL,
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "color"       TEXT,
  "position"    INT NOT NULL DEFAULT 0,
  "is_initial"  BOOLEAN NOT NULL DEFAULT FALSE,
  "is_terminal" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "state_machine_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "state_machine_state_machine_key_key"
  ON "state_machine_state" ("machine_id", "key");
CREATE INDEX "state_machine_state_tenant_machine_idx"
  ON "state_machine_state" ("tenant_id", "machine_id");

ALTER TABLE "state_machine_state"
  ADD CONSTRAINT "state_machine_state_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "state_machine_state"
  ADD CONSTRAINT "state_machine_state_machine_fk"
  FOREIGN KEY ("machine_id") REFERENCES "state_machine"("id") ON DELETE CASCADE;

ALTER TABLE "state_machine_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY state_machine_state_isolation ON "state_machine_state"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Übergänge
-- ---------------------------------------------------------------------------

CREATE TABLE "state_machine_transition" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"      UUID NOT NULL,
  "machine_id"     UUID NOT NULL,
  "from_state_id"  UUID NOT NULL,
  "to_state_id"    UUID NOT NULL,
  "label"          TEXT NOT NULL,
  "condition_note" TEXT,
  CONSTRAINT "state_machine_transition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "state_machine_transition_machine_idx"
  ON "state_machine_transition" ("machine_id");

ALTER TABLE "state_machine_transition"
  ADD CONSTRAINT "state_machine_transition_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "state_machine_transition"
  ADD CONSTRAINT "state_machine_transition_machine_fk"
  FOREIGN KEY ("machine_id") REFERENCES "state_machine"("id") ON DELETE CASCADE;
ALTER TABLE "state_machine_transition"
  ADD CONSTRAINT "state_machine_transition_from_fk"
  FOREIGN KEY ("from_state_id") REFERENCES "state_machine_state"("id") ON DELETE CASCADE;
ALTER TABLE "state_machine_transition"
  ADD CONSTRAINT "state_machine_transition_to_fk"
  FOREIGN KEY ("to_state_id") REFERENCES "state_machine_state"("id") ON DELETE CASCADE;

ALTER TABLE "state_machine_transition" ENABLE ROW LEVEL SECURITY;
CREATE POLICY state_machine_transition_isolation ON "state_machine_transition"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
