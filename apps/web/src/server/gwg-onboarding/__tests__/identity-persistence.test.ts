import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { Prisma } from '@taxtronik/db/prisma-client';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
const h = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock('@/server/gwg/identity-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gwg/identity-source')>()),
  validateIdentityViewportsTx: h.validate,
}));
vi.mock('@/server/gwg/evidence-documents', () => ({
  lockCleanGwgEvidenceDocumentsTx: vi.fn().mockResolvedValue(true),
}));

import {
  OnboardingIdentitySetConflictError,
  onboardingIdentityViewSelections,
  persistOnboardingIdentitySetTx,
  type ExistingOnboardingDocument,
} from '../identity-persistence';
import {
  IdentitySourceStorageError,
  NO_IDENTITY_PDF_PAGE_COUNTS,
  type IdentityPdfPageCounts,
} from '@/server/gwg/identity-source';

beforeEach(() => {
  h.validate.mockReset();
  h.validate.mockResolvedValue([]);
});

function txMock(updateCount = 1) {
  const tx = {
    gwgIdDocument: {
      updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
  return tx as unknown as TxClient & typeof tx;
}

const identity = {
  documentIds: ['front', 'back'] as const,
  sourceScope: { tenantId: 'tenant', clientId: 'client' },
  viewports: [
    fullIdentityViewport('00000000-0000-4000-8000-000000000011', 'front'),
    fullIdentityViewport('00000000-0000-4000-8000-000000000012', 'back'),
  ] as const,
  type: 'PERSONALAUSWEIS' as const,
  ownerName: 'Erika Muster',
  number: 'L01X00T47',
  issuedBy: 'Berlin',
  issueDate: new Date('2020-01-01T00:00:00Z'),
  expiryDate: new Date('2030-01-01T00:00:00Z'),
};

describe('persistOnboardingIdentitySetTx', () => {
  it('GWG-SELF-ONBOARDING-001 fails before mutation if a caller bypasses source bindings', async () => {
    const tx = txMock();
    await expect(
      persistOnboardingIdentitySetTx(tx, 'check', new Map(), { ...identity, viewports: undefined }),
    ).rejects.toBeInstanceOf(OnboardingIdentitySetConflictError);
    expect(tx.gwgIdDocument.createMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.updateMany).not.toHaveBeenCalled();
  });
  it('GWG-SELF-ONBOARDING-001 stores one PDF once with two views and never confirms identity', async () => {
    const tx = txMock();
    const version = '00000000-0000-4000-8000-000000000010';
    await persistOnboardingIdentitySetTx(tx, 'check', new Map(), {
      ...identity,
      documentIds: ['pdf', 'pdf'],
      sourceScope: { tenantId: 'tenant', clientId: 'client' },
      viewports: [
        fullIdentityViewport(version, 'front'),
        { ...fullIdentityViewport(version, 'back'), page: 2 },
      ],
    });
    const rows = tx.gwgIdDocument.createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      documentId: 'pdf',
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
      verifiedAt: null,
    });
    expect(rows[0].viewports).toHaveLength(2);
  });
  it('creates both sides with one stable document-set id', async () => {
    const tx = txMock();
    await persistOnboardingIdentitySetTx(tx, 'check', new Map(), identity);

    const rows = tx.gwgIdDocument.createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0].documentSetId).toBe(rows[1].documentSetId);
    expect(rows.map((row: { notes: string }) => row.notes)).toEqual([
      'Vorderseite (durch Mandant hochgeladen)',
      'Rückseite (durch Mandant hochgeladen)',
    ]);
  });

  it('rejects existing sides that belong to different sets', async () => {
    const existing = new Map<string, ExistingOnboardingDocument>([
      ['front', { id: 'a', documentId: 'front', documentSetId: 'set-a', type: 'PERSONALAUSWEIS' }],
      ['back', { id: 'b', documentId: 'back', documentSetId: 'set-b', type: 'PERSONALAUSWEIS' }],
    ]);

    await expect(
      persistOnboardingIdentitySetTx(txMock(), 'check', existing, identity),
    ).rejects.toBeInstanceOf(OnboardingIdentitySetConflictError);
  });

  it('treats a lost update as a concurrent draft change', async () => {
    const existing = new Map<string, ExistingOnboardingDocument>([
      ['front', { id: 'a', documentId: 'front', documentSetId: 'set-a', type: 'PERSONALAUSWEIS' }],
    ]);

    await expect(
      persistOnboardingIdentitySetTx(txMock(0), 'check', existing, identity),
    ).rejects.toBeInstanceOf(OnboardingIdentitySetConflictError);
  });

  it('F-05 surfaces an unreadable source as storage error instead of a data conflict', async () => {
    const storage = new IdentitySourceStorageError(new Error('S3 503 SlowDown'));
    h.validate.mockRejectedValueOnce(storage);
    const tx = txMock();

    await expect(persistOnboardingIdentitySetTx(tx, 'check', new Map(), identity)).rejects.toBe(
      storage,
    );
    expect(tx.gwgIdDocument.createMany).not.toHaveBeenCalled();
  });

  it('F-05 passes database errors on instead of reporting a changed draft', async () => {
    const database = new Prisma.PrismaClientKnownRequestError('connection lost', {
      code: 'P1017',
      clientVersion: 'test',
    });
    h.validate.mockRejectedValueOnce(database);

    await expect(
      persistOnboardingIdentitySetTx(txMock(), 'check', new Map(), identity),
    ).rejects.toBe(database);
  });

  it('keeps reporting an invalid or replaced source view as a conflict, with its cause', async () => {
    const invalid = new Error('Die gewählte PDF-Seite existiert nicht.');
    h.validate.mockRejectedValueOnce(invalid);

    const error = await persistOnboardingIdentitySetTx(
      txMock(),
      'check',
      new Map(),
      identity,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OnboardingIdentitySetConflictError);
    expect((error as Error).cause).toBe(invalid);
  });
});

describe('P-13 Vorabzählung im Onboarding', () => {
  it('GWG-SELF-ONBOARDING-001 wählt genau die Dateien und Ansichten, die die Transaktion prüft', () => {
    const version = '00000000-0000-4000-8000-000000000010';
    const back = { ...fullIdentityViewport(version, 'back'), page: 2 };
    expect(
      onboardingIdentityViewSelections([
        {
          documentIds: ['pdf', 'pdf'],
          viewports: [fullIdentityViewport(version, 'front'), back],
        },
        identity,
      ]),
    ).toEqual([
      { documentId: 'pdf', views: [fullIdentityViewport(version, 'front'), back] },
      { documentId: 'front', views: [identity.viewports[0]] },
      { documentId: 'back', views: [identity.viewports[1]] },
    ]);
  });

  it('reicht die vorab ermittelten Seitenzahlen an die Ausschnittsprüfung weiter', async () => {
    const pageCounts: IdentityPdfPageCounts = new Map([
      [
        '00000000-0000-4000-8000-000000000011',
        {
          versionId: '00000000-0000-4000-8000-000000000011',
          sha256: Buffer.alloc(32),
          outcome: { ok: true, pages: 1 },
        },
      ],
    ]);
    await persistOnboardingIdentitySetTx(txMock(), 'check', new Map(), {
      ...identity,
      pdfPageCounts: pageCounts,
    });
    expect(h.validate).toHaveBeenCalledTimes(2);
    for (const call of h.validate.mock.calls) expect(call[2]).toBe(pageCounts);

    h.validate.mockClear();
    await persistOnboardingIdentitySetTx(txMock(), 'check', new Map(), identity);
    for (const call of h.validate.mock.calls) expect(call[2]).toBe(NO_IDENTITY_PDF_PAGE_COUNTS);
  });
});
