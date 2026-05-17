-- =============================================================================
-- Iter. 13: Staff-Skills (Tätigkeitsbereiche, getrennt von Auth-Rollen)
-- =============================================================================

CREATE TABLE "staff_skill" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"  UUID NOT NULL,
    "slug"       TEXT NOT NULL,
    "label"      TEXT NOT NULL,
    "color"      TEXT,
    "is_system"  BOOLEAN NOT NULL DEFAULT FALSE,
    "sort_order" INT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_skill_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "staff_skill_tenant_id_slug_key" ON "staff_skill"("tenant_id","slug");
CREATE INDEX "staff_skill_tenant_id_idx" ON "staff_skill"("tenant_id");

ALTER TABLE "staff_skill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_skill_isolation ON "staff_skill"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

CREATE TABLE "staff_skill_assignment" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "staff_id"   UUID NOT NULL,
    "skill_id"   UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_skill_assignment_staff_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE,
    CONSTRAINT "staff_skill_assignment_skill_fkey"
        FOREIGN KEY ("skill_id") REFERENCES "staff_skill"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "staff_skill_assignment_staff_id_skill_id_key"
    ON "staff_skill_assignment"("staff_id","skill_id");
CREATE INDEX "staff_skill_assignment_staff_id_idx" ON "staff_skill_assignment"("staff_id");
CREATE INDEX "staff_skill_assignment_skill_id_idx" ON "staff_skill_assignment"("skill_id");

-- Indirekte RLS via Subquery (StaffSkillAssignment hat keine eigene tenant_id)
ALTER TABLE "staff_skill_assignment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_skill_assignment_isolation ON "staff_skill_assignment"
    USING (EXISTS (
        SELECT 1 FROM "staff_user" s
        WHERE s.id = "staff_skill_assignment"."staff_id"
          AND s.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "staff_user" s
        WHERE s.id = "staff_skill_assignment"."staff_id"
          AND s.tenant_id = app.current_tenant_id()
    ));

-- System-Skills für jeden bestehenden Tenant vorbelegen
INSERT INTO "staff_skill" ("tenant_id","slug","label","color","is_system","sort_order")
SELECT t.id, x.slug, x.label, x.color, TRUE, x.sort_order
FROM "tenant" t
CROSS JOIN (VALUES
  ('FIBU',           'Finanzbuchhaltung',  'blue',    10),
  ('LOHN',           'Lohnabrechnung',     'amber',   20),
  ('JAHRESABSCHLUSS','Jahresabschluss',    'emerald', 30),
  ('STEUER',         'Steuererklärungen',  'purple',  40),
  ('BERATUNG',       'Beratung',           'pink',    50)
) AS x(slug, label, color, sort_order);
