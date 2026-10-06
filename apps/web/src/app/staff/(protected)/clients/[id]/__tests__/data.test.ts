import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_DOC_SELECT } from '@/server/documents/managed-docs';

const h = vi.hoisted(() => {
  const tx = {
    client: { findFirst: vi.fn(), findUnique: vi.fn() },
    phoneNote: { findMany: vi.fn() },
    taxDeadline: { findMany: vi.fn() },
    clientMasterChangeRequest: { count: vi.fn() },
    clientCustomFieldDef: { findMany: vi.fn() },
    clientCustomFieldValue: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
    workflowInstance: { findMany: vi.fn() },
    clientReminder: { findMany: vi.fn() },
    pendingBinder: { findMany: vi.fn() },
    appointment: { findMany: vi.fn() },
    appointmentRequest: { findMany: vi.fn() },
    clientHandover: { findMany: vi.fn() },
    request: { findMany: vi.fn() },
    documentFolder: { findMany: vi.fn() },
    document: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  };
  const readRequestCreationOptionsTx = vi.fn();
  const accessibleClientsWhereFor = vi.fn();
  return { tx, readRequestCreationOptionsTx, accessibleClientsWhereFor };
});

vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, callback: (tx: typeof h.tx) => unknown) =>
    callback(h.tx),
  ),
}));

vi.mock('@/server/request-creation-options', () => ({
  readRequestCreationOptionsTx: h.readRequestCreationOptionsTx,
}));

vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: h.accessibleClientsWhereFor,
}));

import {
  CLIENT_DOCUMENTS_PAGE_SIZE,
  CLIENT_REQUESTS_CAP,
  loadClientCockpitBlocks,
  loadClientCockpitHeader,
  loadClientDocumentsPage,
  parseClientDocumentsDeleted,
  parseClientDocumentsFolder,
  parseClientDocumentsPage,
  parseClientDocumentsSearch,
  type ClientDocumentsQuery,
  type CockpitModules,
} from '../_data';

const ctx = {
  tenantId: 'tenant-1',
  actorId: 'staff-1',
  actorType: 'STAFF' as const,
};
const session = {} as never;

function managedDocumentRow(id: string) {
  return {
    id,
    title: `Dokument ${id}`,
    mimeType: 'application/pdf',
    classification: 'GENERAL',
    documentTypeId: null,
    documentType: null,
    createdAt: new Date('2026-07-16T10:00:00.000Z'),
    folderId: null,
    deletedAt: null,
    sharedWithClientAt: null,
    versions: [{ sizeBytes: 123n }],
  };
}

const ALL_MODULES: CockpitModules = {
  taxNotices: true,
  appointments: true,
  workflows: true,
  reminders: true,
  binders: true,
  handovers: true,
  phoneNotes: true,
};
const NO_MODULES: CockpitModules = {
  taxNotices: false,
  appointments: false,
  workflows: false,
  reminders: false,
  binders: false,
  handovers: false,
  phoneNotes: false,
};
const BLOCK_QUERIES = [
  h.tx.phoneNote.findMany,
  h.tx.taxDeadline.findMany,
  h.tx.staffUser.findMany,
  h.tx.workflowInstance.findMany,
  h.tx.clientReminder.findMany,
  h.tx.pendingBinder.findMany,
  h.tx.appointment.findMany,
  h.tx.appointmentRequest.findMany,
  h.tx.clientHandover.findMany,
  h.tx.request.findMany,
];

function prepareHeaderRows() {
  h.tx.client.findFirst.mockResolvedValue({
    id: 'client-1',
    contacts: [],
    gwgChecks: [],
    responsibilities: [],
    _count: { poas: 0, gwgInvites: 0, gwgChecks: 0, requests: 3 },
  });
  h.tx.clientMasterChangeRequest.count.mockResolvedValue(2);
  h.tx.clientCustomFieldDef.findMany.mockResolvedValue([]);
  h.tx.clientCustomFieldValue.findMany.mockResolvedValue([]);
  h.readRequestCreationOptionsTx.mockResolvedValue({
    requestTemplates: [],
    requestFormTemplates: [],
    templatesLimited: false,
    formTemplatesLimited: false,
  });
}

function prepareBlockRows() {
  h.tx.client.findFirst.mockResolvedValue({ id: 'client-1' });
  for (const query of BLOCK_QUERIES) query.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.accessibleClientsWhereFor.mockResolvedValue({ vertraulich: false });
});

describe('loadClientCockpitHeader', () => {
  it('behält den Tenant-Backstop und startet nach einem Miss keine Folgeabfragen', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);
    h.tx.client.findUnique.mockResolvedValue(null);

    const result = await loadClientCockpitHeader(ctx, session, 'client-foreign');

    expect(result).toEqual({ status: 'not_found' });
    expect(h.tx.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'client-foreign', tenantId: 'tenant-1', vertraulich: false },
      }),
    );
    expect(h.tx.clientMasterChangeRequest.count).not.toHaveBeenCalled();
    expect(h.readRequestCreationOptionsTx).not.toHaveBeenCalled();
  });

  it('liefert bei RESTRICTED-Verweigerung fail-closed keine Cockpit-Daten', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);
    h.tx.client.findUnique.mockResolvedValue({ id: 'client-restricted' });

    const result = await loadClientCockpitHeader(ctx, session, 'client-restricted');

    expect(result).toEqual({ status: 'forbidden' });
    expect(h.tx.clientMasterChangeRequest.count).not.toHaveBeenCalled();
  });

  it('lädt nur Kopfdaten: keine Blocklisten, Dokumente oder Anforderungszeilen', async () => {
    prepareHeaderRows();

    const result = await loadClientCockpitHeader(ctx, session, 'client-1');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Kopf wurde nicht geladen.');
    expect(result.data).toMatchObject({ pendingChangeRequests: 2, templatesLimited: false });
    const clientArgs = h.tx.client.findFirst.mock.calls[0]![0];
    expect(clientArgs.include).not.toHaveProperty('requests');
    expect(clientArgs.include).not.toHaveProperty('documentFolders');
    // Onboarding zählt Anforderungen statt eine gekappte Liste zu laden.
    expect(clientArgs.include._count.select).toMatchObject({ requests: true, poas: true });
    for (const query of BLOCK_QUERIES) expect(query).not.toHaveBeenCalled();
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    expect(h.tx.document.count).not.toHaveBeenCalled();
  });
});

describe('loadClientCockpitBlocks', () => {
  it('prüft den Zugriff in der eigenen Transaktion und lädt ohne Zugriff nichts', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);

    const result = await loadClientCockpitBlocks(ctx, session, 'client-restricted', ALL_MODULES);

    expect(result).toBeNull();
    expect(h.tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-restricted', tenantId: 'tenant-1', vertraulich: false },
      select: { id: true },
    });
    for (const query of BLOCK_QUERIES) expect(query).not.toHaveBeenCalled();
  });

  it('lädt Anforderungen mit Cap/Select und die Blocklisten aktiver Module', async () => {
    prepareBlockRows();

    const result = await loadClientCockpitBlocks(
      ctx,
      session,
      'client-1',
      ALL_MODULES,
      new Date('2026-07-16T10:00:00.000Z'),
    );

    expect(result).not.toBeNull();
    expect(h.tx.request.findMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1' },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: CLIENT_REQUESTS_CAP,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        responses: { take: 1, orderBy: { createdAt: 'desc' }, select: { createdAt: true } },
      },
    });
    expect(h.tx.phoneNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          reminders: expect.objectContaining({
            select: { id: true, subject: true, dueDate: true, doneAt: true },
          }),
        },
      }),
    );
    expect(h.tx.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: 'client-1',
          status: { not: 'CANCELLED' },
          endsAt: { gte: new Date('2026-07-16T10:00:00.000Z') },
        },
      }),
    );
    for (const query of BLOCK_QUERIES) expect(query).toHaveBeenCalledTimes(1);
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
  });

  it('fragt abgeschaltete Module nicht ab (Anforderungen immer)', async () => {
    prepareBlockRows();

    const result = await loadClientCockpitBlocks(ctx, session, 'client-1', NO_MODULES);

    expect(result).toMatchObject({ requests: [], reminders: [], staffList: [] });
    expect(h.tx.request.findMany).toHaveBeenCalledTimes(1);
    for (const query of BLOCK_QUERIES.filter((q) => q !== h.tx.request.findMany)) {
      expect(query).not.toHaveBeenCalled();
    }
  });
});

function query(overrides: Partial<ClientDocumentsQuery> = {}): ClientDocumentsQuery {
  return { page: 1, deleted: false, folder: 'all', q: '', ...overrides };
}

describe('loadClientDocumentsPage', () => {
  it('begrenzt den Payload auf 50 und liefert Count sowie Seitennavigation', async () => {
    h.tx.client.findFirst.mockResolvedValue({ id: 'client-1' });
    h.tx.documentFolder.findMany.mockResolvedValue([
      { id: 'folder-1', name: 'Belege', parentId: null },
    ]);
    h.tx.document.groupBy.mockResolvedValue([{ folderId: null, _count: { _all: 123 } }]);
    h.tx.document.count.mockResolvedValue(123);
    h.tx.document.findFirst.mockResolvedValue({ id: 'datev-1' });
    h.tx.document.findMany.mockResolvedValue(
      Array.from({ length: 23 }, (_, index) => managedDocumentRow(`doc-${index + 101}`)),
    );

    const result = await loadClientDocumentsPage(ctx, session, 'client-1', query({ page: 3 }));

    expect(h.tx.document.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', clientId: 'client-1', deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 100,
      take: CLIENT_DOCUMENTS_PAGE_SIZE,
      select: MANAGED_DOC_SELECT,
    });
    expect(result).toMatchObject({
      totalCount: 123,
      totalPages: 3,
      page: 3,
      from: 101,
      to: 123,
      hasDatevDocuments: true,
      deleted: false,
    });
    expect(result?.documents).toHaveLength(23);
  });

  it('klemmt manipulierte Seitenwerte an die letzte vorhandene Seite', async () => {
    h.tx.client.findFirst.mockResolvedValue({ id: 'client-1' });
    h.tx.documentFolder.findMany.mockResolvedValue([]);
    h.tx.document.groupBy.mockResolvedValue([{ folderId: null, _count: { _all: 51 } }]);
    h.tx.document.count.mockResolvedValue(51);
    h.tx.document.findFirst.mockResolvedValue(null);
    h.tx.document.findMany.mockResolvedValue([managedDocumentRow('doc-51')]);

    const result = await loadClientDocumentsPage(
      ctx,
      session,
      'client-1',
      query({ page: 999, deleted: true }),
    );

    expect(result?.page).toBe(2);
    expect(h.tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          clientId: 'client-1',
          deletedAt: { not: null },
        },
        skip: 50,
        take: CLIENT_DOCUMENTS_PAGE_SIZE,
      }),
    );
  });

  it('führt bei verweigertem Zugriff keine Dokumentabfragen aus', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);

    const result = await loadClientDocumentsPage(ctx, session, 'client-restricted', query());

    expect(result).toBeNull();
    expect(h.tx.document.count).not.toHaveBeenCalled();
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    expect(h.tx.document.groupBy).not.toHaveBeenCalled();
    expect(h.tx.documentFolder.findMany).not.toHaveBeenCalled();
  });

  describe('Ordner und Suche filtern serverseitig über alle Dokumente', () => {
    const FOLDERS = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Belege', parentId: null },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: '2026',
        parentId: '11111111-1111-4111-8111-111111111111',
      },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Verträge', parentId: null },
    ];
    const [BELEGE, BELEGE_2026, VERTRAEGE] = FOLDERS.map((folder) => folder.id) as [
      string,
      string,
      string,
    ];

    function prepare(total: number) {
      h.tx.client.findFirst.mockResolvedValue({ id: 'client-1' });
      h.tx.documentFolder.findMany.mockResolvedValue(FOLDERS);
      h.tx.document.groupBy.mockResolvedValue([
        { folderId: null, _count: { _all: 40 } },
        { folderId: BELEGE, _count: { _all: 30 } },
        { folderId: BELEGE_2026, _count: { _all: 70 } },
        { folderId: VERTRAEGE, _count: { _all: 5 } },
      ]);
      h.tx.document.count.mockResolvedValue(total);
      h.tx.document.findFirst.mockResolvedValue(null);
      h.tx.document.findMany.mockResolvedValue([managedDocumentRow('doc-1')]);
    }

    it('schränkt Count und Seite auf den Ordner samt Unterordnern ein', async () => {
      prepare(100);

      const result = await loadClientDocumentsPage(
        ctx,
        session,
        'client-1',
        query({ folder: BELEGE, page: 2 }),
      );

      const where = {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        deletedAt: null,
        folderId: { in: [BELEGE, BELEGE_2026] },
      };
      expect(h.tx.document.count).toHaveBeenCalledWith({ where });
      expect(h.tx.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where, skip: 50, take: CLIENT_DOCUMENTS_PAGE_SIZE }),
      );
      expect(result).toMatchObject({ folder: BELEGE, totalCount: 100, totalPages: 2, page: 2 });
    });

    it('filtert „ohne Ordner“ und die Titelsuche über den ganzen Bestand', async () => {
      prepare(3);

      const result = await loadClientDocumentsPage(
        ctx,
        session,
        'client-1',
        query({ folder: 'none', q: '  Rechnung  ', deleted: true }),
      );

      const where = {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        deletedAt: { not: null },
        folderId: null,
        title: { contains: 'Rechnung', mode: 'insensitive' },
      };
      expect(h.tx.document.count).toHaveBeenCalledWith({ where });
      expect(h.tx.document.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(result).toMatchObject({ folder: 'none', q: 'Rechnung', deleted: true });
    });

    it('behandelt fremde Ordner-IDs wie „Alle“', async () => {
      prepare(145);

      const result = await loadClientDocumentsPage(
        ctx,
        session,
        'client-1',
        query({ folder: '44444444-4444-4444-8444-444444444444' }),
      );

      expect(h.tx.document.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', clientId: 'client-1', deletedAt: null },
      });
      expect(result?.folder).toBe('all');
    });

    it('zählt Ordner über alle Dokumente des Zustands (inkl. Unterordner), nicht über die Seite', async () => {
      prepare(145);

      const result = await loadClientDocumentsPage(ctx, session, 'client-1', query({ q: 'x' }));

      expect(h.tx.document.groupBy).toHaveBeenCalledWith({
        by: ['folderId'],
        where: { tenantId: 'tenant-1', clientId: 'client-1', deletedAt: null },
        _count: { _all: true },
      });
      expect(result?.folderCounts).toEqual({
        all: 145,
        none: 40,
        byId: { [BELEGE]: 100, [BELEGE_2026]: 70, [VERTRAEGE]: 5 },
      });
      expect(result?.documents[0]).toMatchObject({ id: 'doc-1', mimeType: 'application/pdf' });
    });
  });
});

describe('parseClientDocumentsFolder / parseClientDocumentsSearch', () => {
  it('akzeptiert nur „none“ oder eine UUID als Ordner', () => {
    expect(parseClientDocumentsFolder(undefined)).toBe('all');
    expect(parseClientDocumentsFolder('none')).toBe('none');
    expect(parseClientDocumentsFolder('../etc')).toBe('all');
    expect(parseClientDocumentsFolder(['11111111-1111-4111-8111-111111111111', 'x'])).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('kürzt und begrenzt den Suchbegriff', () => {
    expect(parseClientDocumentsSearch(undefined)).toBe('');
    expect(parseClientDocumentsSearch('  Beleg  ')).toBe('Beleg');
    expect(parseClientDocumentsSearch('x'.repeat(500))).toHaveLength(200);
  });
});

describe('parseClientDocumentsPage', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['0', 1],
    ['-1', 1],
    ['1.5', 1],
    ['abc', 1],
    [['3', '4'], 3],
    ['7', 7],
  ])('normalisiert %j zu %i', (value, expected) => {
    expect(parseClientDocumentsPage(value)).toBe(expected);
  });
});

describe('parseClientDocumentsDeleted', () => {
  it('akzeptiert ausschließlich den kanonischen Wert 1', () => {
    expect(parseClientDocumentsDeleted('1')).toBe(true);
    expect(parseClientDocumentsDeleted(['1', '0'])).toBe(true);
    expect(parseClientDocumentsDeleted('true')).toBe(false);
    expect(parseClientDocumentsDeleted(undefined)).toBe(false);
  });
});
