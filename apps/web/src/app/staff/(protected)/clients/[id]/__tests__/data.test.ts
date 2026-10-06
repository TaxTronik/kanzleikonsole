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
  const loadMailDeliveryTx = vi.fn(async () => new Map());
  return { tx, readRequestCreationOptionsTx, accessibleClientsWhereFor, loadMailDeliveryTx };
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

vi.mock('@/server/mail/delivery-status', () => ({
  loadMailDeliveryTx: h.loadMailDeliveryTx,
}));

import { withTenantContext } from '@taxtronik/db';
import {
  CLIENT_DOCUMENTS_PAGE_SIZE,
  CLIENT_REQUESTS_CAP,
  loadClientCockpitHeader,
  loadClientDocumentsPage,
  loadHandoversBlockTx,
  loadPhoneNotesBlockTx,
  loadRemindersBlockTx,
  loadRequestsBlockTx,
  loadUpcomingBlockTx,
  parseClientDocumentsDeleted,
  parseClientDocumentsFolder,
  parseClientDocumentsPage,
  parseClientDocumentsSearch,
  startClientCockpitBlocks,
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
  vi.resetAllMocks();
  h.accessibleClientsWhereFor.mockResolvedValue({ vertraulich: false });
  h.loadMailDeliveryTx.mockResolvedValue(new Map());
  vi.mocked(withTenantContext).mockImplementation(async (_ctx, callback) =>
    callback(h.tx as never),
  );
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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Ergebnis der (gemockten) Tenant-Transaktion des letzten startClientCockpitBlocks-Aufrufs. */
function lastTransaction(): Promise<unknown> {
  const results = vi.mocked(withTenantContext).mock.results;
  return results.at(-1)!.value as Promise<unknown>;
}

describe('Loader je Cockpit-Block', () => {
  it('lädt Anforderungen mit Cap und schmalem Select', async () => {
    h.tx.request.findMany.mockResolvedValue([{ id: 'r1' }]);

    await expect(loadRequestsBlockTx(h.tx as never, 'client-1')).resolves.toEqual([{ id: 'r1' }]);
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
  });

  it('fragt Steuertermine und Termine nur für aktive Module ab', async () => {
    const now = new Date('2026-07-16T10:00:00.000Z');
    for (const query of BLOCK_QUERIES) query.mockResolvedValue([]);

    await expect(
      loadUpcomingBlockTx(
        h.tx as never,
        'client-1',
        { taxNotices: true, appointments: false },
        now,
      ),
    ).resolves.toEqual({
      taxDeadlines: [],
      upcomingAppointments: [],
      pendingAppointmentRequests: [],
    });
    expect(h.tx.taxDeadline.findMany).toHaveBeenCalledWith({
      where: {
        clientId: 'client-1',
        status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
      },
      orderBy: { dueDate: 'asc' },
      take: 12,
    });
    expect(h.tx.appointment.findMany).not.toHaveBeenCalled();
    expect(h.tx.appointmentRequest.findMany).not.toHaveBeenCalled();

    await loadUpcomingBlockTx(
      h.tx as never,
      'client-1',
      { taxNotices: false, appointments: true },
      now,
    );
    expect(h.tx.taxDeadline.findMany).toHaveBeenCalledTimes(1);
    expect(h.tx.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client-1', status: { not: 'CANCELLED' }, endsAt: { gte: now } },
        take: 5,
      }),
    );
    expect(h.tx.appointmentRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client-1', status: 'PENDING' }, take: 10 }),
    );
  });

  // Fachkatalog: REMINDER-TICKET-001
  it('zeigt nur nicht archivierte Wiedervorlagen, offene zuerst', async () => {
    h.tx.clientReminder.findMany.mockResolvedValue([]);

    await loadRemindersBlockTx(h.tx as never, 'client-1');

    expect(h.tx.clientReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client-1', archivedAt: null },
        orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
        take: 50,
      }),
    );
  });

  it('lädt Telefonnotizen mit ihren Wiedervorlagen', async () => {
    h.tx.phoneNote.findMany.mockResolvedValue([]);

    await loadPhoneNotesBlockTx(h.tx as never, 'client-1');

    expect(h.tx.phoneNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client-1' },
        take: 20,
        include: {
          reminders: expect.objectContaining({
            select: { id: true, subject: true, dueDate: true, doneAt: true },
          }),
        },
      }),
    );
  });

  it('hängt jeder Anlieferung den Zustellstatus ihrer Abhol-Mail an (F-08)', async () => {
    h.tx.clientHandover.findMany.mockResolvedValue([{ id: 'ho-1' }, { id: 'ho-2' }]);
    const delivered = [{ purpose: 'pickup', status: 'SENT' }];
    h.loadMailDeliveryTx.mockResolvedValue(new Map([['ho-1', delivered]]));

    await expect(loadHandoversBlockTx(h.tx as never, 'client-1')).resolves.toEqual([
      { id: 'ho-1', mailDelivery: delivered },
      { id: 'ho-2', mailDelivery: [] },
    ]);
    expect(h.loadMailDeliveryTx).toHaveBeenCalledWith(h.tx, {
      resourceType: 'client_handover',
      resourceIds: ['ho-1', 'ho-2'],
    });
  });
});

describe('startClientCockpitBlocks', () => {
  it('prüft den Zugriff in der eigenen Transaktion und lädt ohne Zugriff nichts', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);

    const loads = startClientCockpitBlocks(ctx, session, 'client-restricted', ALL_MODULES);

    for (const load of Object.values(loads)) await expect(load).resolves.toBeNull();
    expect(h.tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-restricted', tenantId: 'tenant-1', vertraulich: false },
      select: { id: true },
    });
    for (const query of BLOCK_QUERIES) expect(query).not.toHaveBeenCalled();
    await expect(lastTransaction()).resolves.toBeUndefined();
  });

  it('liefert jedem Block seine eigenen Daten und lädt die Mitarbeiterauswahl einmal', async () => {
    prepareBlockRows();
    const staff = [{ id: 'staff-1', fullName: 'Anna' }];
    h.tx.request.findMany.mockResolvedValue([{ id: 'r1' }]);
    h.tx.staffUser.findMany.mockResolvedValue(staff);
    h.tx.clientReminder.findMany.mockResolvedValue([{ id: 'rem-1' }]);
    h.tx.phoneNote.findMany.mockResolvedValue([{ id: 'note-1' }]);
    h.tx.workflowInstance.findMany.mockResolvedValue([{ id: 'wf-1' }]);
    h.tx.pendingBinder.findMany.mockResolvedValue([{ id: 'binder-1' }]);
    h.tx.taxDeadline.findMany.mockResolvedValue([{ id: 'deadline-1' }]);

    const loads = startClientCockpitBlocks(
      ctx,
      session,
      'client-1',
      ALL_MODULES,
      new Date('2026-07-16T10:00:00.000Z'),
    );

    await expect(loads.requests).resolves.toEqual([{ id: 'r1' }]);
    await expect(loads.upcoming).resolves.toEqual({
      taxDeadlines: [{ id: 'deadline-1' }],
      upcomingAppointments: [],
      pendingAppointmentRequests: [],
      staffList: staff,
    });
    await expect(loads.workflows).resolves.toEqual([{ id: 'wf-1' }]);
    await expect(loads.reminders).resolves.toEqual({
      reminders: [{ id: 'rem-1' }],
      staffList: staff,
    });
    await expect(loads.phoneNotes).resolves.toEqual({
      phoneNotes: [{ id: 'note-1' }],
      staffList: staff,
    });
    await expect(loads.binders).resolves.toEqual([{ id: 'binder-1' }]);
    await expect(loads.handovers).resolves.toEqual([]);
    for (const query of BLOCK_QUERIES) expect(query).toHaveBeenCalledTimes(1);
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    await expect(lastTransaction()).resolves.toBeUndefined();
  });

  it('stellt die Abfragen in fester Reihenfolge an (Anforderungen zuerst, Anlieferungen zuletzt)', async () => {
    prepareBlockRows();

    const loads = startClientCockpitBlocks(ctx, session, 'client-1', ALL_MODULES);
    await Promise.all(Object.values(loads));

    const order = [
      h.tx.request.findMany,
      h.tx.taxDeadline.findMany,
      h.tx.appointment.findMany,
      h.tx.appointmentRequest.findMany,
      h.tx.staffUser.findMany,
      h.tx.workflowInstance.findMany,
      h.tx.clientReminder.findMany,
      h.tx.phoneNote.findMany,
      h.tx.pendingBinder.findMany,
      h.tx.clientHandover.findMany,
    ].map((query) => query.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('fragt abgeschaltete Module nicht ab (Anforderungen immer)', async () => {
    prepareBlockRows();

    const loads = startClientCockpitBlocks(ctx, session, 'client-1', NO_MODULES);

    await expect(loads.requests).resolves.toEqual([]);
    await expect(loads.reminders).resolves.toEqual({ reminders: [], staffList: [] });
    await expect(loads.upcoming).resolves.toEqual({
      taxDeadlines: [],
      upcomingAppointments: [],
      pendingAppointmentRequests: [],
      staffList: [],
    });
    expect(h.tx.request.findMany).toHaveBeenCalledTimes(1);
    for (const query of BLOCK_QUERIES.filter((q) => q !== h.tx.request.findMany)) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('streamt einen Block, sobald SEINE Daten da sind, auch wenn andere noch laden', async () => {
    prepareBlockRows();
    const reminders = deferred<unknown[]>();
    h.tx.clientReminder.findMany.mockReturnValue(reminders.promise);
    h.tx.request.findMany.mockResolvedValue([{ id: 'r1' }]);

    const loads = startClientCockpitBlocks(ctx, session, 'client-1', ALL_MODULES);
    let remindersDone = false;
    void loads.reminders.then(() => {
      remindersDone = true;
    });

    await expect(loads.requests).resolves.toEqual([{ id: 'r1' }]);
    await expect(loads.workflows).resolves.toEqual([]);
    expect(remindersDone).toBe(false);

    reminders.resolve([{ id: 'rem-1' }]);
    await expect(loads.reminders).resolves.toEqual({ reminders: [{ id: 'rem-1' }], staffList: [] });
    await expect(lastTransaction()).resolves.toBeUndefined();
  });

  it('meldet einen Abfragefehler nur dem betroffenen Block und rollt die Transaktion zurück', async () => {
    prepareBlockRows();
    const failure = new Error('Abfrage fehlgeschlagen');
    h.tx.clientReminder.findMany.mockRejectedValue(failure);

    const loads = startClientCockpitBlocks(ctx, session, 'client-1', ALL_MODULES);

    await expect(loads.reminders).rejects.toBe(failure);
    await expect(loads.requests).resolves.toEqual([]);
    await expect(loads.binders).resolves.toEqual([]);
    // Der Callback wirft den Fehler weiter, damit withTenantContext zurückrollt.
    await expect(lastTransaction()).rejects.toBe(failure);
  });

  it('lässt alle Blöcke scheitern, wenn schon die Zugriffsprüfung scheitert', async () => {
    const failure = new Error('Verbindung verloren');
    h.tx.client.findFirst.mockRejectedValue(failure);

    const loads = startClientCockpitBlocks(ctx, session, 'client-1', ALL_MODULES);

    for (const load of Object.values(loads)) await expect(load).rejects.toBe(failure);
    for (const query of BLOCK_QUERIES) expect(query).not.toHaveBeenCalled();
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
