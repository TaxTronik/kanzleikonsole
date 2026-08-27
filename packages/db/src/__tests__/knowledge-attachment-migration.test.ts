import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260826021500_kb_article_attachments/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Wissensanhang-Migration', () => {
  it('bindet jeden Anhang an genau ein internes Dokument', () => {
    expect(migration).toContain('CREATE TABLE "kb_attachment"');
    expect(migration).toContain('CREATE UNIQUE INDEX "kb_attachment_document_id_key"');
    expect(migration).toContain('REFERENCES "document"("id") ON DELETE CASCADE');
    expect(migration).toContain('REFERENCES "kb_article"("id") ON DELETE CASCADE');
  });

  it('erzwingt die Mandantentrennung auch für direkte Datenbankzugriffe', () => {
    expect(migration).toContain('ALTER TABLE "kb_attachment" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "kb_attachment" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('USING ("tenant_id" = app.current_tenant_id())');
    expect(migration).toContain('WITH CHECK ("tenant_id" = app.current_tenant_id())');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_attachment" TO taxtronik_app',
    );
  });
});
