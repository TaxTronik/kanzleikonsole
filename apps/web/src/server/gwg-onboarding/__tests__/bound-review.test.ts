import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  gwgInviteClientBaselineHash,
  gwgInviteDraftRevisionHash,
  type GwgInviteDraftRevisionSource,
} from '../invite-draft-revision';
import { canStartUnboundGwgInviteTx, resolveBoundGwgInviteDraftTx } from '../bound-review';

function draft(): GwgInviteDraftRevisionSource {
  return {
    id: 'check-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    client: {
      id: 'client-1',
      tenantId: 'tenant-1',
      kind: 'PERSGES',
      name: 'CAS GbR',
      street: null,
      postalCode: null,
      city: null,
      countryIso: 'DE',
      vatId: null,
    },
    status: 'DRAFT',
    changeScope: 'BOTH',
    predecessorCheckId: 'check-0',
    verifiedAt: null,
    destroyedAt: null,
    riskLevel: null,
    riskScore: null,
    riskAnswers: null,
    riskBreakdown: null,
    notes: null,
    legalForm: 'GbR',
    registerNumber: null,
    registerAuthority: null,
    noRegisterEntry: true,
    representativeNames: ['Rita Rolle'],
    representatives: [
      {
        id: 'rep-1',
        fullName: 'Rita Rolle',
        position: 0,
        linkedBeneficialOwnerId: 'owner-1',
      },
    ],
    ownershipStructureNotes: 'Rita Rolle kontrolliert die Gesellschaft.',
    beneficialOwners: [
      {
        id: 'owner-1',
        fullName: 'Rita Rolle',
        birthDate: new Date('1980-01-01T00:00:00.000Z'),
        birthPlace: 'Berlin',
        residence: 'Berlin',
        nationality: 'DE',
        ownershipPct: 100,
        isPep: false,
        notes: null,
      },
    ],
    idDocuments: [],
    reviewSubmittedAt: null,
    reviewSubmittedBy: null,
  } as unknown as GwgInviteDraftRevisionSource;
}

function txFor(check: ReturnType<typeof draft>, revision: string) {
  return {
    gwgOnboardingInvite: {
      findUnique: vi.fn().mockResolvedValue({
        gwgCheckId: check.id,
        boundCheckRevision: revision,
        boundClientRevision: null,
      }),
    },
    gwgCheck: { findFirst: vi.fn().mockResolvedValue(check) },
  } as unknown as TxClient;
}

describe('gebundener GwG-Änderungsentwurf', () => {
  it('gibt exakt den unveränderten neuesten DRAFT frei', async () => {
    const check = draft();
    const tx = txFor(check, gwgInviteDraftRevisionHash(check));

    await expect(
      resolveBoundGwgInviteDraftTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-1',
        expectedCheckId: check.id,
      }),
    ).resolves.toEqual({ id: check.id });
  });

  it('lehnt nach einem Staff-Edit fail-closed ab, bevor irgendeine Mutation möglich ist', async () => {
    const issued = draft();
    const edited = {
      ...issued,
      beneficialOwners: [{ ...issued.beneficialOwners[0]!, nationality: 'FR' }],
    };
    const tx = txFor(edited, gwgInviteDraftRevisionHash(issued));

    await expect(
      resolveBoundGwgInviteDraftTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-1',
        expectedCheckId: issued.id,
      }),
    ).resolves.toBeNull();
  });

  it('verweigert eine ursprünglich ungebundene Einladung nach zwischenzeitlichem Staff-Check', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'staff-check' });
    const client = draft().client;
    const tx = {
      gwgOnboardingInvite: {
        findUnique: vi.fn().mockResolvedValue({
          gwgCheckId: null,
          boundCheckRevision: null,
          boundClientRevision: gwgInviteClientBaselineHash(client),
        }),
      },
      gwgCheck: { findFirst },
      client: { findFirst: vi.fn().mockResolvedValue(client) },
    } as unknown as TxClient;

    await expect(
      canStartUnboundGwgInviteTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-1',
      }),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalled();
  });

  it('führt Claim, CAS und Rechtsform-Recheck vor jeder Portal-Datenmutation aus', () => {
    const source = readFileSync(
      new URL('../../../app/gwg-onboarding/actions.ts', import.meta.url),
      'utf8',
    );
    const claim = source.indexOf('await claimCurrentGwgInviteSubmitTx(tx,');
    const boundCas = source.indexOf('await resolveBoundGwgInviteDraftTx(tx,');
    const unboundCas = source.indexOf('await canStartUnboundGwgInviteTx(tx,');
    const currentClient = source.indexOf('const currentClient = await tx.client.findFirst(');
    const kindRecheck = source.indexOf('currentClient.kind !== invite.client.kind');
    const firstClientMutation = source.indexOf('await tx.client.update(');
    const firstPersonMutation = source.indexOf('await tx.gwgRepresentative.deleteMany(');

    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(boundCas);
    expect(claim).toBeLessThan(unboundCas);
    expect(boundCas).toBeLessThan(currentClient);
    expect(unboundCas).toBeLessThan(currentClient);
    expect(currentClient).toBeLessThan(kindRecheck);
    expect(kindRecheck).toBeLessThan(firstClientMutation);
    expect(kindRecheck).toBeLessThan(firstPersonMutation);
  });
});
