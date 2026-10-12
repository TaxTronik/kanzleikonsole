// Review-Finding P-10, Welle 15: Titelsuche der Dokumentenseite zweistufig.
// Stufe 1 (app.document_title_search_candidates) erhält genau die Ebene und
// den Begriff der Seite; Stufe 2 lädt nur die Kandidaten mit dem unveränderten
// Filter unter RLS und zählt wie bisher nur bei Kürzung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));

import { MANAGED_DOC_SELECT } from '../managed-docs';
import { loadScopeDocumentsTx } from '../title-search';

function makeTx(kandidaten: Array<{ id: string | null; ueberlauf: boolean }>, rows: unknown[]) {
  return {
    $queryRaw: vi.fn(async () => kandidaten),
    document: {
      findMany: vi.fn(async () => rows),
      count: vi.fn(async () => 4321),
    },
  };
}

const scope = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  folderId: 'folder-1',
  deleted: false,
  q: 'Rechnung 50%',
  cap: 3,
};
const docWhere = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  folderId: 'folder-1',
  deletedAt: null,
  title: { contains: 'Rechnung 50%', mode: 'insensitive' },
};

describe('loadScopeDocumentsTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('übergibt Ebene, Begriff und Grenze und lädt nur die Kandidaten mit unverändertem Filter', async () => {
    const tx = makeTx(
      [
        { id: 'doc-2', ueberlauf: false },
        { id: 'doc-1', ueberlauf: false },
      ],
      [{ id: 'doc-2' }, { id: 'doc-1' }],
    );

    const result = await loadScopeDocumentsTx(tx as never, scope);

    const [sql, ...werte] = tx.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(sql.join('?')).toContain('app.document_title_search_candidates(');
    expect(werte).toEqual(['client-1', 'folder-1', false, 'Rechnung 50%', 3]);
    expect(tx.document.findMany).toHaveBeenCalledWith({
      where: { ...docWhere, id: { in: ['doc-2', 'doc-1'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: MANAGED_DOC_SELECT,
    });
    // Ohne Kürzung keine Zählung über die Ebene.
    expect(tx.document.count).not.toHaveBeenCalled();
    expect(result).toEqual({ docs: [{ id: 'doc-2' }, { id: 'doc-1' }], docsTotal: 2 });
  });

  it('zählt bei Kürzung wie bisher über die ganze Ebene unter RLS', async () => {
    const tx = makeTx(
      [
        { id: 'doc-3', ueberlauf: false },
        { id: 'doc-2', ueberlauf: false },
        { id: 'doc-1', ueberlauf: false },
        { id: null, ueberlauf: true },
      ],
      [{ id: 'doc-3' }, { id: 'doc-2' }, { id: 'doc-1' }],
    );

    const result = await loadScopeDocumentsTx(tx as never, {
      ...scope,
      clientId: null,
      folderId: null,
      deleted: true,
    });

    const [, ...werte] = tx.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(werte).toEqual([null, null, true, 'Rechnung 50%', 3]);
    expect(tx.document.count).toHaveBeenCalledWith({
      where: {
        ...docWhere,
        clientId: null,
        folderId: null,
        deletedAt: { not: null },
      },
    });
    expect(result.docsTotal).toBe(4321);
  });

  it('lädt ohne Kandidaten nichts', async () => {
    const tx = makeTx([], []);

    expect(await loadScopeDocumentsTx(tx as never, scope)).toEqual({ docs: [], docsTotal: 0 });
    expect(tx.document.findMany).not.toHaveBeenCalled();
    expect(tx.document.count).not.toHaveBeenCalled();
  });

  it('fragt ohne Suchbegriff keine Kandidaten ab (unveränderte Ordneransicht)', async () => {
    const tx = makeTx([], [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    const result = await loadScopeDocumentsTx(tx as never, { ...scope, q: '' });

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    const { title: _title, ...ohneSuche } = docWhere;
    expect(tx.document.findMany).toHaveBeenCalledWith({
      where: ohneSuche,
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: MANAGED_DOC_SELECT,
    });
    // Cap erreicht: Gesamtzahl für den Hinweis.
    expect(tx.document.count).toHaveBeenCalledWith({ where: ohneSuche });
    expect(result.docsTotal).toBe(4321);
  });
});
