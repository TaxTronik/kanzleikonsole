-- =============================================================================
-- iter54: Frei anlegbare Ablage-Ordner (Baum) für Dokumente.
--
-- Scope-Entscheidung (User): Ordnerbaum PRO MANDANT + ein kanzlei-interner
-- Bereich für mandantenlose Dokumente. client_id = NULL → kanzlei-intern.
-- parent_id = NULL → Wurzelebene dieses Bereichs.
--
-- WICHTIG: Ordner sind reine Organisation und UNABHÄNGIG von
-- document.classification. Die Klassifikation treibt weiterhin Retention /
-- Object-Lock / Bucket — der Ordner verschiebt nichts im Object-Store.
-- document.folder_id ist ON DELETE SET NULL: ein gelöschter Ordner darf NIE
-- ein Dokument mitlöschen (§ 147 AO / § 8 Abs. 4 GwG — Aufbewahrung). Die
-- App reparentiert Inhalte vor dem Löschen in den Parent.
-- =============================================================================

CREATE TABLE "document_folder" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID NOT NULL,
    "client_id"        UUID,
    "parent_id"        UUID,
    "name"             TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_by_staff" UUID,
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "document_folder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_folder_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "document_folder_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "document_folder_parent_id_fkey"
        FOREIGN KEY ("parent_id") REFERENCES "document_folder"("id") ON DELETE CASCADE
);

CREATE INDEX "document_folder_tenant_id_client_id_idx"
    ON "document_folder" ("tenant_id", "client_id");
CREATE INDEX "document_folder_parent_id_idx"
    ON "document_folder" ("parent_id");

-- Keine zwei gleichnamigen Ordner auf derselben Ebene desselben Bereichs.
-- NULL-spalten via Sentinel-UUID normalisieren (sonst behandelt Postgres
-- NULL als distinct und Dubletten auf Wurzel-/kanzlei-intern-Ebene wären
-- möglich). Name case-insensitiv eindeutig.
CREATE UNIQUE INDEX "document_folder_level_name_uniq" ON "document_folder" (
    "tenant_id",
    COALESCE("client_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),
    lower("name")
);

ALTER TABLE "document_folder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_folder_isolation ON "document_folder"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "document_folder" TO taxtronik_app;

-- Document → optionaler Ordner. SET NULL: Ordner-Löschung lässt das
-- Dokument bestehen (Aufbewahrungspflicht).
ALTER TABLE "document"
    ADD COLUMN "folder_id" UUID;
ALTER TABLE "document"
    ADD CONSTRAINT "document_folder_id_fkey"
        FOREIGN KEY ("folder_id") REFERENCES "document_folder"("id") ON DELETE SET NULL;
CREATE INDEX "document_tenant_id_folder_id_idx"
    ON "document" ("tenant_id", "folder_id");
