// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Fachkatalog: DOC-OBJECT-LOCK-001
// Review-Finding K-06: Erklaerungs-PDF (GoBD, Object Lock) wird journal-first
// abgelegt; Vorab- und Nachpruefung teilen dieselbe Validierung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withTenantContext: vi.fn(),
    assertClientAccessTx: vi.fn(),
    evidenceRecord: vi.fn(),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    prepareBytesCommitWithTier: storageJournal.prepare,
    commitPreparedBytes: storageJournal.commit,
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: Uint8Array) => value }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof m.ActionError ? error.message : 'Interner Fehler.',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: m.ActionError,
  staffActionGuard: async () => ({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  }),
  withStaffModule: () => vi.fn(),
}));

import { saveTaxFilingAction } from '../actions';
import {
  processCrash,
  storageJournal,
  waitForEvent,
} from '@/server/documents/__tests__/storage-journal-fake';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function input(pdf = true) {
  return {
    filingId: null,
    clientId: CLIENT_ID,
    kind: 'EST' as const,
    period: '2025',
    filingDate: '2026-05-31',
    expectedAssessed: null,
    expectedPrepaid: null,
    expectedRefund: 1200,
    expectedPay: null,
    clientNote: null,
    internalNote: null,
    pdf: pdf
      ? {
          fileName: 'est-2025.pdf',
          mimeType: 'application/pdf',
          base64: Buffer.from('%PDF-1.7 Erklaerung').toString('base64'),
        }
      : null,
  };
}

function tx(existingFiling: { id: string } | null = null) {
  return {
    $executeRaw: storageJournal.executeRaw,
    taxFiling: {
      findUnique: vi.fn().mockResolvedValue(existingFiling),
      create: vi.fn().mockResolvedValue({ id: 'filing-1' }),
      update: vi.fn(),
    },
    document: { create: vi.fn().mockResolvedValue({ id: 'doc-1' }) },
    documentVersion: { create: vi.fn().mockResolvedValue({ id: 'version-1' }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  m.assertClientAccessTx.mockResolvedValue(undefined);
});

describe('saveTaxFilingAction — Erklaerungs-PDF journal-first', () => {
  it('lehnt einen belegten Zeitraum vor Scan, Journal und Object-Lock-Write ab', async () => {
    const existing = tx({ id: 'filing-0' });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (value: unknown) => unknown) =>
      fn(existing),
    );

    await expect(saveTaxFilingAction(input())).resolves.toEqual({
      ok: false,
      error: 'Es gibt bereits eine Erklärung für diesen Zeitraum.',
    });
    expect(storageJournal.events).toEqual([]);
    expect(existing.document.create).not.toHaveBeenCalled();
  });

  it('legt Dokument, Version und Erklaerung an und schliesst die GoBD-Absicht ab', async () => {
    const commitTx = tx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (value: unknown) => unknown) =>
      fn(commitTx),
    );

    await expect(saveTaxFilingAction(input())).resolves.toEqual({ ok: true, id: 'filing-1' });
    expect(commitTx.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storageKey: storageJournal.objects[0]!.key,
        storageVersionId: storageJournal.objects[0]!.versionId,
        immutable: true,
      }),
    });
    expect(commitTx.taxFiling.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: 'doc-1', clientId: CLIENT_ID }),
    });
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({
        source: 'staff.tax_filing.pdf',
        immutable: true,
        resolution: 'REFERENCED',
      }),
    ]);
  });

  it('speichert ohne PDF ohne jedes Speicherjournal', async () => {
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (value: unknown) => unknown) =>
      fn(tx()),
    );

    await expect(saveTaxFilingAction(input(false))).resolves.toEqual({ ok: true, id: 'filing-1' });
    expect(storageJournal.events).toEqual([]);
  });

  // K-06: Prozessabbruch zwischen Object-Write und DB-Commit (Fachbeleg-Familie).
  it('hinterlaesst nach einem Abbruch zwischen PUT und DB-Commit eine aufloesbare Speicherabsicht', async () => {
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (value: unknown) => unknown) => fn(tx()))
      .mockImplementationOnce(() => processCrash());

    void saveTaxFilingAction(input());
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(intent).toMatchObject({
      tenantId: 'tenant-1',
      source: 'staff.tax_filing.pdf',
      immutable: true,
      retentionUntil: storageJournal.objects[0]!.retainUntil,
      storageVersionId: '',
    });
    // Object Lock: der Worker loescht erst nach dem gespeicherten Retention-Ende.
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
  });
});
