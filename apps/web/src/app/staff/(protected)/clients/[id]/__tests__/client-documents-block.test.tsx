// Dokumentblock des Mandanten-Cockpits: Gesamtzahl, Vor-/Weiter-Navigation und
// serverseitige Ordner-/Such-/Gelöscht-Links werden gerendert geprüft.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadPage: vi.fn(),
  explorerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('../_data', () => ({ loadClientDocumentsPage: h.loadPage }));
vi.mock('@/components/document-explorer', () => ({
  DocumentExplorer: (props: Record<string, unknown>) => {
    h.explorerProps.push(props);
    return <div data-explorer="" />;
  },
}));

import type { ClientDocumentsPageData, ClientDocumentsQuery } from '../_data';
import { ClientDocumentsBlock, ClientDocumentsSkeleton } from '../client-documents-block';

const ctx = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };
const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } } as never;
const client = { id: 'client-1', name: 'Muster GmbH', allowActive: true };
const FOLDER = '11111111-1111-4111-8111-111111111111';

function pageData(overrides: Partial<ClientDocumentsPageData> = {}): ClientDocumentsPageData {
  return {
    folders: [{ id: FOLDER, name: 'Belege', parentId: null }],
    documents: [],
    totalCount: 120,
    totalPages: 3,
    page: 2,
    from: 51,
    to: 100,
    hasDatevDocuments: false,
    deleted: false,
    folder: 'all',
    q: '',
    folderCounts: { all: 120, none: 20, byId: { [FOLDER]: 100 } },
    ...overrides,
  };
}

async function render(query: Partial<ClientDocumentsQuery> = {}) {
  const element = await ClientDocumentsBlock({
    ctx,
    session,
    client,
    query: { page: 2, deleted: false, folder: 'all', q: '', ...query },
  });
  return renderToStaticMarkup(<>{element}</>);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.explorerProps = [];
  h.loadPage.mockResolvedValue(pageData());
});

describe('Mandanten-Dokumentblock — Seitennavigation', () => {
  it('lädt die Seite serverseitig mit der Anfrage aus der URL', async () => {
    await render({ folder: FOLDER, q: 'Rechnung' });

    expect(h.loadPage).toHaveBeenCalledWith(ctx, session, 'client-1', {
      page: 2,
      deleted: false,
      folder: FOLDER,
      q: 'Rechnung',
    });
  });

  it('zeigt Gesamtzahl sowie Zurück- und Weiter-Links einer mittleren Seite', async () => {
    const html = await render();

    expect(html).toContain('51–100 von 120 aktiven Dokumenten');
    expect(html).toContain('Seite 2 von 3');
    expect(html).toContain('href="/staff/clients/client-1#documents"');
    expect(html).toContain('← Zurück');
    expect(html).toContain('href="/staff/clients/client-1?docsPage=3#documents"');
    expect(html).toContain('Weiter →');
  });

  it('deaktiviert die Navigation an den Rändern und blendet sie bei einer Seite aus', async () => {
    h.loadPage.mockResolvedValue(pageData({ page: 1, from: 1, to: 50 }));
    const first = await render({ page: 1 });
    expect(first).toMatch(/<span[^>]*aria-disabled="true"[^>]*>← Zurück<\/span>/);
    expect(first).toContain('href="/staff/clients/client-1?docsPage=2#documents"');

    h.loadPage.mockResolvedValue(pageData({ page: 3, from: 101, to: 120 }));
    const last = await render({ page: 3 });
    expect(last).toMatch(/<span[^>]*aria-disabled="true"[^>]*>Weiter →<\/span>/);

    h.loadPage.mockResolvedValue(pageData({ totalCount: 7, totalPages: 1, page: 1, to: 7 }));
    const single = await render({ page: 1 });
    expect(single).not.toContain('aria-label="Dokumentseiten"');
    expect(single).toContain('1–7 von 7 aktiven Dokumenten');
  });

  it('behält Gelöscht-Ansicht, Ordner und Suche in den Seitenlinks', async () => {
    h.loadPage.mockResolvedValue(pageData({ deleted: true, folder: FOLDER, q: 'Rechnung' }));
    const html = await render({ deleted: true, folder: FOLDER, q: 'Rechnung' });

    expect(html).toContain('von 120 gelöschten Dokumenten in der aktuellen Auswahl');
    expect(html).toContain(
      `href="/staff/clients/client-1?docsDeleted=1&amp;docsFolder=${FOLDER}&amp;docsQ=Rechnung&amp;docsPage=3#documents"`,
    );
  });

  it('übergibt dem Explorer serverseitige Gelöscht-, Ordner- und Suchlinks', async () => {
    h.loadPage.mockResolvedValue(pageData({ folder: FOLDER, q: 'Rechnung' }));
    await render({ folder: FOLDER, q: 'Rechnung' });

    const props = h.explorerProps[0]!;
    expect(props['documents']).toEqual([]);
    expect(props['serverDeleted']).toEqual({
      showDeleted: false,
      activeHref: `/staff/clients/client-1?docsFolder=${FOLDER}&docsQ=Rechnung#documents`,
      deletedHref: `/staff/clients/client-1?docsDeleted=1&docsFolder=${FOLDER}&docsQ=Rechnung#documents`,
    });
    expect(props['serverFilter']).toMatchObject({
      folder: FOLDER,
      q: 'Rechnung',
      searchParam: 'docsQ',
      searchHref: `/staff/clients/client-1?docsFolder=${FOLDER}#documents`,
      folderHrefs: {
        all: '/staff/clients/client-1?docsQ=Rechnung#documents',
        none: '/staff/clients/client-1?docsFolder=none&docsQ=Rechnung#documents',
        [FOLDER]: `/staff/clients/client-1?docsFolder=${FOLDER}&docsQ=Rechnung#documents`,
      },
    });
  });

  it('rendert nichts ohne Zugriff und einen zugänglichen Platzhalter beim Laden', async () => {
    h.loadPage.mockResolvedValue(null);
    expect(await render()).toBe('');

    expect(renderToStaticMarkup(<ClientDocumentsSkeleton />)).toContain(
      'aria-label="Dokumente werden geladen"',
    );
  });
});
