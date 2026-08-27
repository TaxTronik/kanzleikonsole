BEGIN;

CREATE TABLE "kb_attachment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "article_id" UUID,
  "document_id" UUID NOT NULL,
  "draft_token" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "uploaded_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kb_attachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kb_attachment_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "kb_attachment_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "kb_article"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "kb_attachment_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "kb_attachment_document_id_key"
  ON "kb_attachment"("document_id");
CREATE INDEX "kb_attachment_tenant_id_article_id_idx"
  ON "kb_attachment"("tenant_id", "article_id");
CREATE INDEX "kb_attachment_tenant_id_draft_token_idx"
  ON "kb_attachment"("tenant_id", "draft_token");

ALTER TABLE "kb_attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_attachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_attachment_isolation ON "kb_attachment"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_attachment" TO taxtronik_app;

COMMIT;
