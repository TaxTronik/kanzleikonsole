import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const overview = read('../page.tsx');
const articleView = read('../[id]/page.tsx');
const actions = read('../actions.ts');
const inlineCategory = read('../inline-category-form.tsx');
const editor = read('../article-editor.tsx');
const richEditor = read('../rich-markdown-editor.tsx');
const editorExtensions = read('../knowledge-editor-extensions.ts');
const newPage = read('../new/page.tsx');
const editPage = read('../[id]/edit/page.tsx');
const uploadRoute = read('../../../../api/staff/knowledge/attachments/route.ts');
const attachmentRoute = read('../../../../api/staff/knowledge/attachments/[id]/route.ts');

describe('Wissensdatenbank UI', () => {
  it('legt Kategorien ohne Seitenwechsel inline an', () => {
    expect(overview).toContain('<InlineCategoryForm');
    expect(overview).not.toContain('href="/staff/knowledge/categories/new"');
    expect(inlineCategory).toContain('router.refresh()');
    expect(inlineCategory).not.toContain('router.push(');
    expect(inlineCategory).toContain('className="relative mt-3 flex items-center gap-1.5"');
    expect(inlineCategory).not.toContain('Neue Kategorie</p>');
  });

  it('zeigt Verfasser und ursprüngliches Erstellungsdatum in Liste, Suche und Artikelansicht', () => {
    expect(overview).toContain('staffNames.get(a.authorId)');
    expect(overview).toContain('Erstellt am {fmtDateShort(a.createdAt)}');
    expect(overview).toContain('{h.authorName}');
    expect(actions).toContain('author_name: string');
    expect(actions).toContain('a.created_at');
    expect(articleView).toContain('Verfasst von {article.authorName}');
    expect(articleView).toContain('Erstellt am {fmtDateShort(article.createdAt)}');
  });

  it('stellt eine große Inline-Arbeitsfläche mit Markdown-Quellansicht und Uploads bereit', () => {
    expect(richEditor).toContain("useState<'inline' | 'source'>('inline')");
    expect(richEditor).toContain("contentType: 'markdown'");
    expect(richEditor).toContain('editor.getMarkdown()');
    expect(richEditor).toContain('<EditorContent editor={editor} />');
    expect(richEditor).toContain('min-h-[64vh]');
    expect(richEditor).toContain('Überschrift 1');
    expect(richEditor).toContain('Überschrift 2');
    expect(richEditor).toContain('setColor(event.target.value)');
    expect(richEditor).toContain('setBackgroundColor(event.target.value)');
    expect(editorExtensions).toContain('MarkdownTextStyle');
    expect(editorExtensions).toContain('Image.configure({ allowBase64: false })');
    expect(editor).toContain("fetch('/api/staff/knowledge/attachments'");
    expect(editor).toContain('<input type="hidden" name="body" value={body} />');
    expect(newPage).toContain('max-w-[1600px]');
    expect(editPage).toContain('max-w-[1600px]');
    expect(newPage).toContain('draftToken={randomUUID()}');
  });
});

describe('Wissensanhänge', () => {
  it('nutzt die begrenzte, geprüfte Dokumentablage und kompensiert Fehler', () => {
    expect(uploadRoute).toContain('parseMultipartUpload(req)');
    expect(uploadRoute).toContain("staffActionGuard({ module: 'knowledge' })");
    expect(uploadRoute).toContain('commitBytesWithTier({');
    expect(uploadRoute).toContain("classification: 'GENERAL'");
    expect(uploadRoute).toContain('compensateStorageCommit({');
  });

  it('liefert nur saubere Anhänge mandanten- und entwurfsgebunden aus', () => {
    expect(attachmentRoute).toContain('tenantId: guard.tenantId');
    expect(attachmentRoute).toContain("scanStatus !== 'CLEAN'");
    expect(attachmentRoute).toContain(
      'entry.articleId === null && entry.uploadedBy !== guard.staffId',
    );
    expect(attachmentRoute).toContain("'cache-control': 'private, no-store'");
  });
});
