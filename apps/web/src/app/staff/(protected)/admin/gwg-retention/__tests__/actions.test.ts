import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  deleteObjectVersion: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
  /** RT3B-K-01: offene Verknüpfung des Tax-CMS (je Aufruf von istNachweisDokumentTx). */
  gebunden: vi.fn(),
  /** kk-tcms-s11: Ende der steuerlichen Aufbewahrung eines (früheren) Nachweises. */
  steuerfrist: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({ deleteObjectVersion: m.deleteObjectVersion }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/tcms/durchfuehrung/sperre', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  istNachweisDokumentTx: m.gebunden,
  nachweisSteuerfristTx: m.steuerfrist,
}));
vi.mock('@/server/actions/staff-action', async () => ({
  staffActionGuard: m.staffActionGuard,
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(m.staffActionGuard),
}));

import { Prisma } from '@taxtronik/db/prisma-client';
import {
  TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
  tcmsNachweisSteuerfristText,
} from '@/server/tcms/durchfuehrung/sperre';
import { confirmGwgCheckDeletionAction, confirmGwgDeletionAction } from '../actions';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '22222222-2222-4222-8222-222222222222';

function makeTx(
  claimedStorageKey = 'tenant/doc/version-1',
  claimedStorageVersionId: string | null = 'storage-version-claimed',
  /** RT3D-K-01: (auch freigegebene) Verweise des Tax-CMS nach dem Claim. */
  tcmsReferences: Array<{ id: string }> = [],
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
          tcmsReferences,
        })
        .mockResolvedValueOnce({ id: DOCUMENT_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ gwgDestroyedAt: new Date('2032-01-01T00:00:00Z') }),
    },
    gwgIdDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
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
  m.gebunden.mockResolvedValue(false);
  m.steuerfrist.mockResolvedValue(null);
});

describe('confirmGwgDeletionAction', () => {
  it('kk-tcms-s11: ein früherer Nachweis des Tax-CMS wird vor Ablauf der steuerlichen Frist nicht vorgemerkt', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    const bis = new Date(Date.now() + 86_400_000);
    m.steuerfrist.mockResolvedValue(bis);

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result).toEqual({ ok: false, error: tcmsNachweisSteuerfristText(bis) });
    expect(m.steuerfrist).toHaveBeenCalledWith(tx, DOCUMENT_ID);
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });

  it('kk-tcms-s11: nach Ablauf der steuerlichen Frist läuft die Vernichtung wie sonst', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ ...tx }),
    );
    m.steuerfrist.mockResolvedValue(new Date('2021-01-01T00:00:00Z'));

    await expect(confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).resolves.toEqual({
      ok: true,
    });
    expect(m.deleteObjectVersion).toHaveBeenCalledOnce();
  });

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

  it('blockiert einen GwG-Beleg ohne eindeutigen Mandantenbezug vor dem Lifecycle-Lock', async () => {
    const tx = makeTx();
    tx.document.findFirst.mockReset().mockResolvedValue({
      id: DOCUMENT_ID,
      title: 'Verwaister Ausweis.pdf',
      clientId: null,
      createdAt: new Date('2010-01-01T00:00:00Z'),
      retentionUntil: new Date('2015-01-01T00:00:00Z'),
      gwgDestructionRequestedAt: null,
      client: null,
      gwgIdDocuments: [],
      gwgOnboardingInvite: null,
      versions: [],
    });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });

  it('persistiert die Vernichtungsabsicht vor dem Byte-Delete und finalisiert danach', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      // Jede withTenantContext-Ausführung ist eine eigene Transaktion und
      // erhält in Prisma auch einen eigenen Tx-Client. Die neue Objektidentität
      // bildet das ab, während die Spies für die Ablaufprüfung geteilt bleiben.
      fn({ ...tx }),
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
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      'gwg-check-lifecycle:tenant-1:client-1',
      'gwg-check-lifecycle:tenant-1:client-1',
    ]);
    expect(tx.document.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.document.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.document.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      m.deleteObjectVersion.mock.invocationCallOrder[0]!,
    );
    expect(m.deleteObjectVersion.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[1]!,
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.document.findFirst.mock.invocationCallOrder[2]!,
    );
    expect(tx.document.findFirst.mock.invocationCallOrder[2]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[1]!,
    );
    expect(tx.document.findUnique).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      select: { gwgDestroyedAt: true },
    });
  });

  it('RT3B-K-02: liest den void-Claim als Text (Prisma 7 kann void nicht deserialisieren)', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });

    const claim = tx.$queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(claim.sql).toMatch(/app\.assert_gwg_document_destruction_due\(\?::uuid\)::text/);
    expect(claim.values).toEqual([DOCUMENT_ID]);
  });

  it('RT3B-K-01: weist ein im Tax-CMS gebundenes Dokument vor Vormerkung, Claim und Bytes ab', async () => {
    const tx = makeTx();
    m.gebunden.mockResolvedValueOnce(true);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({
      ok: false,
      error: TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
    });
    expect(m.gebunden).toHaveBeenCalledWith(tx, DOCUMENT_ID);
    expect(tx.document.findFirst).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });

  it('RT3B-K-01: nennt die Bindung, wenn der DB-Claim sie meldet (23001 + Marker), ohne Bytes', async () => {
    const tx = makeTx();
    tx.$queryRaw.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23001`.', {
        code: 'P2010',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23001',
              originalMessage:
                'document: als Nachweis im Tax-CMS verknüpft, GwG-Vernichtung gesperrt',
              kind: 'postgres',
            },
          },
        },
      }),
    );
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({
      ok: false,
      error: TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
    });
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });

  it('RT3B-K-01: prüft die Bindung vor jedem Object-Store-Löschen und bricht ohne weitere Bytes ab', async () => {
    const tx = makeTx();
    tx.document.findFirst.mockReset();
    tx.document.findFirst
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
        versions: [],
      })
      .mockResolvedValueOnce({
        versions: [
          { id: 'v1', storageBucket: 'gwg', storageKey: 'tenant/doc/v1', storageVersionId: 's1' },
          { id: 'v2', storageBucket: 'gwg', storageKey: 'tenant/doc/v2', storageVersionId: 's2' },
        ],
        tcmsReferences: [],
      });
    // vor der Vormerkung frei, vor der ersten Version frei, vor der zweiten gebunden
    m.gebunden.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({
      ok: false,
      error: TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
    });
    expect(m.gebunden).toHaveBeenCalledTimes(3);
    expect(m.deleteObjectVersion).toHaveBeenCalledTimes(1);
    expect(m.deleteObjectVersion).toHaveBeenCalledWith('gwg', 'tenant/doc/v1', 's1', {
      bypassGovernanceRetention: true,
    });
    // Jede Prüfung liegt vor dem Löschen, das ihr folgt; danach kein Abschluss.
    expect(m.gebunden.mock.invocationCallOrder[1]).toBeLessThan(
      m.deleteObjectVersion.mock.invocationCallOrder[0]!,
    );
    expect(tx.document.updateMany).toHaveBeenLastCalledWith({
      where: { id: DOCUMENT_ID, gwgDestructionRequestedAt: { not: null }, gwgDestroyedAt: null },
      data: {
        gwgDestructionError:
          'TCMS_BINDUNG: Dokument im Tax-CMS verknüpft; Object-Store-Löschung nicht begonnen bzw. abgebrochen.',
      },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
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

  it('RT3D-K-01: übersteuert den Object-Lock einer steuerlichen Unterlage (Verweis des Tax-CMS) nicht', async () => {
    const tx = makeTx('tenant/doc/version-1', 'storage-version-claimed', [{ id: 'verweis-1' }]);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    expect(await confirmGwgDeletionAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });

    // Die Verweise liest die Aktion nach dem Claim mit der Versionsliste.
    expect(tx.document.findFirst.mock.calls[1]![0]).toMatchObject({
      select: { tcmsReferences: { select: { id: true }, take: 1 } },
    });
    expect(m.deleteObjectVersion).toHaveBeenCalledWith(
      'gwg',
      'tenant/doc/version-1',
      'storage-version-claimed',
      { bypassGovernanceRetention: false },
    );
  });

  it('RT3D-K-01: weist der Speicher das Löschen einer steuerlichen Unterlage ab (Lock läuft), bleibt sie vorgemerkt', async () => {
    const tx = makeTx('tenant/doc/version-1', 'storage-version-claimed', [{ id: 'verweis-1' }]);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    m.deleteObjectVersion.mockRejectedValueOnce(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    );

    const result = await confirmGwgDeletionAction({ documentId: DOCUMENT_ID });

    expect(result).toEqual({
      ok: false,
      error:
        'Vernichtung im Object-Store fehlgeschlagen. Der Vorgang bleibt vorgemerkt und kann erneut ausgeführt werden.',
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
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
  it('nimmt den Lifecycle-Lock vor der atomaren DB-Vernichtung', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({ clientId: 'client-1' }),
      },
      notification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $executeRaw: vi.fn().mockResolvedValue(0),
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

    expect(await confirmGwgCheckDeletionAction({ checkId: CHECK_ID })).toEqual({ ok: true });

    expect(tx.gwgCheck.findFirst).toHaveBeenCalledWith({
      where: { id: CHECK_ID, tenantId: 'tenant-1' },
      select: { clientId: true },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe('gwg-check-lifecycle:tenant-1:client-1');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.gwgCheck.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
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
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({ clientId: 'client-1' }),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockRejectedValue(new Error('Frist läuft')),
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgCheckDeletionAction({ checkId: CHECK_ID });

    expect(result.ok).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('ruft bei einem fremden oder fehlenden Check weder Lock noch DB-Funktion auf', async () => {
    const tx = {
      gwgCheck: { findFirst: vi.fn().mockResolvedValue(null) },
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn(),
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmGwgCheckDeletionAction({ checkId: CHECK_ID });

    expect(result.ok).toBe(false);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});
