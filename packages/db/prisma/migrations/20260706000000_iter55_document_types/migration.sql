-- =============================================================================
-- iter55: Datei-Typen + Schutzstufen.
--
-- Entkoppelt "Typ" (Ablage-Label) von "Schutzstufe" (rechtlich: Bucket +
-- Object-Lock + Frist). Genau drei Stufen, fix: NONE / GWG (5 J.) /
-- GOBD (10 J.) — keine anderen Zeiträume.
--
-- 7 Kern-Typen werden je Tenant geseedet (builtin=true, read-only,
-- gesetzlich korrekte Stufe). Die Kanzlei kann eigene Typen ergänzen.
-- Bestehende Dokumente werden via classification → Kern-Typ verknüpft.
-- classification bleibt als Back-Compat-Spalte erhalten.
-- =============================================================================

CREATE TYPE "document_protection_tier" AS ENUM ('NONE', 'GWG', 'GOBD');

CREATE TABLE "document_type" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"          UUID NOT NULL,
    "name"               TEXT NOT NULL,
    "tier"               "document_protection_tier" NOT NULL,
    "builtin"            BOOLEAN NOT NULL DEFAULT false,
    "classification_key" TEXT,
    "active"             BOOLEAN NOT NULL DEFAULT true,
    "sort_order"         INT NOT NULL DEFAULT 0,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_by_staff"   UUID,
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "document_type_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_type_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "document_type_tenant_name_key"
    ON "document_type" ("tenant_id", "name");
CREATE INDEX "document_type_tenant_active_idx"
    ON "document_type" ("tenant_id", "active");

ALTER TABLE "document_type" ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_type_isolation ON "document_type"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_type" TO taxtronik_app;

-- 7 Kern-Typen je Tenant seeden (builtin, read-only). tier gesetzlich fix.
INSERT INTO "document_type"
  ("tenant_id", "name", "tier", "builtin", "classification_key", "sort_order", "updated_at")
SELECT t."id", v.name, v.tier::"document_protection_tier", true, v.ckey, v.so, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('GoBD Rechnung', 'GOBD', 'GOBD_INVOICE',  10),
  ('GoBD Vertrag',  'GOBD', 'GOBD_CONTRACT', 20),
  ('GoBD Steuer',   'GOBD', 'GOBD_TAX',      30),
  ('GwG Nachweis',  'GWG',  'GWG_EVIDENCE',  40),
  ('Personal',      'NONE', 'PERSONNEL',     50),
  ('Intern',        'NONE', 'STAFF_PRIVATE', 60),
  ('Allgemein',     'NONE', 'GENERAL',       70)
) AS v(name, tier, ckey, so)
WHERE NOT EXISTS (
  SELECT 1 FROM "document_type" dt
  WHERE dt."tenant_id" = t."id" AND dt."classification_key" = v.ckey
);

-- Document → Typ. SET NULL: Typ-Löschung lässt das Dokument bestehen.
ALTER TABLE "document"
    ADD COLUMN "document_type_id" UUID;
ALTER TABLE "document"
    ADD CONSTRAINT "document_document_type_id_fkey"
        FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE SET NULL;
CREATE INDEX "document_tenant_id_document_type_id_idx"
    ON "document" ("tenant_id", "document_type_id");

-- Altbestand mit dem Kern-Typ desselben Tenants verknüpfen.
UPDATE "document" d
SET "document_type_id" = dt."id"
FROM "document_type" dt
WHERE dt."tenant_id" = d."tenant_id"
  AND dt."classification_key" = d."classification"::text
  AND d."document_type_id" IS NULL;
