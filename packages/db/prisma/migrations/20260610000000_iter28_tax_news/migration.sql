-- =============================================================================
-- Iter. 28: BMF/BFH-RSS-Feeds für Mitarbeiter
--
-- Worker zieht täglich frühmorgens die offiziellen RSS-Feeds von
-- Bundesfinanzministerium und Bundesfinanzhof, dedupliziert nach
-- (source, guid) und speichert die Einträge global (nicht tenant-spezifisch,
-- da es sich um öffentliche Quellen handelt — ein einziger Datensatz wird
-- von allen Tenants geteilt, das spart Bandbreite und Speicher).
--
-- Mitarbeiter können pro Person opt-in für Benachrichtigungen bei neuen
-- Einträgen. Default OFF — kein Spam.
-- =============================================================================

CREATE TABLE "tax_news_item" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  -- BMF | BFH (Freitext, damit später weitere Quellen ohne Migration möglich)
  "source"       TEXT NOT NULL,
  -- RSS-GUID oder Link-Hash — eindeutig pro Quelle
  "guid"         TEXT NOT NULL,
  "title"        TEXT NOT NULL,
  "summary"      TEXT,
  "link"         TEXT NOT NULL,
  "published_at" TIMESTAMP(3),
  "fetched_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tax_news_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_news_item_source_guid_key" ON "tax_news_item" ("source", "guid");
CREATE INDEX "tax_news_item_published_idx" ON "tax_news_item" ("published_at" DESC);
CREATE INDEX "tax_news_item_fetched_idx" ON "tax_news_item" ("fetched_at" DESC);

-- Opt-in pro Mitarbeiter
ALTER TABLE "staff_user"
  ADD COLUMN "tax_news_notify" BOOLEAN NOT NULL DEFAULT FALSE;

-- Notification-Kind erweitern
ALTER TYPE "notification_kind" ADD VALUE 'TAX_NEWS_NEW';
