import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: vi.fn(async () => ({})) }));
vi.mock('../access', () => ({
  assertActivePortalInboxIdentityTx: vi.fn(async () => undefined),
  assertInboxFeatureTx: vi.fn(async () => undefined),
  assertStaffInboxClientTx: vi.fn(async () => undefined),
}));

import { listPortalInboxThreadsTx, listStaffInboxThreadsTx } from '../queries';
import {
  encodeInboxCursor,
  inboxMetadataSearch,
  parseInboxCursor,
  STAFF_INBOX_SEARCH_CANDIDATE_LIMIT,
} from '../search';

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
// (app.portal_inbox_staff_search_candidates_v2: die jüngsten sichtbaren Treffer
// mit allen Listenfiltern bis zur Grenze) und lädt genau diese IDs unter RLS mit
// unverändertem Filter. Welle 15: kein Rückfall auf die ungefilterte Suche mehr
// bei vielen Treffern, Zählung begrenzt, Keyset-Blättern, Hinweis bei Überlauf.
describe('Staff-Posteingangssuche mit Kandidaten', () => {
  const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } } as never;

  function thread(index: number) {
    return {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      clientId: 'client-1',
      subject: `Belege ${index}`,
      topic: 'GENERAL' as const,
      status: 'OPEN' as const,
      attention: 'STAFF' as const,
      assignedStaffId: null,
      // Zwei Threads je Minute: Gleichstand entscheidet die ID.
      lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 2))),
      client: { name: 'Mandant' },
      assignedStaff: null,
    };
  }

  function makeTx(
    kandidaten: Array<{ id: string | null; ueberlauf: boolean }>,
    sichtbar: Array<ReturnType<typeof thread>> = [],
  ) {
    return {
      $queryRaw: vi.fn(async () => kandidaten),
      portalInboxThread: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => sichtbar),
      },
      portalInboxAttachment: { findMany: vi.fn(async () => []) },
    };
  }
  const whereOf = (mock: ReturnType<typeof makeTx>['portalInboxThread']['count' | 'findMany']) =>
    (mock.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;

  beforeEach(() => vi.clearAllMocks());

  it('übergibt Begriff, Listenfilter und Grenze und lädt nur die Kandidaten unter RLS', async () => {
    const tx = makeTx(
      [
        { id: thread(1).id, ueberlauf: false },
        { id: thread(2).id, ueberlauf: false },
      ],
      [thread(1), thread(2)],
    );

    const result = await listStaffInboxThreadsTx(tx as never, session, {
      query: '  Belege 2025 ',
      scope: 'team',
      topic: 'DOCUMENTS',
      status: 'OPEN',
      attention: 'STAFF',
    });

    const [sql, ...werte] = tx.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(sql.join('?')).toContain('app.portal_inbox_staff_search_candidates_v2(');
    // Derselbe normalisierte Begriff wie im Prisma-Filter, dieselben Filter, die Grenze.
    expect(werte).toEqual([
      'Belege 2025',
      'DOCUMENTS',
      'OPEN',
      'STAFF',
      'team',
      STAFF_INBOX_SEARCH_CANDIDATE_LIMIT,
    ]);
    // Genau eine Abfrage unter RLS: keine Zählung über den ganzen Tenant.
    expect(tx.portalInboxThread.count).not.toHaveBeenCalled();
    expect(tx.portalInboxThread.findMany).toHaveBeenCalledTimes(1);
    expect(whereOf(tx.portalInboxThread.findMany)).toMatchObject({
      tenantId: 'tenant-1',
      id: { in: [thread(1).id, thread(2).id] },
      topic: 'DOCUMENTS',
      status: 'OPEN',
      attention: 'STAFF',
      assignedStaffId: null,
      OR: inboxMetadataSearch('Belege 2025', 'staff'),
    });
    expect(result).toMatchObject({
      total: 2,
      search: { truncated: false, cursor: null, nextCursor: null },
    });
    expect(result.items.map((item) => item.id)).toEqual([thread(2).id, thread(1).id]);
  });

  it('übergibt ohne Filter NULL und „Meine Arbeit“ als Standardbereich', async () => {
    const tx = makeTx([]);
    await listStaffInboxThreadsTx(tx as never, session, { query: 'Belege' });
    const [, ...werte] = tx.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(werte).toEqual(['Belege', null, null, null, 'mine', STAFF_INBOX_SEARCH_CANDIDATE_LIMIT]);
  });

  it('meldet einen Überlauf, statt ohne Vorauswahl zu suchen', async () => {
    const tx = makeTx(
      [
        { id: thread(1).id, ueberlauf: false },
        { id: null, ueberlauf: true },
      ],
      [thread(1)],
    );

    const result = await listStaffInboxThreadsTx(tx as never, session, {
      query: 'e',
      scope: 'all',
    });

    expect(whereOf(tx.portalInboxThread.findMany)).toMatchObject({
      id: { in: [thread(1).id] },
      OR: inboxMetadataSearch('e', 'staff'),
    });
    expect(result.search).toMatchObject({
      truncated: true,
      limit: STAFF_INBOX_SEARCH_CANDIDATE_LIMIT,
    });
  });

  it('liefert ohne Kandidaten keine Treffer und fragt die Liste nicht ab', async () => {
    const tx = makeTx([]);

    const result = await listStaffInboxThreadsTx(tx as never, session, {
      query: 'Zylinderkopf',
      scope: 'all',
    });

    expect(tx.portalInboxThread.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ items: [], total: 0, search: { truncated: false } });
  });

  it('blättert per Keyset (letzte Aktivität, ID) ohne Lücken und Doppelte', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => thread(index));
    // Stufe 2 liefert in beliebiger Reihenfolge; die Liste sortiert selbst.
    const shuffled = [...rows].sort((a, b) => (a.subject < b.subject ? -1 : 1));
    const erwartet = [...rows].reverse().map((row) => row.id);
    const kandidaten = rows.map((row) => ({ id: row.id, ueberlauf: false }));

    const seen: string[] = [];
    let cursor: string | undefined;
    const cursors: Array<string | null> = [];
    for (let page = 0; page < 5; page++) {
      const tx = makeTx(kandidaten, shuffled);
      const result = await listStaffInboxThreadsTx(tx as never, session, {
        query: 'Belege',
        scope: 'all',
        ...(cursor ? { cursor } : {}),
      });
      expect(result.total).toBe(120);
      seen.push(...result.items.map((item) => item.id));
      cursors.push(result.search!.cursor);
      cursor = result.search!.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(erwartet);
    expect(cursors).toHaveLength(3);
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe(encodeInboxCursor(thread(70)));
  });

  it('beginnt bei ungültigem Cursor auf der ersten Seite', async () => {
    for (const cursor of [
      '',
      'abc',
      '123_nicht-uuid',
      `-1_${thread(1).id}`,
      `1_${thread(1).id}x`,
    ]) {
      const tx = makeTx([{ id: thread(1).id, ueberlauf: false }], [thread(1)]);
      const result = await listStaffInboxThreadsTx(tx as never, session, {
        query: 'Belege',
        scope: 'all',
        cursor,
      });
      expect(result.search?.cursor, cursor).toBeNull();
      expect(result.items.map((item) => item.id)).toEqual([thread(1).id]);
    }
    expect(parseInboxCursor(encodeInboxCursor(thread(3)))).toEqual({
      lastMessageAt: thread(3).lastMessageAt,
      id: thread(3).id,
    });
  });

  it('fragt ohne Suchbegriff und in der Portalliste keine Kandidaten ab', async () => {
    const ohneBegriff = makeTx([]);
    await listStaffInboxThreadsTx(ohneBegriff as never, session, { query: '   ', scope: 'all' });
    expect(ohneBegriff.$queryRaw).not.toHaveBeenCalled();
    expect(whereOf(ohneBegriff.portalInboxThread.count)).not.toHaveProperty('id');

    // Die Portalsuche bleibt auf einen Mandanten begrenzt (Scope-Index).
    const portal = makeTx([]);
    await listPortalInboxThreadsTx(
      portal as never,
      { tenantId: 'tenant-1', clientId: 'client-1', contactId: 'contact-1' },
      { query: 'Belege' },
    );
    expect(portal.$queryRaw).not.toHaveBeenCalled();
    expect(whereOf(portal.portalInboxThread.count)).toEqual({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      OR: inboxMetadataSearch('Belege', 'portal'),
    });
  });
});
