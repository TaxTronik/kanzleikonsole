import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  revalidateRevision: vi.fn(),
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        gwgOnboardingInvite: {
          findFirst: m.findFirst,
          updateMany: m.updateMany,
          update: m.update,
        },
      }),
    ),
    gwgOnboardingInvite: {
      findFirst: m.findFirst,
      updateMany: m.updateMany,
      update: m.update,
    },
  },
}));
vi.mock('../invite-lifecycle', () => ({
  revalidateOpenGwgInviteRevisionTx: m.revalidateRevision,
}));

import { GENERIC_TOKEN_ERROR, loadInviteByRawToken } from '../service';

const activeInvite = {
  id: 'invite-1',
  inviteName: 'Erika Muster',
  inviteEmail: 'erika@example.test',
  tokenHash: 'unused-in-test',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  status: 'PENDING',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  client: {
    id: 'client-1',
    name: 'Muster GmbH',
    kind: 'JURPERS',
    street: null,
    postalCode: null,
    city: null,
    countryIso: 'DE',
    vatId: null,
  },
  tenant: { id: 'tenant-1', name: 'Kanzlei', slug: 'kanzlei' },
};

describe('GwG-Onboarding-Tokenstatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.revalidateRevision.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ueberschreibt einen parallel geclaimten Invite beim Ablauf-Lookup nicht', async () => {
    const now = new Date('2030-01-02T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    m.findFirst.mockResolvedValueOnce({
      ...activeInvite,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    // Der Datensatz wurde zwischen Read und Write bereits auf SUBMITTED
    // geclaimt. Der statusgebundene CAS trifft deshalb keine Zeile.
    m.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(loadInviteByRawToken('valid-looking-raw-token')).resolves.toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        tokenHash: expect.any(String),
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('belebt eine unter dem Lifecycle-Lock supersedierte Einladung nicht wieder als STARTED', async () => {
    m.findFirst.mockResolvedValueOnce(activeInvite);
    m.revalidateRevision.mockResolvedValueOnce(false);

    await expect(loadInviteByRawToken('valid-looking-raw-token')).resolves.toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('akzeptiert zwei parallele Öffnungen, wenn der andere Request STARTED gesetzt hat', async () => {
    m.findFirst
      .mockResolvedValueOnce(activeInvite)
      .mockResolvedValueOnce({ ...activeInvite, status: 'STARTED' });

    const result = await loadInviteByRawToken('valid-looking-raw-token');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invite.status).toBe('STARTED');
  });

  it('liefert einen gebundenen DRAFT mit stabilen Owner-/Vertreter-IDs und Zuordnungen', async () => {
    const ownerOne = '11111111-1111-4111-8111-111111111111';
    const ownerTwo = '22222222-2222-4222-8222-222222222222';
    const representativeOne = '33333333-3333-4333-8333-333333333333';
    const representativeTwo = '44444444-4444-4444-8444-444444444444';
    const document = (
      id: string,
      subject: { owner?: string; representative?: string },
      notes: string,
      type: 'PERSONALAUSWEIS' | 'REISEPASS' = 'PERSONALAUSWEIS',
    ) => ({
      id,
      type,
      documentId: id,
      documentSetId: `${id.slice(0, -1)}0`,
      ownerName: 'Person',
      number: 'ID-1',
      issuedBy: 'Berlin',
      issueDate: new Date('2025-01-01T00:00:00.000Z'),
      expiryDate: new Date('2035-01-01T00:00:00.000Z'),
      beneficialOwnerSubjectId: subject.owner ?? null,
      representativeSubjectId: subject.representative ?? null,
      notes,
      document: { id, title: `${notes}.pdf` },
    });
    const bound = {
      ...activeInvite,
      status: 'STARTED',
      gwgCheck: {
        id: '55555555-5555-4555-8555-555555555555',
        noRegisterEntry: true,
        beneficialOwners: [
          {
            id: ownerOne,
            fullName: 'Erika Eins',
            birthDate: new Date('1980-01-01T00:00:00.000Z'),
            birthPlace: 'Berlin',
            residence: 'Einsweg 1, 10115 Berlin, DE',
            nationality: 'DE',
            ownershipPct: { toString: () => '60' },
            isPep: false,
            notes: null,
          },
          {
            id: ownerTwo,
            fullName: 'Peter Zwei',
            birthDate: new Date('1982-02-02T00:00:00.000Z'),
            birthPlace: 'Potsdam',
            residence: 'Zweiweg 2, 14467 Potsdam, DE',
            nationality: 'DE',
            ownershipPct: { toString: () => '40' },
            isPep: false,
            notes: null,
          },
        ],
        representatives: [
          {
            id: representativeOne,
            fullName: 'Erika Eins',
            position: 0,
            linkedBeneficialOwnerId: ownerOne,
          },
          {
            id: representativeTwo,
            fullName: 'Rita Vertretung',
            position: 1,
            linkedBeneficialOwnerId: null,
          },
        ],
        idDocuments: [
          document(
            '66666666-6666-4666-8666-666666666661',
            { representative: representativeOne },
            'Vorderseite',
          ),
          document(
            '66666666-6666-4666-8666-666666666662',
            { representative: representativeOne },
            'Rückseite',
          ),
          document(
            '77777777-7777-4777-8777-777777777771',
            { owner: ownerTwo },
            'Rückseite',
            'REISEPASS',
          ),
          document(
            '77777777-7777-4777-8777-777777777772',
            { owner: ownerTwo },
            'Scan',
            'REISEPASS',
          ),
          document(
            '88888888-8888-4888-8888-888888888881',
            { representative: representativeTwo },
            'Vorderseite',
          ),
          document(
            '88888888-8888-4888-8888-888888888882',
            { representative: representativeTwo },
            'Rückseite',
          ),
        ],
      },
    };
    m.findFirst.mockResolvedValueOnce(bound).mockResolvedValueOnce(bound);

    const result = await loadInviteByRawToken('valid-looking-raw-token');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invite.draft?.owners.map((owner) => owner.id)).toEqual([ownerOne, ownerTwo]);
    expect(result.invite.draft?.representatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: representativeOne, linkedOwnerId: ownerOne }),
        expect.objectContaining({ id: representativeTwo, linkedOwnerId: null }),
      ]),
    );
    expect(result.invite.draft?.owners[0]?.idFront?.documentId).toBe(
      '66666666-6666-4666-8666-666666666661',
    );
    expect(result.invite.draft?.owners[1]?.idFront?.documentId).toBe(
      '77777777-7777-4777-8777-777777777772',
    );
    expect(result.invite.draft?.owners[1]?.idBack?.documentId).toBe(
      '77777777-7777-4777-8777-777777777771',
    );
    expect(result.invite.draft?.owners[1]?.idType).toBe('REISEPASS');
  });

  it('mischt Doppelrollen-Sets nicht und lehnt mehr als zwei Seiten fail-closed ab', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const representativeId = '22222222-2222-4222-8222-222222222222';
    const bound = {
      ...activeInvite,
      status: 'STARTED',
      gwgCheck: {
        id: '55555555-5555-4555-8555-555555555555',
        noRegisterEntry: true,
        representatives: [
          {
            id: representativeId,
            fullName: 'Erika Eins',
            position: 0,
            linkedBeneficialOwnerId: ownerId,
          },
        ],
        beneficialOwners: [
          {
            id: ownerId,
            fullName: 'Erika Eins',
            birthDate: new Date('1980-01-01T00:00:00.000Z'),
            birthPlace: 'Berlin',
            residence: 'Einsweg 1, 10115 Berlin, DE',
            nationality: 'DE',
            ownershipPct: { toString: () => '100' },
            isPep: false,
            notes: 'Kanzleivermerk bleibt erhalten',
          },
        ],
        idDocuments: [1, 2].map((side) => ({
          id: `66666666-6666-4666-8666-66666666666${side}`,
          type: 'PERSONALAUSWEIS',
          documentId: `77777777-7777-4777-8777-77777777777${side}`,
          documentSetId: `88888888-8888-4888-8888-88888888888${side}`,
          ownerName: 'Erika Eins',
          number: 'ID-1',
          issuedBy: 'Berlin',
          issueDate: new Date('2025-01-01T00:00:00.000Z'),
          expiryDate: new Date('2035-01-01T00:00:00.000Z'),
          beneficialOwnerSubjectId: side === 1 ? ownerId : null,
          representativeSubjectId: side === 2 ? representativeId : null,
          notes: side === 1 ? 'Vorderseite' : 'Rückseite',
          document: {
            id: `77777777-7777-4777-8777-77777777777${side}`,
            title: `Ausweis-${side}.pdf`,
          },
        })),
      },
    };
    m.findFirst.mockResolvedValueOnce(bound).mockResolvedValueOnce(bound);

    await expect(loadInviteByRawToken('valid-looking-raw-token')).resolves.toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });

    const firstSetId = bound.gwgCheck.idDocuments[0]!.documentSetId;
    bound.gwgCheck.idDocuments[1]!.documentSetId = firstSetId;
    bound.gwgCheck.idDocuments.push({
      ...bound.gwgCheck.idDocuments[0]!,
      id: '99999999-9999-4999-8999-999999999999',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      notes: 'Zusatzseite',
      document: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: 'Ausweis-3.pdf',
      },
    });
    m.findFirst.mockResolvedValueOnce(bound).mockResolvedValueOnce(bound);
    await expect(loadInviteByRawToken('valid-looking-raw-token')).resolves.toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
  });
});
