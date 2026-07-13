import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  deleteObjectVersion: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({ deleteObjectVersion: m.deleteObjectVersion }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: m.staffActionGuard }));

import { confirmGwgCheckDeletionAction, confirmGwgDeletionAction } from '../actions';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

function makeTx(
  claimedStorageKey = 'tenant/doc/version-1',
  claimedStorageVersionId: string | null = 'storage-version-claimed',
) {
  return {
    document: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          id: DOCUMENT_ID,
          title: 'Ausweis.pdf',
          clientId: 'client-1',
          createdAt: new Date('2010-01-01T00:00:00Z'),
          retentionUntil: new Date('2015-01-01T00:00:00Z'),
          gwgDestructionRequestedAt: null,
          client: { mandateEndedAt: new Date('2010-01-01T00:00:00Z') },
          gwgIdDocuments: [],
          gwgOnboardingInvite: null,
          versions: [
            {
              id: 'version-before-claim',
              storageBucket: 'gwg',
              storageKey: 'tenant/doc/version-1',
              storageVersionId: 'storage-version-before-claim',
            },
          ],
        })
        .mockResolvedValueOnce({
          versions: [
            {
              id: 'version-claimed',
              storageBucket: 'gwg',
              storageKey: claimedStorageKey,
              storageVersionId: claimedStorageVersionId,
            },
          ],
        })
        .mockResolvedValueOnce({ id: DOCUMENT_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ gwgDestroyedAt: new Date('2032-01-01T00:00:00Z') }),
    },
    gwgIdDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn().mockResolvedValue([{ destroy_gwg_document_versions: 1 }]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  m.evidenceRecord.mockResolvedValue({});
  m.deleteObjectVersion.mockResolvedValue(undefined);
});

describe('confirmGwgDeletionAction', () => {
  it('blockiert fail-closed bei fehlendem Object-Lock-Stichtag vor der Vormerkung', async () => {
    const tx = makeTx();
    tx.document.findFirst.mockReset().mockResolvedValue({
      id: DOCUMENT_ID,
      title: 'Ausweis.pdf',
      clientId: 'client-1',
      createdAt: new Date('2010-01-01T00:00:00Z'),
      retentionUntil: null,
      gwgDestructionRequestedAt: null,
      client: { mandateEndedAt: new Date('2010-01-01T00:00:00Z') },
      gwgIdDocuments: [],
      gwgOnboardingInvite: null,
      versions: [],
    });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });

  it('persistiert die Vernichtungsabsicht vor dem Byte-Delete und finalisiert danach', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });

    expect(tx.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gwgDestructionRequestedAt: expect.any(Date),
          gwgDestructionRequestedBy: 'staff-1',
        }),
      }),
    );
    expect(tx.document.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      m.deleteObjectVersion.mock.invocationCallOrder[0]!,
    );
    expect(m.deleteObjectVersion.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[1]!,
    );
    expect(tx.document.findUnique).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      select: { gwgDestroyedAt: true },
    });
  });

  it('löscht keine Object-Bytes, wenn der atomare DB-Claim eine neue Referenz erkennt', async () => {
    const tx = makeTx();
    tx.$queryRaw.mockRejectedValueOnce(new Error('GwG-Beleg wird wieder benötigt'));
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
    expect(tx.document.update).not.toHaveBeenCalled();
  });

  it('löscht ausschließlich die nach committed Claim neu geladene Versionsliste', async () => {
    const tx = makeTx('tenant/doc/concurrently-added');
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });

    expect(m.deleteObjectVersion).toHaveBeenCalledWith(
      'gwg',
      'tenant/doc/concurrently-added',
      'storage-version-claimed',
      { bypassGovernanceRetention: true },
    );
    expect(m.deleteObjectVersion).not.toHaveBeenCalledWith(
      'gwg',
      'tenant/doc/version-1',
      expect.anything(),
      expect.anything(),
    );
  });

  it('behält bei Object-Store-Fehler den wiederaufnehmbaren Pending-Zustand', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    m.deleteObjectVersion.mockRejectedValueOnce(new Error('S3 unavailable'));

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(tx.document.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.document.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: DOCUMENT_ID,
        gwgDestructionRequestedAt: { not: null },
        gwgDestroyedAt: null,
      },
      data: { gwgDestructionError: 'S3 unavailable' },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.document.update).not.toHaveBeenCalled();
  });

  it('finalisiert ohne persistierte Storage-VersionId keine GwG-Vernichtung', async () => {
    const tx = makeTx('tenant/doc/version-1', null);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.document.findUnique).not.toHaveBeenCalled();
  });
});

describe('confirmGwgCheckDeletionAction', () => {
  it('delegiert Fristprüfung und Vernichtung atomar an die DB-Funktion', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          clientId: 'client-1',
          status: 'REJECTED',
          retentionStartedAt: '2020-01-01T00:00:00Z',
          destroyedAt: '2026-01-02T00:00:00Z',
          beneficialOwners: 1,
          idDocuments: 2,
        },
      ]),
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn(tx),
    );

    expect(
      await confirmGwgCheckDeletionAction({ checkId: '22222222-2222-4222-8222-222222222222' }),
    ).toEqual({ ok: true });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.check.destroy',
        before: { status: 'REJECTED', beneficialOwners: 1, idDocuments: 2 },
        after: expect.objectContaining({ destroyed: true }),
      }),
    );
  });

  it('bleibt bei abgelehnter DB-Fristprüfung ohne Audit fail-closed', async () => {
    const tx = { $queryRaw: vi.fn().mockRejectedValue(new Error('Frist läuft')) };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgCheckDeletionAction({
      checkId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.ok).toBe(false);
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});
