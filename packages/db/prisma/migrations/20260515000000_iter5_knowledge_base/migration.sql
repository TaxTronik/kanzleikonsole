-- =============================================================================
-- Iter. 5: Knowledge Base mit Postgres-Volltextsuche (deutsch)
--
-- - kb_category (hierarchisch)
-- - kb_article (Markdown-Body + tsvector als generated column)
-- =============================================================================

CREATE TABLE "kb_category" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"  UUID         NOT NULL,
    "name"       TEXT         NOT NULL,
    "slug"       TEXT         NOT NULL,
    "parent_id"  UUID,
    "sort_order" INTEGER      NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_category_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "kb_category_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kb_category_parent_id_fkey"
        FOREIGN KEY ("parent_id") REFERENCES "kb_category"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "kb_category_tenant_id_slug_key" ON "kb_category"("tenant_id", "slug");
CREATE INDEX "kb_category_tenant_id_parent_id_idx" ON "kb_category"("tenant_id", "parent_id");

CREATE TABLE "kb_article" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"   UUID         NOT NULL,
    "category_id" UUID,
    "title"       TEXT         NOT NULL,
    "slug"        TEXT         NOT NULL,
    "body"        TEXT         NOT NULL,
    -- Generated tsvector: title 3x gewichten ('A'), body normal ('B').
    -- 'german' ist die deutsche Snowball-Konfiguration mit Stemming.
    "search_vec"  tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(body,  '')), 'B')
    ) STORED,
    "author_id"   UUID         NOT NULL,
    "published"   BOOLEAN      NOT NULL DEFAULT TRUE,
    "view_count"  INTEGER      NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_article_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "kb_article_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kb_article_category_id_fkey"
        FOREIGN KEY ("category_id") REFERENCES "kb_category"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "kb_article_tenant_id_slug_key" ON "kb_article"("tenant_id", "slug");
CREATE INDEX "kb_article_tenant_id_category_id_idx" ON "kb_article"("tenant_id", "category_id");
CREATE INDEX "kb_article_tenant_id_published_idx"   ON "kb_article"("tenant_id", "published");
CREATE INDEX "kb_article_search_vec_idx" ON "kb_article" USING GIN ("search_vec");

-- RLS
ALTER TABLE "kb_category" ENABLE ROW LEVEL SECURITY;
CREATE POLICY kb_category_isolation ON "kb_category"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "kb_article" ENABLE ROW LEVEL SECURITY;
CREATE POLICY kb_article_isolation ON "kb_article"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_category" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_article"  TO taxtronik_app;
