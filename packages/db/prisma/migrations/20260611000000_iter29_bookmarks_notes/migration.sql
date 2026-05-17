-- =============================================================================
-- Iter. 29: Persönliche Bookmarks + Notizen pro Mitarbeiter
--
-- staff_bookmark   — generischer Lesezeichen-Speicher; verweist über
--                    (resource_type, resource_id) auf eine beliebige
--                    Ressource (zunächst tax_news_item, perspektivisch
--                    auch andere). Label + href als Snapshot, damit auch
--                    nach Löschung der Quelle das Lesezeichen lesbar bleibt.
-- staff_note       — freie Kurz-Notizen (Markdown), reine Privat-Sicht.
-- =============================================================================

CREATE TABLE "staff_bookmark" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID NOT NULL,
  "staff_id"      UUID NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id"   UUID NOT NULL,
  "label"         TEXT NOT NULL,
  "href"          TEXT,
  "note"          TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_bookmark_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_bookmark_staff_resource_key"
  ON "staff_bookmark" ("staff_id", "resource_type", "resource_id");
CREATE INDEX "staff_bookmark_staff_created_idx"
  ON "staff_bookmark" ("staff_id", "created_at" DESC);

ALTER TABLE "staff_bookmark"
  ADD CONSTRAINT "staff_bookmark_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "staff_bookmark"
  ADD CONSTRAINT "staff_bookmark_staff_fk"
  FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE;

ALTER TABLE "staff_bookmark" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_bookmark_isolation ON "staff_bookmark"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- -----------------------------------------------------------------------------

CREATE TABLE "staff_note" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  UUID NOT NULL,
  "staff_id"   UUID NOT NULL,
  "body"       TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_note_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staff_note_staff_idx"
  ON "staff_note" ("staff_id", "created_at" DESC);

ALTER TABLE "staff_note"
  ADD CONSTRAINT "staff_note_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "staff_note"
  ADD CONSTRAINT "staff_note_staff_fk"
  FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE;

ALTER TABLE "staff_note" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_note_isolation ON "staff_note"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
