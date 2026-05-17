-- Iter. 41 — Rechnungstypen für EXTERNAL-Modus
--
-- Im EXTERNAL-Rechnungsmodus (PDF-Upload aus zentraler Software) braucht
-- die Kanzlei kategorisierbare Rechnungstypen: Honorar, Mahnung, Beratung
-- etc. Pro Typ kann eine E-Mail-Template-Slug-Referenz hinterlegt werden,
-- damit der Begleittext je nach Typ unterschiedlich ausfallen kann.
--
-- Optional auf Invoice: category_id (FK, SET NULL bei Löschung) — der
-- Eintrag bleibt bestehen, auch wenn die Kategorie später entfernt wird.

CREATE TABLE "invoice_category" (
    "id"                 UUID    NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"          UUID    NOT NULL,
    "name"               TEXT    NOT NULL,
    "slug"               TEXT    NOT NULL,
    "email_template_slug" TEXT,
    "active"             BOOLEAN NOT NULL DEFAULT true,
    "sort_order"         INT     NOT NULL DEFAULT 0,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "invoice_category_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_category_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "invoice_category_tenant_slug_key" ON "invoice_category"("tenant_id", "slug");
CREATE INDEX "invoice_category_tenant_active_idx" ON "invoice_category"("tenant_id", "active");

ALTER TABLE "invoice_category" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_category_isolation ON "invoice_category"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_category" TO taxtronik_app;

ALTER TABLE "invoice"
    ADD COLUMN "category_id" UUID;
ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_category_id_fkey"
        FOREIGN KEY ("category_id") REFERENCES "invoice_category"("id") ON DELETE SET NULL;
CREATE INDEX "invoice_tenant_category_idx" ON "invoice"("tenant_id", "category_id");

-- Default-Rechnungstypen pro Tenant seeden — die Kanzlei kann später eigene
-- ergänzen oder die Defaults umbenennen / deaktivieren.

INSERT INTO "invoice_category" ("tenant_id", "name", "slug", "sort_order", "updated_at")
SELECT t."id", v.name, v.slug, v.sort_order, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('Honorar', 'honorar', 10),
  ('Beratung', 'beratung', 20),
  ('Mahnung', 'mahnung', 30),
  ('Storno', 'storno', 40)
) AS v(name, slug, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "invoice_category" ic
  WHERE ic."tenant_id" = t."id" AND ic."slug" = v.slug
);
