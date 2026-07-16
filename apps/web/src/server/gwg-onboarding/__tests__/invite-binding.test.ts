import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { prepareGwgInviteBindingTx } from '../invite-binding';

function txWith(check: Record<string, unknown> | null) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(0),
    gwgCheck: { findFirst: vi.fn().mockResolvedValue(check) },
    client: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'client-1',
        tenantId: 'tenant-1',
        kind: 'PERSGES',
        name: 'Binding GbR',
        street: null,
        postalCode: null,
        city: null,
        countryIso: 'DE',
        vatId: null,
      }),
    },
  } as unknown as TxClient;
}

function draft() {
  return {
    id: 'check-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    client: { id: 'client-1', tenantId: 'tenant-1', kind: 'PERSGES', name: 'Binding GbR' },
    status: 'DRAFT',
    changeScope: 'INITIAL',
    predecessorCheckId: null,
    verifiedAt: null,
    destroyedAt: null,
    riskLevel: null,
    riskScore: null,
    riskAnswers: null,
    riskBreakdown: null,
    notes: null,
    legalForm: null,
    registerNumber: null,
    registerAuthority: null,
    noRegisterEntry: false,
    representativeNames: [],
    representatives: [],
    ownershipStructureNotes: null,
    beneficialOwners: [],
    idDocuments: [],
    reviewSubmittedAt: null,
    reviewSubmittedBy: null,
  };
}

describe('GwG-Invite-Binding', () => {
  it('erlaubt ungebunden nur die echte Ersteinladung', async () => {
    await expect(
      prepareGwgInviteBindingTx(txWith(null), {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        bindLatestDraft: false,
      }),
    ).resolves.toEqual({
      ok: true,
      gwgCheckId: null,
      boundCheckRevision: null,
      boundClientRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(
      prepareGwgInviteBindingTx(txWith(draft()), {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        bindLatestDraft: false,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('bindet im Onboarding-Wizard den neuesten DRAFT samt Revision', async () => {
    const result = await prepareGwgInviteBindingTx(txWith(draft()), {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      bindLatestDraft: true,
    });
    expect(result).toMatchObject({ ok: true, gwgCheckId: 'check-1' });
    if (!result.ok) return;
    expect(result.boundCheckRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.boundClientRevision).toBeNull();
  });

  it('fordert fuer IN_REVIEW und terminale Checks einen neuen Zyklus', async () => {
    for (const status of ['IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']) {
      await expect(
        prepareGwgInviteBindingTx(txWith({ ...draft(), status }), {
          tenantId: 'tenant-1',
          clientId: 'client-1',
          bindLatestDraft: true,
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Prüfzyklus') });
    }
  });
});
