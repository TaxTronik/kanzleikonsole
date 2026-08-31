import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
vi.mock('@/server/gwg/identity-source', () => ({
  validateIdentityViewportsTx: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/server/gwg/evidence-documents', () => ({
  lockCleanGwgEvidenceDocumentsTx: vi.fn().mockResolvedValue(true),
}));

import {
  OnboardingIdentitySetConflictError,
  persistOnboardingIdentitySetTx,
  type ExistingOnboardingDocument,
} from '../identity-persistence';

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
});
