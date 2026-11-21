// Fachkatalog: ACCESS-CLIENT-MODE-001
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const clientId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const { findMany, assertAccess } = vi.hoisted(() => ({ findMany: vi.fn(), assertAccess: vi.fn() }));
vi.mock('@/server/auth/client-page-access', () => ({
  requireClientPageAccess: async () => ({ user: { tenantId: 'tenant', staffId: 'staff' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: assertAccess }));
vi.mock('@/server/tax-master-data/service', () => ({ loadTaxMasterDataTx: async () => ({}) }));
vi.mock('../row', () => ({ ChangeRequestRow: () => null }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      client: { findUnique: async () => ({ id: clientId, name: 'Beispiel GmbH' }) },
      clientMasterChangeRequest: { findMany },
    }),
}));
import ClientChangeRequestsPage from '../page';

function detail() {
  return ClientChangeRequestsPage({
    params: Promise.resolve({ id: clientId }),
    searchParams: Promise.resolve({ request: requestId }),
  });
}
beforeEach(() => vi.clearAllMocks());

it('bindet den Direktlink an den aktuellen Mandantenzugriff und beide Objektkennungen', async () => {
  findMany.mockResolvedValue([
    {
      id: requestId,
      status: 'PENDING',
      createdAt: new Date('2026-01-05T12:00:00Z'),
      fields: { street: 'Prüfstraße 32' },
      contact: { fullName: 'Erika Muster', email: 'erika@example.test' },
    },
  ]);
  const html = renderToStaticMarkup(await detail());
  expect(assertAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), clientId);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { clientId, id: requestId } }),
  );
  expect(html).toContain('Prüfstraße 32');
});

it('liefert für einen hier fehlenden Einzelantrag eine 404-Antwort', async () => {
  findMany.mockResolvedValue([]);
  await expect(detail()).rejects.toThrow('404');
});
