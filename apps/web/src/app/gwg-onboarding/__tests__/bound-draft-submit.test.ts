import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consentForNewDeclaration } from '@/server/privacy/consent';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';

const m = vi.hoisted(() => ({
  inviteFindFirst: vi.fn(),
  withSystemContext: vi.fn(),
  claimInvite: vi.fn(),
  resolveBound: vi.fn(),
  renderNotice: vi.fn(),
  resolveConsent: vi.fn(),
  evidenceRecord: vi.fn(),
  notifyMany: vi.fn(),
  ensureGwgRootFolder: vi.fn(),
  ensureGwgPersonFolder: vi.fn(),
  lockEvidence: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: vi.fn(),
  commitPreparedBytes: vi.fn(),
  deleteObjectVersion: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: m.withSystemContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/documents/upload-helpers', () => ({
  createPendingDocumentWithVersion: vi.fn(),
  finalizePendingDocumentVersion: vi.fn(),
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Interner Fehler.',
  }),
}));
vi.mock('@/server/gwg-onboarding/service', () => ({
  expireOpenInviteIfDue: vi.fn(),
  GENERIC_TOKEN_ERROR: 'Einladung ungültig oder nicht mehr verfügbar.',
  hashInviteToken: () => 'token-hash',
  prismaOwner: { gwgOnboardingInvite: { findFirst: m.inviteFindFirst } },
}));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ ok: true })),
  checkIpOrGlobalLimit: vi.fn(async () => ({ ok: true })),
  getClientIp: () => '192.0.2.1',
}));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/notifications/service', () => ({ notifyMany: m.notifyMany }));
vi.mock('@/server/privacy/consent-catalog', () => ({
  ConsentDisplayChangedError: class ConsentDisplayChangedError extends Error {},
  RequiredConsentOptionsError: class RequiredConsentOptionsError extends Error {},
  resolveConsentSelectionsTx: m.resolveConsent,
}));
vi.mock('@/server/privacy/catalog-lock', () => ({ lockConsentCatalogTx: vi.fn() }));
vi.mock('@/server/privacy/consent-display', () => ({
  CONSENT_DISPLAY_CHANGED_MESSAGE: 'Anzeige geändert.',
}));
vi.mock('@/server/privacy/service', () => ({ renderNoticeForTenantTx: m.renderNotice }));
vi.mock('@/server/gwg/reverification', () => ({ startFreshGwgReviewTx: vi.fn() }));
vi.mock('@/server/gwg/evidence-documents', () => ({
  lockCleanGwgEvidenceDocumentsTx: m.lockEvidence,
}));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({
  claimCurrentGwgInviteSubmitTx: m.claimInvite,
  revalidateOpenGwgInviteRevisionTx: vi.fn(),
}));
vi.mock('@/server/gwg-onboarding/bound-review', () => ({
  canStartUnboundGwgInviteTx: vi.fn(),
  resolveBoundGwgInviteDraftTx: m.resolveBound,
}));
vi.mock('@/server/gwg-onboarding/document-folders', () => ({
  ensureGwgRootFolderTx: m.ensureGwgRootFolder,
  ensureGwgPersonFolderTx: m.ensureGwgPersonFolder,
}));

import { submitOnboardingAction } from '../actions';

const CHECK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ONE = '11111111-1111-4111-8111-111111111111';
const OWNER_TWO = '22222222-2222-4222-8222-222222222222';
const REP_ONE = '33333333-3333-4333-8333-333333333333';
const REP_TWO = '44444444-4444-4444-8444-444444444444';
const DOCUMENT_IDS = [
  '51111111-1111-4111-8111-111111111111',
  '52222222-2222-4222-8222-222222222222',
  '53333333-3333-4333-8333-333333333333',
  '54444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '56666666-6666-4666-8666-666666666666',
  '57777777-7777-4777-8777-777777777777',
] as const;
const versionFor = (documentId: string) => documentId.replace(/^5/, '9');

function owner(
  localId: string,
  name: string,
  front: string,
  back: string,
  idType: 'PERSONALAUSWEIS' | 'REISEPASS' = 'PERSONALAUSWEIS',
) {
  return {
    localId,
    fullName: name,
    birthDate: '1980-01-01',
    birthPlace: 'Berlin',
    nationality: 'DE',
    street: 'Musterweg 1',
    postalCode: '10115',
    city: 'Berlin',
    countryIso: 'DE',
    sharePercent: '50',
    isPep: false,
    idType,
    idNumber: 'ID-1',
    idIssuedBy: 'Berlin',
    idIssueDate: '2025-01-01',
    idExpiryDate: '2035-01-01',
    idFrontDocumentId: front,
    idBackDocumentId: back,
    idFrontViewport: fullIdentityViewport(versionFor(front), 'front'),
    idBackViewport: fullIdentityViewport(versionFor(back), 'back'),
  };
}

describe('gebundener GwG-DRAFT Submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.claimInvite.mockResolvedValue({
      ok: true,
      submittedAt: new Date(),
      supersededInviteCount: 0,
    });
    m.resolveBound.mockResolvedValue({ id: CHECK_ID });
    m.renderNotice.mockResolvedValue({ complete: true, version: 1, body: 'Hinweis' });
    m.resolveConsent.mockImplementation(async (_tx, _tenant, value) => value);
    m.evidenceRecord.mockResolvedValue({});
    m.notifyMany.mockResolvedValue(undefined);
    m.ensureGwgRootFolder.mockResolvedValue('gwg-root');
    m.ensureGwgPersonFolder.mockResolvedValue('gwg-person');
    m.lockEvidence.mockResolvedValue(true);
  });

  it('erhält bei unverändertem Submit zwei Owner-/Vertreter-IDs und Dokument-FKs', async () => {
    const existingDocuments = DOCUMENT_IDS.map((documentId, index) => ({
      id: `6${String(index + 1).repeat(7)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
      documentId,
      documentSetId:
        index < 2
          ? '70000000-0000-4000-8000-000000000001'
          : index < 4
            ? '70000000-0000-4000-8000-000000000002'
            : index < 6
              ? '70000000-0000-4000-8000-000000000003'
              : '70000000-0000-4000-8000-000000000004',
      type:
        index === 6
          ? 'GESELLSCHAFTSVERTRAG'
          : index === 2 || index === 3
            ? 'REISEPASS'
            : 'PERSONALAUSWEIS',
    }));
    const tx = {
      $executeRaw: vi.fn(),
      client: {
        findFirst: vi.fn().mockResolvedValue({
          kind: 'PERSGES',
          name: 'Muster GbR',
          street: 'Musterweg 1',
          postalCode: '10115',
          city: 'Berlin',
          countryIso: 'DE',
          vatId: null,
        }),
        update: vi.fn(),
      },
      gwgCheck: { update: vi.fn().mockResolvedValue({}) },
      clientConsent: { create: vi.fn().mockResolvedValue({ id: 'consent-1' }) },
      gwgBeneficialOwner: {
        findMany: vi.fn().mockResolvedValue([
          { id: OWNER_ONE, notes: 'Kanzleivermerk Owner 1' },
          { id: OWNER_TWO, notes: 'Kanzleivermerk Owner 2' },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      gwgRepresentative: {
        findMany: vi.fn().mockResolvedValue([{ id: REP_ONE }, { id: REP_TWO }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      gwgIdDocument: {
        findMany: vi.fn().mockResolvedValue(existingDocuments),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
      },
      gwgOnboardingInvite: { update: vi.fn() },
      document: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockImplementation(async ({ where }) => ({
          id: where.id,
          title: 'Ausweis',
          mimeType: 'image/png',
          versions: [
            {
              id: versionFor(where.id),
              scanStatus: 'CLEAN',
              scanCompletedAt: new Date(),
              storageVersionId: 'storage-version',
              storageBucket: 'test',
              storageKey: where.id,
              sha256: Buffer.alloc(32),
              sizeBytes: 42n,
            },
          ],
        })),
      },
      clientResponsibility: { findMany: vi.fn().mockResolvedValue([]) },
    };
    m.withSystemContext.mockImplementation(async (_tenantId, callback) => callback(tx));
    m.inviteFindFirst.mockResolvedValue({
      id: 'invite-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      status: 'STARTED',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      gwgCheckId: CHECK_ID,
      createdByStaff: 'staff-1',
      uploadedDocumentIds: [],
      gwgCheck: { idDocuments: DOCUMENT_IDS.map((documentId) => ({ documentId })) },
      client: {
        id: 'client-1',
        kind: 'PERSGES',
        name: 'Muster GbR',
        street: 'Musterweg 1',
        postalCode: '10115',
        city: 'Berlin',
        countryIso: 'DE',
        vatId: null,
      },
    });

    const result = await submitOnboardingAction({
      token: 'valid-looking-token',
      master: {
        companyName: 'Muster GbR',
        street: 'Musterweg 1',
        postalCode: '10115',
        city: 'Berlin',
        countryIso: 'DE',
      },
      legalEntity: { noRegisterEntry: true },
      owners: [
        owner(OWNER_ONE, 'Erika Eins', DOCUMENT_IDS[0], DOCUMENT_IDS[1]),
        owner(OWNER_TWO, 'Peter Zwei', DOCUMENT_IDS[2], DOCUMENT_IDS[3], 'REISEPASS'),
      ],
      representatives: [
        {
          localId: REP_ONE,
          fullName: 'Erika Eins',
          linkedOwnerLocalId: OWNER_ONE,
          idType: 'PERSONALAUSWEIS',
          idNumber: '',
          idIssuedBy: '',
          idIssueDate: '',
          idExpiryDate: '',
          idFrontDocumentId: null,
          idBackDocumentId: null,
        },
        {
          localId: REP_TWO,
          fullName: 'Rita Vertretung',
          linkedOwnerLocalId: null,
          idType: 'PERSONALAUSWEIS',
          idNumber: 'ID-2',
          idIssuedBy: 'Berlin',
          idIssueDate: '2025-01-01',
          idExpiryDate: '2035-01-01',
          idFrontDocumentId: DOCUMENT_IDS[4],
          idBackDocumentId: DOCUMENT_IDS[5],
          idFrontViewport: fullIdentityViewport(versionFor(DOCUMENT_IDS[4]), 'front'),
          idBackViewport: fullIdentityViewport(versionFor(DOCUMENT_IDS[5]), 'back'),
        },
      ],
      extraDocuments: [{ documentId: DOCUMENT_IDS[6], type: 'GESELLSCHAFTSVERTRAG' }],
      consent: {
        noticeAcknowledged: true,
        signedByName: 'Erika Eins',
        selections: consentForNewDeclaration(),
        displayRevision: 'a'.repeat(64),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(m.lockEvidence).toHaveBeenCalledTimes(6);
    expect(tx.document.findFirst).toHaveBeenCalledTimes(6);
    for (const call of tx.gwgIdDocument.updateMany.mock.calls) {
      if (call[0]?.data?.type === 'PERSONALAUSWEIS' || call[0]?.data?.type === 'REISEPASS') {
        expect(call[0]?.data?.viewports).toHaveLength(1);
        expect(call[0]?.data?.verifiedAt).toBeNull();
      }
    }
    expect(tx.gwgBeneficialOwner.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ id: OWNER_ONE }),
        expect.objectContaining({
          id: OWNER_TWO,
          notes: 'Kanzleivermerk Owner 2',
        }),
      ]),
    });
    expect(tx.gwgRepresentative.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ id: REP_ONE, linkedBeneficialOwnerId: OWNER_ONE }),
        expect.objectContaining({ id: REP_TWO, linkedBeneficialOwnerId: null }),
      ]),
    });
    expect(tx.gwgIdDocument.createMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.create).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.deleteMany).not.toHaveBeenCalled();
    expect(m.ensureGwgRootFolder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-1', clientId: 'client-1' }),
    );
    expect(m.ensureGwgPersonFolder).toHaveBeenCalledTimes(3);
    expect(tx.document.updateMany).toHaveBeenCalledTimes(DOCUMENT_IDS.length);
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ representativeSubjectId: REP_ONE }),
      }),
    );
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ documentId: DOCUMENT_IDS[2] }),
        data: expect.objectContaining({ type: 'REISEPASS' }),
      }),
    );
    for (const [, call] of tx.gwgIdDocument.updateMany.mock.calls.entries()) {
      expect(call[0]?.data).not.toHaveProperty('notes');
    }
  });
});
