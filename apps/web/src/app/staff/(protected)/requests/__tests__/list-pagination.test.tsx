// Fachkatalog: ACCESS-CLIENT-MODE-001
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn() }));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 'tenant', staffId: 'staff' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: async () => ({}) }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, run: (tx: unknown) => unknown) => run({ request }),
}));
vi.mock('@/server/request-creation-options', () => ({
  readRequestCreationOptionsTx: async () => ({ requestTemplates: [], requestFormTemplates: [] }),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/requests/actions', () => ({
  createQuickRequestAction: vi.fn(),
}));
vi.mock('@/components/quick-request-dialog', () => ({ QuickRequestDialog: () => null }));
vi.mock('../bulk-toolbar', () => ({ BulkToolbar: () => null }));

import RequestsOverviewPage from '../page';

describe('Anforderungsliste', () => {
  it('fragt die letzte vorhandene Seite ab und zeigt die tatsächlich geladene Zeile', async () => {
    request.count.mockResolvedValue(51);
    request.findMany.mockResolvedValue([
      {
        id: 'request',
        status: 'OPEN',
        title: 'Letzter Treffer',
        priority: 'NORMAL',
        dueAt: null,
        client: { id: 'client', name: 'Beispiel' },
        _count: { responses: 0 },
      },
    ]);
    const html = renderToStaticMarkup(
      await RequestsOverviewPage({ searchParams: Promise.resolve({ page: '10000000' }) }),
    );
    expect(request.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 50, take: 50 }),
    );
    expect(html).toContain('Letzter Treffer');
    expect(html).toContain('51–51 von 51');
  });

  it('liefert für einen leeren gefilterten Bestand Offset null', async () => {
    request.count.mockResolvedValue(0);
    request.findMany.mockResolvedValue([]);
    const html = renderToStaticMarkup(
      await RequestsOverviewPage({ searchParams: Promise.resolve({ mine: '1', page: '2' }) }),
    );
    expect(request.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skip: 0,
        where: { client: { responsibilities: { some: { staffId: 'staff' } } } },
      }),
    );
    expect(html).toContain('Keine Anforderungen gefunden.');
  });
});
