import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: vi.fn(async () => ({})) }));
vi.mock('../access', () => ({
  assertActivePortalInboxIdentityTx: vi.fn(async () => undefined),
  assertInboxFeatureTx: vi.fn(async () => undefined),
  assertStaffInboxClientTx: vi.fn(async () => undefined),
}));

import { listPortalInboxThreadsTx, listStaffInboxThreadsTx } from '../queries';
import { inboxMetadataSearch, STAFF_INBOX_SEARCH_CANDIDATE_LIMIT } from '../search';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001 (Entwurf).

describe('Portal-Inbox-Suchscope', () => {
  it('verwendet im Portal nur Betreff und freigegebenen Mandantennamen', () => {
    expect(inboxMetadataSearch('4711', 'portal')).toEqual([
      { subject: { contains: '4711', mode: 'insensitive' } },
      { client: { name: { contains: '4711', mode: 'insensitive' } } },
    ]);
  });

  it('erlaubt interne Kanzleikennungen ausschließlich in der Staff-Suche', () => {
    const serialized = JSON.stringify(inboxMetadataSearch('4711', 'staff'));
    expect(serialized).toContain('datevNo');
    expect(serialized).toContain('addisonNo');
  });
});

// Review-Finding P-10: Die Staff-Suche wählt Treffer über den Trigram-Index vor
// (app.portal_inbox_staff_search_candidates) und lädt wie bisher unter RLS mit
// unverändertem Filter, eingeschränkt auf die Kandidaten.
describe('Staff-Posteingangssuche mit Kandidaten', () => {
  const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } } as never;

  function makeTx(kandidaten: Array<{ id: string | null; ueberlauf: boolean }>) {
    return {
      $queryRaw: vi.fn(async () => kandidaten),
      portalInboxThread: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => []),
      },
      portalInboxAttachment: { findMany: vi.fn(async () => []) },
    };
  }
  const whereOf = (tx: ReturnType<typeof makeTx>) =>
    (tx.portalInboxThread.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
      .where;

  beforeEach(() => vi.clearAllMocks());

  it('schränkt Zählung und Seite auf die Kandidaten ein und behält den Suchfilter', async () => {
    const tx = makeTx([
      { id: 'thread-1', ueberlauf: false },
      { id: 'thread-2', ueberlauf: false },
    ]);

    await listStaffInboxThreadsTx(tx as never, session, { query: '  Belege 2025 ', scope: 'all' });

    const [sql, ...werte] = tx.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(sql.join('?')).toContain('app.portal_inbox_staff_search_candidates(');
    // Derselbe normalisierte Begriff wie im Prisma-Filter, dazu die Obergrenze.
    expect(werte).toEqual(['Belege 2025', STAFF_INBOX_SEARCH_CANDIDATE_LIMIT]);
    const where = whereOf(tx);
    expect(where).toMatchObject({
      tenantId: 'tenant-1',
      id: { in: ['thread-1', 'thread-2'] },
      OR: inboxMetadataSearch('Belege 2025', 'staff'),
    });
    expect(tx.portalInboxThread.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
  });

  it('sucht bei Überlauf wie bisher ohne Vorauswahl', async () => {
    const tx = makeTx([{ id: null, ueberlauf: true }]);

    await listStaffInboxThreadsTx(tx as never, session, { query: 'e', scope: 'all' });

    const where = whereOf(tx);
    expect(where).not.toHaveProperty('id');
    expect(where).toMatchObject({ OR: inboxMetadataSearch('e', 'staff') });
  });

  it('liefert ohne Kandidaten keine Treffer', async () => {
    const tx = makeTx([]);

    await listStaffInboxThreadsTx(tx as never, session, { query: 'Zylinderkopf', scope: 'all' });

    expect(whereOf(tx)).toMatchObject({ id: { in: [] } });
  });

  it('fragt ohne Suchbegriff und in der Portalliste keine Kandidaten ab', async () => {
    const ohneBegriff = makeTx([]);
    await listStaffInboxThreadsTx(ohneBegriff as never, session, { query: '   ', scope: 'all' });
    expect(ohneBegriff.$queryRaw).not.toHaveBeenCalled();
    expect(whereOf(ohneBegriff)).not.toHaveProperty('id');

    // Die Portalsuche bleibt auf einen Mandanten begrenzt (Scope-Index).
    const portal = makeTx([]);
    await listPortalInboxThreadsTx(
      portal as never,
      { tenantId: 'tenant-1', clientId: 'client-1', contactId: 'contact-1' },
      { query: 'Belege' },
    );
    expect(portal.$queryRaw).not.toHaveBeenCalled();
    expect(whereOf(portal)).toEqual({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      OR: inboxMetadataSearch('Belege', 'portal'),
    });
  });
});
