// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: WORKFLOW-DEPENDENCY-001
// Fachkatalog: CLIENT-OFFBOARDING-001
// Fachkatalog: VDB-PREPARATION-001
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
const mocks = vi.hoisted(() => ({ access: vi.fn(), audit: vi.fn(), admin: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: mocks.access,
  accessibleClientsWhereFor: vi.fn(),
  ActionError: class extends Error {},
  isStaffAdmin: mocks.admin,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.audit } }));
import { loadStructureTx, saveStructureTx, changeDependencyTx } from '../service';
import { recordVdbStateTx } from '../vdb';
import {
  offboardingSourceTx,
  prepareOffboardingTx,
  finishOffboardingTx,
  handoverPreparationHash,
} from '../offboarding';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const session = { user: { tenantId: 'tenant', staffId: 'staff' } } as StaffSession;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.admin.mockReturnValue(true);
});
describe('MANDATE-STRUCTURE-001 authorization and stale writes', () => {
  it('does not return the saved labels when either linked mandate becomes inaccessible', async () => {
    mocks.access.mockImplementation(async (_tx, _session, id) => {
      if (id === b) throw new Error('denied');
    });
    const tx = {
      client: { findFirst: vi.fn().mockResolvedValue({ id: a }) },
      mandateStructureVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ nodes: [{ linkedClientId: b, label: 'Confidential' }], edges: [] }),
      },
    } as unknown as TxClient;
    await expect(loadStructureTx(tx, session, a)).rejects.toThrow('denied');
  });
  it('rejects a stale revision before creating any snapshot', async () => {
    const create = vi.fn();
    const tx = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      client: { findFirst: vi.fn().mockResolvedValue({ id: a }) },
      mandateStructureVersion: { findFirst: vi.fn().mockResolvedValue(null), create },
    } as unknown as TxClient;
    await expect(
      saveStructureTx(tx, session, {
        clientId: a,
        expectedRevision: 2,
        note: '',
        nodes: [{ key: a, kind: 'CLIENT', label: 'A', linkedClientId: a, x: 0, y: 0 }],
        edges: [],
      }),
    ).rejects.toThrow('inzwischen');
    expect(create).not.toHaveBeenCalled();
  });
  it('does not expose historical labels of an anonymized linked mandate', async () => {
    const tx = {
      client: { findFirst: vi.fn().mockResolvedValueOnce({ id: a }).mockResolvedValueOnce(null) },
      mandateStructureVersion: {
        findFirst: vi.fn().mockResolvedValue({
          nodes: [{ linkedClientId: b, label: 'Former secret name' }],
          edges: [],
        }),
      },
    } as unknown as TxClient;
    await expect(loadStructureTx(tx, session, a)).rejects.toThrow('nicht verfügbar');
  });
  it('refuses a stored structure whose current content does not match its bound hash', async () => {
    const tx = {
      client: { findFirst: vi.fn().mockResolvedValue({ id: a }) },
      mandateStructureVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: b,
          revision: 1,
          contentHash: '0'.repeat(64),
          note: '',
          createdAt: new Date(),
          nodes: [
            {
              id: a,
              nodeKey: a,
              kind: 'CLIENT',
              label: 'Altered',
              linkedClientId: a,
              x: 0,
              y: 0,
            },
          ],
          edges: [],
        }),
      },
    } as unknown as TxClient;
    await expect(loadStructureTx(tx, session, a)).rejects.toThrow('Quellenhash');
  });
});
describe('WORKFLOW-DEPENDENCY-001 access at mutation', () => {
  it('rejects a hidden endpoint before inserting or removing an edge', async () => {
    mocks.access.mockImplementation(async (_tx, _session, id) => {
      if (id === b) throw new Error('denied');
    });
    const createMany = vi.fn(),
      deleteMany = vi.fn();
    const tx = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      workflowItem: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'one', instance: { clientId: a } },
          { id: 'two', instance: { clientId: b } },
        ]),
      },
      workflowDependency: { createMany, deleteMany },
    } as unknown as TxClient;
    await expect(changeDependencyTx(tx, session, 'one', 'two')).rejects.toThrow();
    expect(createMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
describe('VDB-PREPARATION-001 evidence and concurrent status', () => {
  const input = {
    poaId: a,
    expectedRevision: 1,
    status: 'REPORTED',
    recordedAt: '2026-01-01',
    externalReference: '',
    evidenceVersionId: b,
    note: 'External receipt attached',
  };
  function tx(previous = { status: 'PREPARED', revision: 1 }) {
    return {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      powerOfAttorney: {
        findFirst: vi.fn().mockResolvedValue({ id: a, clientId: a, status: 'SIGNED' }),
      },
      vdbRecord: { findFirst: vi.fn().mockResolvedValue(previous), create: vi.fn() },
      documentVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    };
  }
  it('rejects stale external state without writing an event', async () => {
    const db = tx({ status: 'REPORTED', revision: 2 });
    await expect(recordVdbStateTx(db as unknown as TxClient, session, input)).rejects.toThrow(
      'geändert',
    );
    expect(db.vdbRecord.create).not.toHaveBeenCalled();
  });
  it('requires a clean same-mandate evidence version for reported state', async () => {
    const db = tx();
    await expect(recordVdbStateTx(db as unknown as TxClient, session, input)).rejects.toThrow(
      'Nachweis',
    );
    expect(db.documentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          document: expect.objectContaining({ clientId: a, tenantId: 'tenant' }),
        }),
      }),
    );
    expect(db.vdbRecord.create).not.toHaveBeenCalled();
  });
  it('uses the state after acquiring the lock, rejecting a concurrently revoked power', async () => {
    const db = tx();
    db.powerOfAttorney.findFirst
      .mockResolvedValueOnce({ id: a, clientId: a, status: 'SIGNED' })
      .mockResolvedValueOnce({ id: a, clientId: a, status: 'REVOKED' });
    await expect(recordVdbStateTx(db as unknown as TxClient, session, input)).rejects.toThrow(
      'technisch bestätigt',
    );
    expect(db.vdbRecord.create).not.toHaveBeenCalled();
  });
});

describe('CLIENT-OFFBOARDING-001 verified scope and mandate end', () => {
  function db() {
    return {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      client: {
        findFirst: vi.fn().mockResolvedValue({ id: a, name: 'Mandat', mandateEndedAt: null }),
        update: vi.fn(),
      },
      document: { findMany: vi.fn().mockResolvedValue([]) },
      taxDeadline: { findMany: vi.fn().mockResolvedValue([]) },
      taxNotice: { findMany: vi.fn().mockResolvedValue([]) },
      request: { findMany: vi.fn().mockResolvedValue([]) },
      clientContact: { findMany: vi.fn().mockResolvedValue([{ id: b }]) },
      gwgCheck: { findMany: vi.fn().mockResolvedValue([]) },
      mandateOffboarding: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: b }),
        update: vi.fn(),
      },
      mandateArtifact: {
        findMany: vi.fn().mockResolvedValue([
          {
            groupKey: 'PROTOCOL',
            status: 'READY',
            documentVersion: { scanStatus: 'CLEAN', scanCompletedAt: new Date(), document: {} },
          },
        ]),
      },
      mandateOffboardingDocument: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
  }
  const input = {
    clientId: a,
    expectedHash: 'stale',
    endDate: '2026-01-01',
    versionIds: [],
    sensitiveVersionIds: [],
    recipient: 'Nachfolger Kanzlei, Teststraße 1',
    handoverNote: 'Open matters reviewed',
    retentionNote: 'Exceptions require review',
  };
  it('denies employees before loading the source record', async () => {
    mocks.admin.mockReturnValue(false);
    const data = db();
    await expect(prepareOffboardingTx(data as unknown as TxClient, session, input)).rejects.toThrow(
      'ADMIN/PARTNER',
    );
    expect(data.client.findFirst).not.toHaveBeenCalled();
  });
  it('rejects a changed source and leaves every selection untouched', async () => {
    const data = db();
    await expect(prepareOffboardingTx(data as unknown as TxClient, session, input)).rejects.toThrow(
      'Akte hat sich geändert',
    );
    expect(data.mandateOffboarding.create).not.toHaveBeenCalled();
    expect(data.mandateOffboardingDocument.deleteMany).not.toHaveBeenCalled();
  });
  it('rejects a forged document version even when the source hash is current', async () => {
    const data = db();
    const source = await offboardingSourceTx(data as unknown as TxClient, session, a);
    await expect(
      prepareOffboardingTx(data as unknown as TxClient, session, {
        ...input,
        expectedHash: source.hash,
        versionIds: [b],
      }),
    ).rejects.toThrow('Dokumentfassung');
    expect(data.mandateOffboarding.create).not.toHaveBeenCalled();
  });
  it('requires an extra sensitive release without using portal visibility as handover permission', async () => {
    const data = db();
    data.document.findMany.mockResolvedValue([
      {
        id: a,
        title: 'Interner Nachweis',
        classification: 'STAFF_PRIVATE',
        requiresPayrollAccess: false,
        sharedWithClientAt: null,
        versions: [
          {
            id: b,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            sha256: Buffer.alloc(32),
            sizeBytes: 100n,
          },
        ],
      },
    ] as never);
    const source = await offboardingSourceTx(data as unknown as TxClient, session, a);
    expect(source.snapshot.documents).toHaveLength(1);
    expect(data.document.findMany.mock.calls[0]?.[0]).not.toHaveProperty(
      'where.sharedWithClientAt',
    );
    await expect(
      prepareOffboardingTx(data as unknown as TxClient, session, {
        ...input,
        expectedHash: source.hash,
        versionIds: [b],
      }),
    ).rejects.toThrow('zusätzliche');
    await prepareOffboardingTx(data as unknown as TxClient, session, {
      ...input,
      expectedHash: source.hash,
      versionIds: [b],
      sensitiveVersionIds: [b],
    });
    expect(data.mandateOffboardingDocument.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          documentVersionId: b,
          sensitiveApproved: true,
          approvedBy: 'staff',
          approvedAt: expect.any(Date),
        }),
      ],
    });
  });
  it('does not complete a handover whose current protocol and ZIP parts are not archived', async () => {
    const data = db();
    const source = await offboardingSourceTx(data as unknown as TxClient, session, a);
    data.mandateOffboarding.findFirst.mockResolvedValue({
      ...input,
      documents: [],
      id: b,
      clientId: a,
      sourceHash: source.hash,
      endDate: new Date(input.endDate),
      completedAt: null,
    } as never);
    data.mandateArtifact.findMany.mockResolvedValue([]);
    await expect(
      finishOffboardingTx(
        data as unknown as TxClient,
        session,
        b,
        handoverPreparationHash({
          ...input,
          documents: [],
          sourceHash: source.hash,
          endDate: new Date(input.endDate),
        }),
      ),
    ).rejects.toThrow('vollständig archivieren');
    expect(data.client.update).not.toHaveBeenCalled();
  });
  it('rejects an old completion tab after the recipient changes even when the document source stays identical', async () => {
    const data = db();
    const source = await offboardingSourceTx(data as unknown as TxClient, session, a);
    const reviewed = {
      ...input,
      documents: [],
      sourceHash: source.hash,
      endDate: new Date(input.endDate),
    };
    data.mandateOffboarding.findFirst.mockResolvedValue({
      ...reviewed,
      recipient: 'Anderer Empfänger, Markt 2',
      id: b,
      clientId: a,
      completedAt: null,
    } as never);
    await expect(
      finishOffboardingTx(
        data as unknown as TxClient,
        session,
        b,
        handoverPreparationHash(reviewed),
      ),
    ).rejects.toThrow('Empfänger');
    expect(data.client.update).not.toHaveBeenCalled();
  });
  it('does not end a mandate when an open deadline changed after preparation', async () => {
    const data = db();
    const source = await offboardingSourceTx(data as unknown as TxClient, session, a);
    data.mandateOffboarding.findFirst.mockResolvedValue({
      ...input,
      documents: [],
      id: b,
      clientId: a,
      sourceHash: source.hash,
      endDate: new Date(input.endDate),
      completedAt: null,
    } as never);
    data.taxDeadline.findMany.mockResolvedValue([
      { id: b, kind: 'EST', period: '2026', dueDate: new Date('2026-09-30'), status: 'PLANNED' },
    ] as never);
    await expect(
      finishOffboardingTx(
        data as unknown as TxClient,
        session,
        b,
        handoverPreparationHash({
          ...input,
          documents: [],
          sourceHash: source.hash,
          endDate: new Date(input.endDate),
        }),
      ),
    ).rejects.toThrow('Akte oder Mandatsstatus');
    expect(data.client.update).not.toHaveBeenCalled();
  });
  it('sets the reviewed actual date and returns contacts for additional revocation', async () => {
    const data = db();
    const source = await offboardingSourceTx(data as unknown as TxClient, session, a);
    data.mandateOffboarding.findFirst.mockResolvedValue({
      ...input,
      documents: [],
      id: b,
      clientId: a,
      sourceHash: source.hash,
      endDate: new Date(input.endDate),
      completedAt: null,
    } as never);
    await expect(
      finishOffboardingTx(
        data as unknown as TxClient,
        session,
        b,
        handoverPreparationHash({
          ...input,
          documents: [],
          sourceHash: source.hash,
          endDate: new Date(input.endDate),
        }),
      ),
    ).resolves.toEqual({ clientId: a, contactIds: [b] });
    expect(data.client.update).toHaveBeenCalledWith({
      where: { id: a },
      data: { mandateEndedAt: new Date(input.endDate) },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({ retentionDecision: 'manual_review_only' }),
      }),
    );
  });
});
