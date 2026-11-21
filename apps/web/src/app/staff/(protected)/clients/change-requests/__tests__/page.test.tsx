// Fachkatalog: ACCESS-CLIENT-MODE-001
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => ({ count: vi.fn(), findMany: vi.fn() }));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 'tenant', staffId: 'staff' } }),
}));
vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: async () => ({ vertraulich: false }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ clientMasterChangeRequest: requests }),
}));

import PendingChangeRequestsPage from '../page';

it('zeigt den letzten sichtbaren offenen Einzelantrag mit Direktlink', async () => {
  requests.count.mockResolvedValue(51);
  requests.findMany.mockResolvedValue([
    {
      id: 'antrag',
      client: { id: 'mandat', name: 'Beispiel GmbH' },
      contact: { fullName: 'Erika Muster' },
      createdAt: new Date('2026-10-19T12:00:00Z'),
    },
  ]);
  const html = renderToStaticMarkup(
    await PendingChangeRequestsPage({ searchParams: Promise.resolve({ page: '99' }) }),
  );
  const where = { status: 'PENDING', client: { vertraulich: false } };
  expect(requests.count).toHaveBeenCalledWith({ where });
  expect(requests.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where, skip: 50, take: 50 }),
  );
  expect(html).toContain('51–51 von 51');
  expect(html).toContain('href="/staff/clients/mandat/change-requests?request=antrag"');
});
