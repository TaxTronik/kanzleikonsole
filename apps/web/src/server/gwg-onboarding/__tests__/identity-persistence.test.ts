import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';

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
  type: 'PERSONALAUSWEIS' as const,
  ownerName: 'Erika Muster',
  number: 'L01X00T47',
  issuedBy: 'Berlin',
  issueDate: new Date('2020-01-01T00:00:00Z'),
  expiryDate: new Date('2030-01-01T00:00:00Z'),
};

describe('persistOnboardingIdentitySetTx', () => {
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
