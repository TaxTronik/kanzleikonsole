-- Iter. 36 — RSS-Reader (vormals BFH/BMF News)
--
-- Jeder Mitarbeiter abonniert seine eigenen RSS-Feeds. Default-Feeds (BMF +
-- BFH) werden für bestehende und neu angelegte Staff automatisch gesetzt;
-- der User kann sie deaktivieren oder löschen wie jeden anderen Feed.
--
-- tax_news_item bleibt als globaler Item-Cache pro Feed-URL (source = URL).
-- Items werden nicht pro User dupliziert — Worker fetcht jede distinct URL
-- nur einmal pro Lauf. Sichtbarkeit ergibt sich aus dem RssFeed-Match.
--
-- Bestehende tax_news_item-Zeilen haben source='BMF'/'BFH' (Codes), nicht
-- URLs. Wir leeren die Tabelle einmal — der Worker zieht morgens neu nach.

-- 1. RssFeed-Tabelle ----------------------------------------------------------

CREATE TABLE "rss_feed" (
    "id"         UUID    NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"  UUID    NOT NULL,
    "staff_id"   UUID    NOT NULL,
    "name"       TEXT    NOT NULL,
    "url"        TEXT    NOT NULL,
    "color"      TEXT,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INT     NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "rss_feed_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rss_feed_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "rss_feed_staff_id_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "rss_feed_staff_id_url_key" ON "rss_feed"("staff_id", "url");
CREATE INDEX "rss_feed_tenant_staff_active_idx"
    ON "rss_feed"("tenant_id", "staff_id", "active");

-- 2. RLS + GRANT --------------------------------------------------------------

ALTER TABLE "rss_feed" ENABLE ROW LEVEL SECURITY;
CREATE POLICY rss_feed_isolation ON "rss_feed"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "rss_feed" TO taxtronik_app;

-- 3. Alte tax_news_items leeren ----------------------------------------------
--    (Worker fetcht beim nächsten Lauf neu mit URL als source.)

DELETE FROM "tax_news_item";

-- 4. Default-Feeds für bestehende Staff seeden -------------------------------
--    Jeder aktive Staff bekommt BMF + BFH initial gesetzt.

INSERT INTO "rss_feed" ("tenant_id", "staff_id", "name", "url", "color", "sort_order")
SELECT
    s."tenant_id",
    s."id",
    'BMF',
    'https://www.bundesfinanzministerium.de/SiteGlobals/Functions/RSSFeed/DE/Aktuelles/RSSAktuelles.xml',
    'blue',
    10
FROM "staff_user" s
WHERE s."active" = true
ON CONFLICT ("staff_id", "url") DO NOTHING;

INSERT INTO "rss_feed" ("tenant_id", "staff_id", "name", "url", "color", "sort_order")
SELECT
    s."tenant_id",
    s."id",
    'BFH',
    'https://www.bundesfinanzhof.de/de/precedent.rss',
    'purple',
    20
FROM "staff_user" s
WHERE s."active" = true
ON CONFLICT ("staff_id", "url") DO NOTHING;
