// @vitest-environment jsdom
// Wissensdatenbank-Oberfläche als Render- und Verhaltenstest (B-08, Welle 15)
// statt Quelltextprüfung: Übersicht, Artikelansicht, Inline-Kategorie,
// Artikel-Editor mit echtem Tiptap-Editor und Anhang-Upload. Die Upload- und
// Abrufrouten prüfen api/staff/knowledge/attachments/__tests__/upload-route.test.ts
// und [id]/__tests__/route.test.ts, die Volltextsuche search-articles.test.ts.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import { fmtDateShort } from '@/lib/fmt';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  createCategory: vi.fn(),
  searchArticles: vi.fn(),
  tx: {
    kbCategory: { findMany: vi.fn() },
    kbArticle: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    staffUser: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

const router = { refresh: h.refresh, push: h.push };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx)),
}));
vi.mock('../actions', () => ({
  createCategoryAction: h.createCategory,
  searchArticles: h.searchArticles,
  deleteArticleAction: vi.fn(),
  createArticleAction: vi.fn(),
  updateArticleAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/modal')>()),
  promptDialog: vi.fn(),
}));

import KnowledgePage from '../page';
import KbArticlePage from '../[id]/page';
import NewArticlePage from '../new/page';
import EditArticlePage from '../[id]/edit/page';
import { InlineCategoryForm } from '../inline-category-form';
import { ArticleEditor } from '../article-editor';
import { knowledgeEditorExtensions } from '../knowledge-editor-extensions';

const CREATED = `Erstellt am ${fmtDateShort(new Date('2026-03-02T10:00:00.000Z'))}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const article = {
  id: 'article-1',
  title: 'Reisekosten',
  slug: 'reisekosten',
  body: '# Reisekosten\n\nPauschalen',
  published: true,
  authorId: 'staff-2',
  categoryId: 'cat-1',
  category: { name: 'Lohn' },
  createdAt: new Date('2026-03-02T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
  attachments: [],
};

function ProseMirrorEditor(): Editor {
  return (document.querySelector('.ProseMirror') as unknown as { editor: Editor }).editor;
}

function hidden(name: string): string {
  return document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)!.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.kbCategory.findMany.mockResolvedValue([
    { id: 'cat-1', name: 'Lohn', _count: { articles: 1 } },
  ]);
  h.tx.kbArticle.findMany.mockResolvedValue([
    article,
    { ...article, id: 'article-2', title: 'Altbestand', authorId: 'staff-gone' },
  ]);
  h.tx.kbArticle.findUnique.mockResolvedValue(article);
  h.tx.staffUser.findMany.mockResolvedValue([{ id: 'staff-2', fullName: 'Erika Muster' }]);
  h.tx.staffUser.findFirst.mockResolvedValue({ fullName: 'Erika Muster' });
  // ProseMirror fragt Layoutdaten ab, die jsdom nicht berechnet.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  document.elementFromPoint ??= () => null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Wissensdatenbank UI', () => {
  it('legt Kategorien ohne Seitenwechsel inline an', async () => {
    const { container } = await renderServer(KnowledgePage({ searchParams: Promise.resolve({}) }));
    expect(container.querySelector('a[href="/staff/knowledge/categories/new"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Kategorie anlegen' })).toBeTruthy();
  });

  it('speichert eine Inline-Kategorie und aktualisiert die Liste ohne Navigation', async () => {
    h.createCategory.mockResolvedValueOnce({ ok: true });
    const { container } = render(
      <InlineCategoryForm categories={[{ id: 'cat-1', name: 'Lohn' }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kategorie anlegen' }));
    const form = container.querySelector('form')!;
    expect(form.className).toBe('relative mt-3 flex items-center gap-1.5');
    expect(screen.queryByText('Neue Kategorie')).toBeNull();
    fireEvent.change(screen.getByLabelText('Kategoriename'), { target: { value: 'Umsatzsteuer' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(Object.fromEntries(h.createCategory.mock.calls[0]![1] as FormData)).toEqual({
      name: 'Umsatzsteuer',
      parentId: '',
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.push).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('form')).toBeNull());
  });

  it('zeigt Verfasser und ursprüngliches Erstellungsdatum in der Liste', async () => {
    await renderServer(KnowledgePage({ searchParams: Promise.resolve({}) }));
    const item = screen.getByText('Reisekosten').closest('li')!;
    expect(within(item).getByText('Erika Muster')).toBeTruthy();
    expect(within(item).getByText(CREATED)).toBeTruthy();
    const unknown = screen.getByText('Altbestand').closest('li')!;
    expect(within(unknown).getByText('Unbekannter Verfasser')).toBeTruthy();
  });

  it('zeigt Verfasser und Erstellungsdatum in den Suchtreffern', async () => {
    h.searchArticles.mockResolvedValueOnce([
      {
        id: 'article-1',
        title: 'Reisekosten',
        slug: 'reisekosten',
        snippet: '<mark>Pauschalen</mark>',
        rank: 1,
        categoryName: 'Lohn',
        authorName: 'Erika Muster',
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
      },
    ]);
    await renderServer(KnowledgePage({ searchParams: Promise.resolve({ q: 'Pauschale' }) }));
    expect(h.searchArticles).toHaveBeenCalledWith('Pauschale');
    const hit = screen.getByText('Reisekosten').closest('li')!;
    expect(within(hit).getByText('Erika Muster')).toBeTruthy();
    expect(within(hit).getByText(CREATED)).toBeTruthy();
  });

  it('zeigt Verfasser und Erstellungsdatum in der Artikelansicht', async () => {
    await renderServer(KbArticlePage({ params: Promise.resolve({ id: 'article-1' }) }));
    expect(screen.getByText('Verfasst von Erika Muster')).toBeTruthy();
    expect(screen.getByText(CREATED)).toBeTruthy();
  });

  it('nutzt für Anlage und Bearbeitung die breite Arbeitsfläche mit frischem Entwurfstoken', async () => {
    const first = await renderServer(NewArticlePage());
    expect([...(first.container.firstElementChild as HTMLElement).classList]).toContain(
      'max-w-[1600px]',
    );
    const token = hidden('attachmentDraftToken');
    expect(token).toMatch(UUID);
    first.unmount();

    // Jeder Aufruf erhält ein eigenes Entwurfstoken für Anhänge.
    const tokens: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const edit = await renderServer(
        EditArticlePage({ params: Promise.resolve({ id: 'article-1' }) }),
      );
      expect([...(edit.container.firstElementChild as HTMLElement).classList]).toContain(
        'max-w-[1600px]',
      );
      tokens.push(hidden('attachmentDraftToken'));
      edit.unmount();
    }
    expect(tokens.every((entry) => UUID.test(entry))).toBe(true);
    expect(new Set([token, ...tokens]).size).toBe(3);
  });
});

describe('Artikel-Editor', () => {
  function renderEditor(body = '# Titel\n\nText') {
    return render(
      <ArticleEditor
        action={vi.fn()}
        categories={[]}
        draftToken="11111111-1111-4111-8111-111111111111"
        initial={{
          id: 'article-1',
          title: 'Titel',
          body,
          categoryId: '',
          published: true,
          attachments: [],
        }}
      />,
    );
  }

  it('stellt eine große Inline-Arbeitsfläche mit Markdown-Quellansicht bereit', async () => {
    renderEditor();
    const toolbar = await screen.findByRole('toolbar', { name: 'Artikeltext formatieren' });
    const surface = screen.getByRole('textbox', {
      name: 'Artikelinhalt direkt formatiert bearbeiten',
    });
    expect(surface.className).toContain('min-h-[64vh]');
    expect(surface.querySelector('h1')!.textContent).toBe('Titel');
    const headings = [
      ...within(toolbar).getByLabelText('Absatzformat').querySelectorAll('option'),
    ].map((option) => option.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Überschrift 1', 'Überschrift 2']));

    const inline = screen.getByRole('button', { name: 'Inline' });
    const source = screen.getByRole('button', { name: 'Markdown' });
    expect([inline.getAttribute('aria-pressed'), source.getAttribute('aria-pressed')]).toEqual([
      'true',
      'false',
    ]);
    fireEvent.click(source);
    expect([inline.getAttribute('aria-pressed'), source.getAttribute('aria-pressed')]).toEqual([
      'false',
      'true',
    ]);
    expect(screen.getByText('Markdown-Quellansicht ist aktiv.').getAttribute('role')).toBe(
      'status',
    );
    const textarea = screen.getByLabelText('Markdown-Quelltext') as HTMLTextAreaElement;
    expect(textarea.value).toBe('# Titel\n\nText');
    fireEvent.change(textarea, { target: { value: '## Neu\n\nInhalt' } });
    expect(hidden('body')).toBe('## Neu\n\nInhalt');

    fireEvent.click(inline);
    await waitFor(() =>
      expect(
        screen
          .getByRole('textbox', { name: 'Artikelinhalt direkt formatiert bearbeiten' })
          .querySelector('h2')!.textContent,
      ).toBe('Neu'),
    );
  });

  it('macht Formatzustände hörbar und übernimmt Text- und Markerfarben als Markdown', async () => {
    renderEditor('Text');
    const toolbar = await screen.findByRole('toolbar', { name: 'Artikeltext formatieren' });
    const bold = within(toolbar).getByRole('button', { name: 'Fett' });
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      fireEvent.click(bold);
    });
    await waitFor(() => expect(bold.getAttribute('aria-pressed')).toBe('true'));
    await act(async () => {
      fireEvent.click(bold);
    });

    act(() => {
      ProseMirrorEditor().commands.selectAll();
    });
    fireEvent.change(within(toolbar).getByLabelText('Textfarbe'), {
      target: { value: '#ff0000' },
    });
    fireEvent.change(within(toolbar).getByLabelText('Markerfarbe'), {
      target: { value: '#ffff00' },
    });
    await waitFor(() =>
      expect(hidden('body')).toBe(
        '<span style="color: #ff0000; background-color: #ffff00">Text</span>',
      ),
    );
  });

  it('bewegt den Fokus in der Leiste mit Pfeiltasten, Pos1 und Ende', async () => {
    renderEditor();
    const toolbar = await screen.findByRole('toolbar', { name: 'Artikeltext formatieren' });
    const controls = [...toolbar.querySelectorAll<HTMLElement>('button, select, input')].filter(
      (control) => !(control as HTMLButtonElement).disabled,
    );
    const bold = within(toolbar).getByRole('button', { name: 'Fett' });
    const index = controls.indexOf(bold);
    bold.focus();
    fireEvent.keyDown(bold, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(controls[index + 1]);
    bold.focus();
    fireEvent.keyDown(bold, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(controls[index - 1]);
    bold.focus();
    fireEvent.keyDown(bold, { key: 'End' });
    expect(document.activeElement).toBe(controls.at(-1));
    bold.focus();
    fireEvent.keyDown(bold, { key: 'Home' });
    expect(document.activeElement).toBe(controls[0]);
  });

  it('lädt Anhänge über die Anhang-Route hoch, fügt sie ein und meldet Fehler', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attachment: { id: 'att-1', displayName: 'hilfe.pdf', mimeType: 'application/pdf' },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'forbidden' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    renderEditor('Text');
    await screen.findByRole('toolbar', { name: 'Artikeltext formatieren' });
    const input = screen.getByLabelText('Artikelanhang auswählen');

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['%PDF'], 'hilfe.pdf', { type: 'application/pdf' })] },
      });
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/staff/knowledge/attachments');
    expect(Object.fromEntries(init.body as FormData)).toMatchObject({
      draftToken: '11111111-1111-4111-8111-111111111111',
      displayName: 'hilfe.pdf',
      articleId: 'article-1',
    });
    const announced = await screen.findByText('hilfe.pdf wurde hochgeladen und eingefügt.');
    expect(announced.getAttribute('role')).toBe('status');
    expect(hidden('body')).toContain(
      '[hilfe.pdf](/api/staff/knowledge/attachments/att-1?download=1)',
    );
    expect(JSON.parse(hidden('attachmentIds'))).toEqual(['att-1']);

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'zweite.pdf', { type: 'application/pdf' })] },
      });
    });
    expect(screen.getByRole('alert').textContent).toBe('Für diesen Upload fehlt die Berechtigung.');
  });
});

describe('Wissens-Editor-Erweiterungen', () => {
  function markdown(html: string): { markdown: string; editor: Editor } {
    const editor = new Editor({ extensions: knowledgeEditorExtensions, content: html });
    return { markdown: editor.getMarkdown(), editor };
  }

  it('bewahrt nur geprüfte Farbstile als Inline-HTML im Markdown', () => {
    const { markdown: safe, editor } = markdown(
      '<p><span style="color: #FF0000; background-color: #00FF00">rot</span></p>',
    );
    expect(safe).toBe('<span style="color: #ff0000; background-color: #00ff00">rot</span>');
    editor.destroy();
    const { markdown: unsafe, editor: second } = markdown(
      '<p><span style="color: red; background-color: url(x)">frei</span></p>',
    );
    expect(unsafe).toBe('frei');
    second.destroy();
  });

  it('übernimmt keine Base64-Bilder', () => {
    const { editor } = markdown(
      '<p><img src="data:image/png;base64,iVBORw0KGgo="><img src="/api/staff/knowledge/attachments/att-1"></p>',
    );
    const sources: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') sources.push(node.attrs.src as string);
    });
    expect(sources).toEqual(['/api/staff/knowledge/attachments/att-1']);
    editor.destroy();
  });
});
