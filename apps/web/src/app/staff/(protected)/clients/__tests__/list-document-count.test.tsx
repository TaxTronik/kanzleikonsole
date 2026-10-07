// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Review-Befund F-14: Die Spalte „Dokumente“ der Mandantenliste zählt wie das
// Cockpit (aktive Dokumente) und der CSV-Export keine Papierkorb-Dokumente mit.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tx: { client: { findMany: vi.fn(), count: vi.fn() } },
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/auth/rbac', () => ({
  hasStaffPermission: vi.fn(() => false),
  accessibleClientsWhereFor: vi.fn(async () => ({ OR: [{ vertraulich: false }] })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx)),
}));
vi.mock('@/server/request-creation-options', () => ({
  readRequestCreationOptionsTx: vi.fn(async () => ({
    requestTemplates: [],
    requestFormTemplates: [],
    templatesLimited: false,
    formTemplatesLimited: false,
  })),
}));
vi.mock('@/components/recent-clients', () => ({ RecentClients: () => null }));
vi.mock('@/components/saved-views', () => ({ SavedViews: () => null }));
vi.mock('@/components/quick-request-dialog', () => ({ QuickRequestDialog: () => null }));
vi.mock('@/app/staff/(protected)/clients/[id]/requests/actions', () => ({
  createQuickRequestAction: vi.fn(),
}));

import ClientsPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.client.count.mockResolvedValue(1);
  h.tx.client.findMany.mockResolvedValue([
    {
      id: '01234567-89ab-4def-8abc-0123456789ab',
      name: 'Muster GmbH',
      kind: 'JURPERS',
      datevNo: '10001',
      addisonNo: null,
      allowActive: true,
      onboardingCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
      priority: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      _count: { documents: 4, contacts: 1, gwgChecks: 1, gwgInvites: 0, poas: 0, requests: 2 },
    },
  ]);
});

describe('Mandantenliste — Dokumentzähler', () => {
  it('zählt nur nicht gelöschte Dokumente und zeigt den Zähler unverändert an', async () => {
    const html = renderToStaticMarkup(await ClientsPage({ searchParams: Promise.resolve({}) }));

    const args = h.tx.client.findMany.mock.calls[0]![0];
    expect(args.select._count.select.documents).toEqual({ where: { deletedAt: null } });
    // Die übrigen Onboarding-Zähler bleiben unverändert.
    expect(args.select._count.select).toMatchObject({
      contacts: { where: { active: true } },
      gwgChecks: true,
      gwgInvites: true,
      poas: true,
      requests: true,
    });
    expect(html).toContain('<td class="px-6 py-3 text-secondary">4</td>');
  });
});
