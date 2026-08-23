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
    documentFolder: { findMany: vi.fn() },
    document: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
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
  loadClientDashboard,
  loadClientDocumentsPage,
  parseClientDocumentsDeleted,
  parseClientDocumentsPage,
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

function prepareDashboardRows() {
  h.tx.client.findFirst.mockResolvedValue({
    id: 'client-1',
    requests: [],
    contacts: [],
    gwgChecks: [],
    responsibilities: [],
    _count: { poas: 0, gwgInvites: 0, gwgChecks: 0 },
  });
  h.tx.phoneNote.findMany.mockResolvedValue([]);
  h.tx.taxDeadline.findMany.mockResolvedValue([]);
  h.tx.clientMasterChangeRequest.count.mockResolvedValue(0);
  h.tx.clientCustomFieldDef.findMany.mockResolvedValue([]);
  h.tx.clientCustomFieldValue.findMany.mockResolvedValue([]);
  h.tx.staffUser.findMany.mockResolvedValue([]);
  h.tx.workflowInstance.findMany.mockResolvedValue([]);
  h.tx.clientReminder.findMany.mockResolvedValue([]);
  h.tx.pendingBinder.findMany.mockResolvedValue([]);
  h.tx.appointment.findMany.mockResolvedValue([]);
  h.tx.appointmentRequest.findMany.mockResolvedValue([]);
  h.tx.clientHandover.findMany.mockResolvedValue([]);
  h.readRequestCreationOptionsTx.mockResolvedValue({
    requestTemplates: [],
    requestFormTemplates: [],
    templatesLimited: false,
    formTemplatesLimited: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.accessibleClientsWhereFor.mockResolvedValue({ vertraulich: false });
});

describe('loadClientDashboard', () => {
  it('behält den Tenant-Backstop und startet nach einem Miss keine Folgeabfragen', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);
    h.tx.client.findUnique.mockResolvedValue(null);

    const result = await loadClientDashboard(ctx, session, 'client-foreign');

    expect(result).toEqual({ status: 'not_found' });
    expect(h.tx.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'client-foreign', tenantId: 'tenant-1', vertraulich: false },
      }),
    );
    expect(h.tx.phoneNote.findMany).not.toHaveBeenCalled();
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
  });

  it('liefert bei RESTRICTED-Verweigerung fail-closed keine Cockpit-Daten', async () => {
    h.tx.client.findFirst.mockResolvedValue(null);
    h.tx.client.findUnique.mockResolvedValue({ id: 'client-restricted' });

    const result = await loadClientDashboard(ctx, session, 'client-restricted');

    expect(result).toEqual({ status: 'forbidden' });
    expect(h.tx.phoneNote.findMany).not.toHaveBeenCalled();
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
  });

  it('lädt das Cockpit ohne Dokumentzeilen und behält den Request-Cap/Select', async () => {
    prepareDashboardRows();

    const result = await loadClientDashboard(
      ctx,
      session,
      'client-1',
      new Date('2026-07-16T10:00:00.000Z'),
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Cockpit wurde nicht geladen.');
    expect(result.data.client.id).toBe('client-1');
    const clientArgs = h.tx.client.findFirst.mock.calls[0]![0];
    expect(clientArgs.include).not.toHaveProperty('documentFolders');
    expect(clientArgs.include.requests).toMatchObject({
      take: CLIENT_REQUESTS_CAP,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        responses: expect.objectContaining({ select: { createdAt: true } }),
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
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    expect(h.tx.document.count).not.toHaveBeenCalled();
    expect(h.tx.documentFolder.findMany).not.toHaveBeenCalled();
  });
});

describe('loadClientDocumentsPage', () => {
  it('begrenzt den Payload auf 50 und liefert Count sowie Seitennavigation', async () => {
    h.tx.client.findFirst.mockResolvedValue({ id: 'client-1' });
    h.tx.documentFolder.findMany.mockResolvedValue([
      { id: 'folder-1', name: 'Belege', parentId: null },
    ]);
    h.tx.document.count.mockResolvedValue(123);
    h.tx.document.findFirst.mockResolvedValue({ id: 'datev-1' });
    h.tx.document.findMany.mockResolvedValue(
      Array.from({ length: 23 }, (_, index) => managedDocumentRow(`doc-${index + 101}`)),
    );

    const result = await loadClientDocumentsPage(ctx, session, 'client-1', 3, false);

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
    h.tx.document.count.mockResolvedValue(51);
    h.tx.document.findFirst.mockResolvedValue(null);
    h.tx.document.findMany.mockResolvedValue([managedDocumentRow('doc-51')]);

    const result = await loadClientDocumentsPage(ctx, session, 'client-1', 999, true);

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

    const result = await loadClientDocumentsPage(ctx, session, 'client-restricted', 1, false);

    expect(result).toBeNull();
    expect(h.tx.document.count).not.toHaveBeenCalled();
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    expect(h.tx.documentFolder.findMany).not.toHaveBeenCalled();
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
