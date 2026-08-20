import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withStaff: vi.fn(),
  withTenantContext: vi.fn(),
  isStaffAdmin: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
  notifyClientContacts: vi.fn(),
  notifyMany: vi.fn(),
  fireAndForget: vi.fn(),
  emitN8nEvent: vi.fn(),
  cancelOpenGwgInvites: vi.fn(),
  findCleanGwgDocuments: vi.fn(),
  lockCleanGwgDocuments: vi.fn(),
  organizeGwgDocuments: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: m.isStaffAdmin,
  assertClientAccessTx: vi.fn(),
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler',
  }),
}));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: vi.fn() }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({
  cancelOpenGwgInvitesTx: m.cancelOpenGwgInvites,
}));
vi.mock('@/server/mail/dispatch', () => ({ notifyClientContacts: m.notifyClientContacts }));
vi.mock('@/server/notifications/service', () => ({ notifyMany: m.notifyMany }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: m.fireAndForget }));
vi.mock('@/server/gwg/evidence-documents', () => ({
  findCleanGwgEvidenceDocumentsTx: m.findCleanGwgDocuments,
  lockCleanGwgEvidenceDocumentsTx: m.lockCleanGwgDocuments,
}));
vi.mock('@/server/gwg-onboarding/document-folders', () => ({
  organizeGwgDocumentsTx: m.organizeGwgDocuments,
}));
vi.mock('@/server/actions/staff-action', async () => {
  const { parseFormData } = await import('@/server/actions/form-data');
  return {
    ActionError: class ActionError extends Error {},
    staffActionGuard: m.staffActionGuard,
    withStaff: m.withStaff,
    parseFormData,
  };
});

import {
  addBeneficialOwnerAction,
  removeBeneficialOwnerAction,
  updateBeneficialOwnerAction,
} from '../owner-actions';
import {
  addIdDocumentAction,
  extendIdentityDocumentSetAction,
  searchUnlinkedGwgDocumentsAction,
  updateIdDocumentsAction,
} from '../id-document-actions';
import {
  openCheckAction,
  saveLegalEntityDetailsAction,
  saveRiskAnswersAction,
  rejectCheckAction,
  startNewCheckCycleAction,
  submitCheckForReviewAction,
  verifyCheckAction,
} from '../actions';
import {
  gwgBeneficialOwnerRevision,
  gwgIdentityDocumentSetRevision,
  gwgLegalEntityRevision,
  gwgRiskRevision,
} from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';

const CHECK_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const NEWER_CHECK_ID = '44444444-4444-4444-8444-444444444444';
const DATABASE_NOW = new Date('2026-07-15T15:30:00.000Z');

function validDocument(type: string, ownerName = 'Erika Muster') {
  const personal = type === 'PERSONALAUSWEIS' || type === 'REISEPASS';
  return {
    id: `id-${type}`,
    gwgCheckId: CHECK_ID,
    documentSetId: `set-${type}`,
    type,
    ownerName,
    number: type === 'PERSONALAUSWEIS' ? 'L01X00T47' : null,
    issuedBy: type === 'PERSONALAUSWEIS' ? 'Stadt Berlin' : null,
    issueDate: new Date('2025-01-01T00:00:00Z'),
    expiryDate: type === 'PERSONALAUSWEIS' ? new Date('2099-01-01T00:00:00Z') : null,
    verifiedAt: personal ? new Date('2026-07-15T00:00:00Z') : null,
    naturalClientSubjectId: null,
    beneficialOwnerSubjectId: null,
    representativeSubjectId: personal ? '33333333-3333-4333-8333-333333333333' : null,
    identityAssignmentConfirmedAt: personal ? new Date('2026-07-15T00:00:00Z') : null,
    identityAssignmentConfirmedBy: personal ? 'staff-1' : null,
    documentId: `doc-${type}`,
    notes: type === 'PERSONALAUSWEIS' ? 'Original eingesehen' : null,
    document: {
      id: `doc-${type}`,
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      gwgDestructionRequestedAt: null,
      gwgDestroyedAt: null,
      versions: [{ scanStatus: 'CLEAN', scanCompletedAt: DATABASE_NOW }],
    },
  };
}

function completeCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECK_ID,
    clientId: CLIENT_ID,
    status: 'IN_REVIEW',
    reviewSubmittedAt: new Date('2026-07-15T09:00:00.000Z'),
    reviewSubmittedBy: 'staff-1',
    createdAt: new Date('2026-07-14T12:00:00.000Z'),
    destroyedAt: null,
    notes: 'Identifizierung vollständig.',
    riskScore: 2,
    riskLevel: 'LOW',
    riskAnswers: {
      jurisdiction: 0,
      industry: 0,
      pep: 0,
      cash_intensity: 0,
      transparency: 0,
      transaction_complexity: 0,
    },
    client: { id: CLIENT_ID, name: 'Muster GmbH', kind: 'JURPERS' },
    beneficialOwners: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        fullName: 'Erika Muster',
        birthDate: new Date('1980-01-02T00:00:00Z'),
        birthPlace: 'Berlin',
        residence: 'Musterstraße 1, 10115 Berlin',
        nationality: 'deutsch',
        ownershipPct: 100,
        isPep: false,
        notes: 'Alleinige Gesellschafterin',
      },
    ],
    legalForm: 'GmbH',
    registerNumber: 'HRB 12345',
    registerAuthority: 'AG Charlottenburg',
    noRegisterEntry: false,
    representativeNames: ['Erika Muster'],
    representatives: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        gwgCheckId: CHECK_ID,
        fullName: 'Erika Muster',
        position: 0,
      },
    ],
    ownershipStructureNotes: 'Erika Muster hält sämtliche Anteile.',
    idDocuments: [
      validDocument('PERSONALAUSWEIS'),
      validDocument('HANDELSREGISTERAUSZUG'),
      validDocument('TRANSPARENZREGISTER_AUSZUG'),
    ],
    ...overrides,
  };
}

function formData() {
  const data = new FormData();
  data.set('checkId', CHECK_ID);
  data.set('clientId', CLIENT_ID);
  return data;
}

function verificationFormData(check = completeCheck()) {
  const data = formData();
  data.set('professionalAttestation', 'confirmed');
  data.set('reviewSnapshotHash', gwgProfessionalReviewSnapshotHash(check));
  return data;
}

function makeTx(check: ReturnType<typeof completeCheck>) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ statementTimestamp: DATABASE_NOW }]),
    clientResponsibility: {
      findFirst: vi.fn().mockResolvedValue({ id: 'resp-1' }),
      findMany: vi.fn().mockResolvedValue([{ staffId: 'staff-1' }]),
    },
    gwgCheck: {
      findFirst: vi.fn().mockResolvedValue(check),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    client: {
      findUnique: vi.fn().mockResolvedValue({ kind: 'JURPERS' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    clientContact: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gwgOnboardingInvite: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    notification: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeStartCycleTx(
  latest: ReturnType<typeof completeCheck> | null,
  counts: { invalidated?: number; deactivated?: number } = {},
) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ statementTimestamp: DATABASE_NOW }]),
    gwgCheck: {
      findFirst: vi.fn().mockResolvedValue(latest),
      create: vi.fn().mockResolvedValue({ id: NEWER_CHECK_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: counts.invalidated ?? 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    gwgBeneficialOwner: {
      createMany: vi.fn().mockResolvedValue({ count: latest?.beneficialOwners.length ?? 0 }),
    },
    gwgRepresentative: {
      createMany: vi.fn().mockResolvedValue({ count: latest?.representatives.length ?? 0 }),
    },
    gwgIdDocument: {
      createMany: vi.fn().mockResolvedValue({ count: latest?.idDocuments.length ?? 0 }),
    },
    client: {
      updateMany: vi.fn().mockResolvedValue({ count: counts.deactivated ?? 0 }),
    },
  };
}

function runWithStaffOn(tx: unknown) {
  const mutableTx = tx as {
    $executeRaw?: ReturnType<typeof vi.fn>;
    gwgOnboardingInvite?: { findMany: ReturnType<typeof vi.fn> };
    notification?: { updateMany: ReturnType<typeof vi.fn> };
  };
  mutableTx.$executeRaw ??= vi.fn().mockResolvedValue(0);
  mutableTx.gwgOnboardingInvite ??= {
    findMany: vi.fn().mockResolvedValue([]),
  };
  mutableTx.notification ??= {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  m.withStaff.mockImplementation(async (fn: (tx: unknown, ctx: unknown) => Promise<unknown>) => {
    try {
      const payload = await fn(tx, {
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        session: {},
      });
      return { ok: true, ...((payload as Record<string, unknown> | undefined) ?? {}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Fehler' };
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: {},
  });
  m.isStaffAdmin.mockReturnValue(true);
  m.evidenceRecord.mockResolvedValue({});
  m.notifyClientContacts.mockResolvedValue(undefined);
  m.notifyMany.mockResolvedValue(undefined);
  m.findCleanGwgDocuments.mockResolvedValue([]);
  m.lockCleanGwgDocuments.mockResolvedValue(true);
  m.organizeGwgDocuments.mockResolvedValue(undefined);
});

describe('atomare GwG-Bearbeitung', () => {
  it('verwirft eine verspätete Risikospeicherung nach parallelem Statuswechsel', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          riskScore: 2,
          riskLevel: 'LOW',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn(),
      },
    };
    runWithStaffOn(tx);

    const result = await saveRiskAnswersAction({
      checkId: CHECK_ID,
      clientId: CLIENT_ID,
      answers: {
        jurisdiction: 0,
        industry: 0,
        pep: 0,
        cash_intensity: 0,
        transparency: 0,
        transaction_complexity: 0,
      },
      expectedRevision: gwgRiskRevision({
        riskAnswers: {},
        riskScore: 2,
        riskLevel: 'LOW',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('parallel geändert');
    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
  });

  it('verwirft auch ein verspätetes Speichern unveränderter Rechtsträgerdaten', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'IN_REVIEW',
            legalForm: 'GbR',
            registerNumber: null,
            registerAuthority: null,
            noRegisterEntry: true,
            representativeNames: ['Erika Muster'],
            representatives: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                fullName: 'Erika Muster',
                position: 0,
              },
            ],
            beneficialOwners: [],
            ownershipStructureNotes: 'Erika Muster kontrolliert die Gesellschaft.',
            client: { kind: 'PERSGES' },
          })
          .mockResolvedValueOnce(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn(),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('legalForm', 'GbR');
    data.set('noRegisterEntry', 'on');
    data.set('representativeNamesText', 'Erika Muster');
    data.set('ownershipStructureNotes', 'Erika Muster kontrolliert die Gesellschaft.');
    data.set(
      'expectedRevision',
      gwgLegalEntityRevision({
        legalForm: 'GbR',
        registerNumber: null,
        registerAuthority: null,
        noRegisterEntry: true,
        representativeNames: ['Erika Muster'],
        representatives: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            fullName: 'Erika Muster',
            position: 0,
          },
        ],
        ownershipStructureNotes: 'Erika Muster kontrolliert die Gesellschaft.',
      }),
    );

    const result = await saveLegalEntityDetailsAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('parallel geändert');
    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
  });

  it('verlangt beim manuellen Erfassen eine ausdrückliche PEP-Angabe', async () => {
    const data = formData();
    data.set('fullName', 'Erika Muster');
    data.set('birthDate', '1980-01-02');
    data.set('birthPlace', 'Berlin');
    data.set('residence', 'Musterstraße 1, 10115 Berlin');
    data.set('nationality', 'deutsch');

    const result = await addBeneficialOwnerAction(null, data);

    expect(result).toEqual({ ok: false, error: 'Validierungsfehler.' });
    expect(m.withStaff).not.toHaveBeenCalled();
  });

  it('übernimmt den ausdrücklich gewählten PEP-Status beim manuellen Erfassen', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({ status: 'DRAFT' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgBeneficialOwner: {
        create: vi.fn().mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('fullName', 'Erika Muster');
    data.set('birthDate', '1980-01-02');
    data.set('birthPlace', 'Berlin');
    data.set('residence', 'Musterstraße 1, 10115 Berlin');
    data.set('nationality', 'deutsch');
    data.set('isPep', 'true');

    const result = await addBeneficialOwnerAction(null, data);

    expect(result).toEqual({ ok: true });
    expect(tx.gwgBeneficialOwner.create).toHaveBeenCalledWith({
      data: {
        gwgCheckId: CHECK_ID,
        fullName: 'Erika Muster',
        birthDate: new Date('1980-01-02T00:00:00.000Z'),
        birthPlace: 'Berlin',
        residence: 'Musterstraße 1, 10115 Berlin',
        nationality: 'deutsch',
        ownershipPct: null,
        isPep: true,
      },
    });
  });

  it('korrigiert alle Personenangaben atomar, auditierbar und nimmt die Übergabe zurück', async () => {
    const ownerDocument = {
      ...validDocument('PERSONALAUSWEIS'),
      beneficialOwnerSubjectId: '33333333-3333-4333-8333-333333333333',
      representativeSubjectId: null,
      verifiedAt: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    };
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          beneficialOwners: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              fullName: 'Erika Alt',
              birthDate: new Date('1980-01-02T00:00:00.000Z'),
              birthPlace: 'Bonn',
              residence: 'Bonn',
              nationality: 'deutsch',
              ownershipPct: '40.00',
              isPep: false,
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgBeneficialOwner: {
        update: vi.fn().mockResolvedValue({}),
      },
      gwgIdDocument: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: ownerDocument.id, documentSetId: ownerDocument.documentSetId },
          ])
          .mockResolvedValueOnce([ownerDocument]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('ownerId', '33333333-3333-4333-8333-333333333333');
    data.set('fullName', 'Erika Muster');
    data.set('birthDate', '1981-03-04');
    data.set('birthPlace', 'Berlin');
    data.set('residence', 'Hamburg');
    data.set('nationality', 'deutsch');
    data.set('ownershipPct', '51.25');
    data.set('isPep', 'true');
    data.set(
      'expectedRevision',
      gwgBeneficialOwnerRevision({
        id: '33333333-3333-4333-8333-333333333333',
        fullName: 'Erika Alt',
        birthDate: new Date('1980-01-02T00:00:00.000Z'),
        birthPlace: 'Bonn',
        residence: 'Bonn',
        nationality: 'deutsch',
        ownershipPct: '40.00',
        isPep: false,
      }),
    );

    const result = await updateBeneficialOwnerAction(null, data);

    expect(result).toEqual({
      ok: true,
      reviewReset: true,
      invalidatedIdentitySets: [
        { documentSetId: ownerDocument.documentSetId, revision: expect.any(String) },
      ],
      revision: expect.any(String),
      saved: {
        id: '33333333-3333-4333-8333-333333333333',
        fullName: 'Erika Muster',
        birthDate: '1981-03-04',
        birthPlace: 'Berlin',
        residence: 'Hamburg',
        nationality: 'deutsch',
        ownershipPct: '51.25',
        isPep: true,
      },
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'IN_REVIEW' },
      data: {
        status: 'DRAFT',
        reviewSubmittedAt: null,
        reviewSubmittedBy: null,
        riskLevel: null,
        riskScore: null,
        riskAnswers: expect.any(Object),
        riskBreakdown: expect.any(Object),
      },
    });
    expect(tx.gwgBeneficialOwner.update).toHaveBeenCalledWith({
      where: { id: '33333333-3333-4333-8333-333333333333' },
      data: {
        fullName: 'Erika Muster',
        birthDate: new Date('1981-03-04T00:00:00.000Z'),
        birthPlace: 'Berlin',
        residence: 'Hamburg',
        nationality: 'deutsch',
        ownershipPct: 51.25,
        isPep: true,
      },
    });
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith({
      where: {
        gwgCheckId: CHECK_ID,
        id: { in: [ownerDocument.id] },
      },
      data: {
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      },
    });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.owner.update',
        resourceId: '33333333-3333-4333-8333-333333333333',
        before: expect.objectContaining({ fullName: 'Erika Alt', isPep: false }),
        after: expect.objectContaining({
          fullName: 'Erika Muster',
          isPep: true,
          invalidatedIdentityDocuments: 2,
        }),
      }),
    );
  });

  it('verwirft eine Personenkorrektur bei paralleler Freigabe vollständig', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          beneficialOwners: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              fullName: 'Erika Muster',
              birthDate: null,
              birthPlace: null,
              residence: null,
              nationality: null,
              ownershipPct: null,
              isPep: false,
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gwgBeneficialOwner: {
        update: vi.fn(),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('ownerId', '33333333-3333-4333-8333-333333333333');
    data.set('fullName', 'Erika Neu');
    data.set('birthDate', '1980-01-02');
    data.set('birthPlace', 'Berlin');
    data.set('residence', 'Musterstraße 1, 10115 Berlin');
    data.set('nationality', 'deutsch');
    data.set('isPep', 'false');
    data.set(
      'expectedRevision',
      gwgBeneficialOwnerRevision({
        id: '33333333-3333-4333-8333-333333333333',
        fullName: 'Erika Muster',
        birthDate: null,
        birthPlace: null,
        residence: null,
        nationality: null,
        ownershipPct: null,
        isPep: false,
      }),
    );

    const result = await updateBeneficialOwnerAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('parallel geändert');
    expect(tx.gwgBeneficialOwner.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('entfernt ausgeschiedene Berechtigte nur aus dem neuen Snapshot und entbestätigt deren Ausweis', async () => {
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const owner = {
      id: ownerId,
      fullName: 'Erika Muster',
      birthDate: new Date('1980-01-02T00:00:00.000Z'),
      birthPlace: 'Berlin',
      residence: 'Berlin',
      nationality: 'deutsch',
      ownershipPct: '50.00',
      isPep: false,
    };
    const document = {
      ...validDocument('PERSONALAUSWEIS'),
      beneficialOwnerSubjectId: null,
      representativeSubjectId: null,
      verifiedAt: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    };
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          representatives: [],
          beneficialOwners: [owner],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgBeneficialOwner: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      gwgRepresentative: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      gwgIdDocument: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: document.id,
              documentSetId: document.documentSetId,
              beneficialOwnerSubjectId: ownerId,
            },
          ])
          .mockResolvedValueOnce([document]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('ownerId', ownerId);
    data.set('expectedRevision', gwgBeneficialOwnerRevision(owner));

    const result = await removeBeneficialOwnerAction(null, data);

    expect(result).toEqual({
      ok: true,
      removedOwnerId: ownerId,
      reviewReset: true,
      invalidatedIdentitySets: [
        { documentSetId: document.documentSetId, revision: expect.any(String) },
      ],
    });
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith({
      where: { gwgCheckId: CHECK_ID, id: { in: [document.id] } },
      data: {
        beneficialOwnerSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      },
    });
    expect(tx.gwgBeneficialOwner.deleteMany).toHaveBeenCalledWith({
      where: { id: ownerId, gwgCheckId: CHECK_ID },
    });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.owner.remove',
        before: expect.objectContaining({ fullName: 'Erika Muster' }),
        after: expect.objectContaining({ removedFromCurrentSnapshot: true }),
      }),
    );
  });

  it('invalidiert beim Entfernen eines Owners auch Ausweise seiner verknüpften Vertreterrolle', async () => {
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const representativeId = '44444444-4444-4444-8444-444444444444';
    const owner = {
      id: ownerId,
      fullName: 'Erika Muster',
      birthDate: new Date('1980-01-02T00:00:00.000Z'),
      birthPlace: 'Berlin',
      residence: 'Berlin',
      nationality: 'deutsch',
      ownershipPct: '50.00',
      isPep: false,
    };
    const representativeDocument = {
      ...validDocument('PERSONALAUSWEIS'),
      beneficialOwnerSubjectId: null,
      representativeSubjectId: representativeId,
      verifiedAt: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    };
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          representatives: [{ id: representativeId }],
          beneficialOwners: [owner],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgBeneficialOwner: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      gwgRepresentative: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      gwgIdDocument: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: representativeDocument.id,
              documentSetId: representativeDocument.documentSetId,
              beneficialOwnerSubjectId: null,
            },
          ])
          .mockResolvedValueOnce([representativeDocument]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('ownerId', ownerId);
    data.set('expectedRevision', gwgBeneficialOwnerRevision(owner));

    const result = await removeBeneficialOwnerAction(null, data);

    expect(result).toEqual({
      ok: true,
      removedOwnerId: ownerId,
      reviewReset: false,
      invalidatedIdentitySets: [
        { documentSetId: representativeDocument.documentSetId, revision: expect.any(String) },
      ],
    });
    expect(tx.gwgIdDocument.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        gwgCheckId: CHECK_ID,
        OR: [
          { beneficialOwnerSubjectId: ownerId },
          { representativeSubjectId: { in: [representativeId] } },
        ],
      },
      select: {
        id: true,
        documentSetId: true,
        beneficialOwnerSubjectId: true,
      },
    });
    expect(tx.gwgIdDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.gwgRepresentative.updateMany).toHaveBeenCalledWith({
      where: { gwgCheckId: CHECK_ID, linkedBeneficialOwnerId: ownerId },
      data: { linkedBeneficialOwnerId: null },
    });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        after: expect.objectContaining({
          invalidatedIdentityDocuments: 1,
          unlinkedRepresentativeRoles: 1,
        }),
      }),
    );
  });

  it('ordnet einen Ausweis nur einer aktuell erfassten Person zu', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [{ id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha' }],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      document: {
        findFirst: vi.fn().mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555' }),
      },
      gwgIdDocument: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:33333333-3333-4333-8333-333333333333');
    data.set('number', 'L01X00T47');
    data.set('issuedBy', 'Stadt Berlin');
    data.set('issueDate', '2025-01-01');
    data.set('expiryDate', '2035-01-01');
    data.set('documentId', '55555555-5555-4555-8555-555555555555');

    const result = await addIdDocumentAction(null, data);

    expect(result).toEqual({ ok: true });
    expect(tx.gwgIdDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gwgCheckId: CHECK_ID,
        type: 'PERSONALAUSWEIS',
        ownerName: 'Rey Koxha',
        documentId: '55555555-5555-4555-8555-555555555555',
        verifiedAt: expect.any(Date),
      }),
    });
    expect(m.organizeGwgDocuments).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      createdByStaff: 'staff-1',
      documents: [
        {
          documentId: '55555555-5555-4555-8555-555555555555',
          personName: 'Rey Koxha',
        },
      ],
    });
  });

  it('vertraut bei der Ausweiszuordnung keinem frei erfundenen Browserwert', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      document: { findFirst: vi.fn() },
      gwgIdDocument: { create: vi.fn() },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:peter%20m%C3%BCller');
    data.set('number', 'L01X00T47');
    data.set('issuedBy', 'Stadt Berlin');
    data.set('expiryDate', '2035-01-01');
    data.set('documentId', '55555555-5555-4555-8555-555555555555');

    const result = await addIdDocumentAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('gehört nicht mehr zu den erfassten');
    expect(tx.document.findFirst).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.create).not.toHaveBeenCalled();
  });

  it('verknüpft einen Upload sofort und lässt noch ungeprüfte Metadaten offen', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      document: {
        findFirst: vi.fn().mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555' }),
      },
      gwgIdDocument: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:33333333-3333-4333-8333-333333333333');
    data.set('documentId', '55555555-5555-4555-8555-555555555555');

    const result = await addIdDocumentAction(null, data);

    expect(result).toEqual({ ok: true });
    expect(tx.gwgIdDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerName: 'Rey Koxha',
        documentId: '55555555-5555-4555-8555-555555555555',
        number: null,
        issuedBy: null,
        expiryDate: null,
        verifiedAt: null,
      }),
    });
  });

  it('ordnet Vorder- und Rückseite aus der Akte einem gemeinsamen neuen Ausweissatz zu', async () => {
    const frontId = '55555555-5555-4555-8555-555555555555';
    const backId = '77777777-7777-4777-8777-777777777777';
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      document: {
        findMany: vi.fn().mockResolvedValue([{ id: frontId }, { id: backId }]),
      },
      gwgIdDocument: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:33333333-3333-4333-8333-333333333333');
    data.set('number', 'L01X00T47');
    data.set('issuedBy', 'Stadt Berlin');
    data.set('issueDate', '2025-01-01');
    data.set('expiryDate', '2035-01-01');
    data.append('documentIds', frontId);
    data.append('documentIds', backId);

    expect(await addIdDocumentAction(null, data)).toEqual({ ok: true });

    const created = tx.gwgIdDocument.createMany.mock.calls[0]![0].data as Array<{
      documentId: string;
      documentSetId: string;
      representativeSubjectId: string;
    }>;
    expect(created.map((entry) => entry.documentId)).toEqual([frontId, backId]);
    expect(created[0]!.documentSetId).toBe(created[1]!.documentSetId);
    expect(created[0]!.representativeSubjectId).toBe('33333333-3333-4333-8333-333333333333');
    expect(tx.gwgIdDocument.create).not.toHaveBeenCalled();
  });

  it('meldet einen bereits zugeordneten Aktenbeleg klar statt eines stillen Erfolgs', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      document: {
        findFirst: vi.fn().mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555' }),
      },
      gwgIdDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: '66666666-6666-4666-8666-666666666666',
          type: 'GESELLSCHAFTSVERTRAG',
        }),
        create: vi.fn(),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:33333333-3333-4333-8333-333333333333');
    data.set('documentId', '55555555-5555-4555-8555-555555555555');

    const result = await addIdDocumentAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('bereits zugeordnet');
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.gwgIdDocument.create).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('durchsucht ältere unverknüpfte GwG-Belege serverseitig und begrenzt die Antwort', async () => {
    const matches = Array.from({ length: 51 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      title: `Ausweis ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 15, 0, index)),
    }));
    m.findCleanGwgDocuments.mockResolvedValue(matches);
    const tx = {
      gwgCheck: { findFirst: vi.fn().mockResolvedValue({ id: CHECK_ID }) },
    };
    runWithStaffOn(tx);

    const result = await searchUnlinkedGwgDocumentsAction({
      checkId: CHECK_ID,
      clientId: CLIENT_ID,
      query: 'alter ausweis',
    });

    expect(result.ok).toBe(true);
    expect(result.documents).toHaveLength(50);
    expect(result.limited).toBe(true);
    expect(m.findCleanGwgDocuments).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      query: 'alter ausweis',
      excludeLinkedCheckId: CHECK_ID,
      limit: 51,
    });
  });

  it('ergänzt eine Akten-Datei und führt einen offenen Alt-Satz vollständig zusammen', async () => {
    const targetSetId = '99999999-9999-4999-8999-999999999999';
    const sourceSetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const targetDocumentId = '55555555-5555-4555-8555-555555555555';
    const sourceFrontId = '66666666-6666-4666-8666-666666666666';
    const sourceBackId = '77777777-7777-4777-8777-777777777777';
    const unlinkedId = '88888888-8888-4888-8888-888888888888';
    const representativeId = '33333333-3333-4333-8333-333333333333';
    const row = (id: string, documentSetId: string, documentId: string, confirmed: boolean) => ({
      id,
      documentSetId,
      type: 'PERSONALAUSWEIS',
      ownerName: 'Rey Koxha',
      documentId,
      number: 'L01X00T47',
      issuedBy: 'Stadt Berlin',
      issueDate: new Date('2025-01-01T00:00:00.000Z'),
      expiryDate: new Date('2035-01-01T00:00:00.000Z'),
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: null,
      representativeSubjectId: representativeId,
      identityAssignmentConfirmedAt: confirmed ? DATABASE_NOW : null,
      identityAssignmentConfirmedBy: confirmed ? 'staff-1' : null,
      verifiedAt: confirmed ? DATABASE_NOW : null,
      document: {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
        gwgDestructionRequestedAt: null,
        gwgDestroyedAt: null,
      },
    });
    const existing = [
      row('10000000-0000-4000-8000-000000000001', targetSetId, targetDocumentId, true),
      row('10000000-0000-4000-8000-000000000002', sourceSetId, sourceFrontId, false),
      row('10000000-0000-4000-8000-000000000003', sourceSetId, sourceBackId, false),
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({ status: 'IN_REVIEW' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgIdDocument: {
        findMany: vi.fn().mockResolvedValue(existing),
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('targetDocumentSetId', targetSetId);
    // Selbst wenn nur eine Seite des offenen Quellsatzes übermittelt wird,
    // verschiebt der Server den gesamten persistierten Satz.
    data.append('documentIds', sourceFrontId);
    data.append('documentIds', unlinkedId);

    const result = await extendIdentityDocumentSetAction(null, data);

    expect(result).toEqual({ ok: true, reviewReset: true });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(m.lockCleanGwgDocuments).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      documentIds: [targetDocumentId, sourceFrontId, sourceBackId, unlinkedId],
    });
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith({
      where: {
        gwgCheckId: CHECK_ID,
        id: { in: existing.map((entry) => entry.id) },
        documentSetId: { in: [targetSetId, sourceSetId] },
      },
      data: expect.objectContaining({
        documentSetId: targetSetId,
        representativeSubjectId: representativeId,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      }),
    });
    expect(tx.gwgIdDocument.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          gwgCheckId: CHECK_ID,
          documentId: unlinkedId,
          documentSetId: targetSetId,
          verifiedAt: null,
        }),
      ],
    });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.id_document.set_files_update',
        resourceId: targetSetId,
        after: expect.objectContaining({ mergedDocumentSetIds: [sourceSetId] }),
      }),
    );
  });

  it('verhindert die Zusammenführung eines bereits bestätigten Quellsatzes', async () => {
    const targetSetId = '99999999-9999-4999-8999-999999999999';
    const sourceSetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sourceDocumentId = '66666666-6666-4666-8666-666666666666';
    const document = (
      id: string,
      documentSetId: string,
      documentId: string,
      confirmed: boolean,
    ) => ({
      id,
      documentSetId,
      type: 'PERSONALAUSWEIS',
      ownerName: 'Rey Koxha',
      documentId,
      number: 'L01X00T47',
      issuedBy: 'Stadt Berlin',
      issueDate: new Date('2025-01-01T00:00:00.000Z'),
      expiryDate: new Date('2035-01-01T00:00:00.000Z'),
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: null,
      representativeSubjectId: '33333333-3333-4333-8333-333333333333',
      identityAssignmentConfirmedAt: confirmed ? DATABASE_NOW : null,
      identityAssignmentConfirmedBy: confirmed ? 'staff-1' : null,
      verifiedAt: confirmed ? DATABASE_NOW : null,
      document: {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
        gwgDestructionRequestedAt: null,
        gwgDestroyedAt: null,
      },
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({ status: 'DRAFT' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgIdDocument: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            document(
              '10000000-0000-4000-8000-000000000001',
              targetSetId,
              '55555555-5555-4555-8555-555555555555',
              false,
            ),
            document('10000000-0000-4000-8000-000000000002', sourceSetId, sourceDocumentId, true),
          ]),
        updateMany: vi.fn(),
        createMany: vi.fn(),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('targetDocumentSetId', targetSetId);
    data.append('documentIds', sourceDocumentId);

    const result = await extendIdentityDocumentSetAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('bereits bestätigter Ausweissatz');
    expect(m.lockCleanGwgDocuments).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.createMany).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('verwirft veraltete Ausweisdaten ohne die aktuelle Zuordnung zu überschreiben', async () => {
    const documentSetId = '99999999-9999-4999-8999-999999999999';
    const currentDocument = {
      ...validDocument('PERSONALAUSWEIS'),
      id: '77777777-7777-4777-8777-777777777777',
      documentSetId,
    };
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [],
          idDocuments: [currentDocument],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgIdDocument: { updateMany: vi.fn() },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('documentSetId', documentSetId);
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:33333333-3333-4333-8333-333333333333');
    data.set('number', 'NEU-123');
    data.set('issuedBy', 'Stadt Berlin');
    data.set('issueDate', '2025-01-01');
    data.set('expiryDate', '2035-01-01');
    data.set('expectedRevision', '{}');

    const result = await updateIdDocumentsAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('zwischenzeitlich geändert');
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.updateMany).not.toHaveBeenCalled();
    expect(m.lockCleanGwgDocuments).not.toHaveBeenCalled();
  });

  it('korrigiert und bestätigt Vorder- und Rückseite als einen Ausweissatz', async () => {
    const frontId = '77777777-7777-4777-8777-777777777777';
    const backId = '88888888-8888-4888-8888-888888888888';
    const documentSetId = '99999999-9999-4999-8999-999999999999';
    const oldDocument = (id: string) => ({
      id,
      gwgCheckId: CHECK_ID,
      documentSetId,
      documentId: `document-${id}`,
      type: 'PERSONALAUSWEIS',
      ownerName: 'Rey Koxha',
      number: 'ALT',
      issuedBy: 'Altbehörde',
      issueDate: null,
      expiryDate: new Date('2030-01-01T00:00:00.000Z'),
      verifiedAt: null,
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: null,
      representativeSubjectId: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
      document: {
        id: `document-${id}`,
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
        gwgDestructionRequestedAt: null,
        gwgDestroyedAt: null,
      },
    });
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          representativeNames: ['Rey Koxha'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Rey Koxha', position: 0 },
          ],
          client: { id: CLIENT_ID, name: 'Muster GbR', kind: 'PERSGES' },
          beneficialOwners: [],
          idDocuments: [oldDocument(frontId), oldDocument(backId)],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgIdDocument: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('documentSetId', documentSetId);
    data.set('type', 'PERSONALAUSWEIS');
    data.set('subjectKey', 'representative:33333333-3333-4333-8333-333333333333');
    data.set('number', 'NEU-123');
    data.set('issuedBy', 'Stadt Berlin');
    data.set('issueDate', '2025-01-01');
    data.set('expiryDate', '2035-01-01');
    data.set(
      'expectedRevision',
      gwgIdentityDocumentSetRevision([oldDocument(frontId), oldDocument(backId)]),
    );

    const result = await updateIdDocumentsAction(null, data);

    expect(result).toEqual({
      ok: true,
      reviewReset: true,
      saved: {
        type: 'PERSONALAUSWEIS',
        subjectKey: 'representative:33333333-3333-4333-8333-333333333333',
        ownerName: 'Rey Koxha',
        number: 'NEU-123',
        issuedBy: 'Stadt Berlin',
        issueDate: '2025-01-01',
        expiryDate: '2035-01-01',
      },
      revision: expect.any(String),
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'IN_REVIEW' },
      data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
    });
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith({
      where: { documentSetId, gwgCheckId: CHECK_ID },
      data: expect.objectContaining({
        type: 'PERSONALAUSWEIS',
        ownerName: 'Rey Koxha',
        number: 'NEU-123',
        issuedBy: 'Stadt Berlin',
        issueDate: new Date('2025-01-01T00:00:00.000Z'),
        expiryDate: new Date('2035-01-01T00:00:00.000Z'),
        naturalClientSubjectId: null,
        beneficialOwnerSubjectId: null,
        representativeSubjectId: '33333333-3333-4333-8333-333333333333',
        identityAssignmentConfirmedAt: expect.any(Date),
        identityAssignmentConfirmedBy: 'staff-1',
        verifiedAt: expect.any(Date),
      }),
    });
  });
  it('speichert die Risikobewertung samt Review-Reset mit genau einem CAS-Update', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          riskScore: 2,
          riskLevel: 'LOW',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
    };
    runWithStaffOn(tx);

    const result = await saveRiskAnswersAction({
      checkId: CHECK_ID,
      clientId: CLIENT_ID,
      answers: {
        jurisdiction: 0,
        industry: 1,
        pep: 0,
        cash_intensity: 0,
        transparency: 0,
        transaction_complexity: 0,
      },
      expectedRevision: gwgRiskRevision({
        riskAnswers: {},
        riskScore: 2,
        riskLevel: 'LOW',
      }),
    });

    expect(result).toEqual({
      ok: true,
      reviewReset: true,
      revision: expect.any(String),
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'IN_REVIEW' },
        data: expect.objectContaining({
          status: 'DRAFT',
          reviewSubmittedAt: null,
          reviewSubmittedBy: null,
          riskAnswers: expect.any(Object),
        }),
      }),
    );
    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
  });

  it('speichert Rechtstr\u00e4gerdaten im Entwurf mit genau einem CAS-Update', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          legalForm: 'GbR',
          registerNumber: null,
          registerAuthority: null,
          noRegisterEntry: true,
          representativeNames: ['Erika Muster'],
          representatives: [
            { id: '33333333-3333-4333-8333-333333333333', fullName: 'Erika Muster', position: 0 },
          ],
          beneficialOwners: [],
          ownershipStructureNotes: 'Alt',
          client: { kind: 'PERSGES' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('legalForm', 'GbR');
    data.set('noRegisterEntry', 'on');
    data.set('representativeNamesText', 'Erika Muster');
    data.set('ownershipStructureNotes', 'Erika Muster kontrolliert die Gesellschaft.');
    data.set(
      'expectedRevision',
      gwgLegalEntityRevision({
        legalForm: 'GbR',
        registerNumber: null,
        registerAuthority: null,
        noRegisterEntry: true,
        representativeNames: ['Erika Muster'],
        representatives: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            fullName: 'Erika Muster',
            position: 0,
          },
        ],
        ownershipStructureNotes: 'Alt',
      }),
    );

    const result = await saveLegalEntityDetailsAction(null, data);

    expect(result).toEqual({
      ok: true,
      reviewReset: false,
      representativesChanged: false,
      representatives: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          fullName: 'Erika Muster',
          position: 0,
          linkedBeneficialOwnerId: null,
        },
      ],
      details: {
        legalForm: 'GbR',
        registerNumber: null,
        registerAuthority: null,
        noRegisterEntry: true,
        representativeNames: ['Erika Muster'],
        ownershipStructureNotes: 'Erika Muster kontrolliert die Gesellschaft.',
      },
      revision: expect.any(String),
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'DRAFT' },
        data: expect.objectContaining({
          status: 'DRAFT',
          representativeNames: ['Erika Muster'],
        }),
      }),
    );
    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
  });

  it('erhält stabile Vertreter-IDs und legt ausgewählte neue Personen strukturiert an', async () => {
    const existingId = '33333333-3333-4333-8333-333333333333';
    const newId = '55555555-5555-4555-8555-555555555555';
    const linkedOwnerId = '66666666-6666-4666-8666-666666666666';
    const representativeDocument = {
      ...validDocument('PERSONALAUSWEIS', 'Erika Alt'),
      verifiedAt: null,
      representativeSubjectId: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    };
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'DRAFT',
          legalForm: 'GbR',
          registerNumber: null,
          registerAuthority: null,
          noRegisterEntry: true,
          representativeNames: ['Erika Alt'],
          representatives: [{ id: existingId, fullName: 'Erika Alt', position: 0 }],
          beneficialOwners: [{ id: linkedOwnerId, fullName: 'Peter Eigentümer' }],
          ownershipStructureNotes: 'Alt',
          client: { kind: 'PERSGES' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgIdDocument: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: representativeDocument.id,
              documentSetId: representativeDocument.documentSetId,
            },
          ])
          .mockResolvedValueOnce([representativeDocument]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      gwgRepresentative: {
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    runWithStaffOn(tx);
    const data = formData();
    data.set('legalForm', 'GbR');
    data.set('noRegisterEntry', 'on');
    data.set('ownershipStructureNotes', 'Erika und Peter vertreten die Gesellschaft.');
    data.set(
      'representativesJson',
      JSON.stringify([
        { id: existingId, fullName: 'Erika Muster', isNew: false },
        {
          id: newId,
          fullName: 'Manipulierter Browsername',
          isNew: true,
          linkedBeneficialOwnerId: linkedOwnerId,
        },
      ]),
    );
    data.set(
      'expectedRevision',
      gwgLegalEntityRevision({
        legalForm: 'GbR',
        registerNumber: null,
        registerAuthority: null,
        noRegisterEntry: true,
        representativeNames: ['Erika Alt'],
        representatives: [{ id: existingId, fullName: 'Erika Alt', position: 0 }],
        ownershipStructureNotes: 'Alt',
      }),
    );

    const result = await saveLegalEntityDetailsAction(null, data);

    expect(result).toMatchObject({
      ok: true,
      representativesChanged: true,
      representatives: [
        {
          id: existingId,
          fullName: 'Erika Muster',
          position: 0,
          linkedBeneficialOwnerId: null,
        },
        {
          id: newId,
          fullName: 'Peter Eigentümer',
          position: 1,
          linkedBeneficialOwnerId: linkedOwnerId,
        },
      ],
      invalidatedIdentitySets: [
        { documentSetId: representativeDocument.documentSetId, revision: expect.any(String) },
      ],
    });
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [representativeDocument.id] } }),
      }),
    );
    expect(tx.gwgRepresentative.update).not.toHaveBeenCalled();
    expect(
      (tx as typeof tx & { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw,
    ).toHaveBeenCalled();
    expect(tx.gwgRepresentative.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: newId,
          gwgCheckId: CHECK_ID,
          fullName: 'Peter Eigentümer',
          position: 1,
          linkedBeneficialOwnerId: linkedOwnerId,
        },
      ],
    });
    expect(tx.gwgRepresentative.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgCheck.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgIdDocument.findMany.mock.invocationCallOrder[0]!,
    );
    expect(
      (tx as typeof tx & { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw.mock
        .invocationCallOrder[0],
    ).toBeLessThan(m.evidenceRecord.mock.invocationCallOrder[0]!);
  });
});

describe('GwG-Lifecycle-Lock', () => {
  it('nimmt den Mandanten-Lock vor dem Anlegen eines neuen Checks', async () => {
    const tx = makeStartCycleTx(null);
    runWithStaffOn(tx);

    await openCheckAction(formData());

    // startCheckCycle und der Defense-in-Depth-Helper fordern denselben
    // transaktionsgebundenen Advisory-Lock an; die Tx-lokale Deduplizierung
    // bezahlt dafür nur einen SQL-Roundtrip.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.create.mock.invocationCallOrder[0]!,
    );
  });

  it('erzeugt aus einer Ablehnung einen neuen Entwurf und kopiert keine alte Risikobewertung', async () => {
    const previous = completeCheck({ status: 'REJECTED', rejectedReason: 'Nachweise fehlen' });
    const tx = makeStartCycleTx(previous);
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    const result = await startNewCheckCycleAction(null, data);

    expect(result).toEqual({ ok: true, checkId: NEWER_CHECK_ID });
    expect(tx.gwgCheck.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        status: 'DRAFT',
        createdAt: DATABASE_NOW,
        predecessorCheckId: CHECK_ID,
        changeScope: 'ROUTINE',
      },
      select: { id: true },
    });
    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: NEWER_CHECK_ID },
      data: expect.objectContaining({
        notes: 'Identifizierung vollständig.',
        legalForm: 'GmbH',
        registerNumber: 'HRB 12345',
      }),
    });
    const copiedCheckData = tx.gwgCheck.update.mock.calls[0]![0].data;
    expect(copiedCheckData).not.toHaveProperty('riskAnswers');
    expect(copiedCheckData).not.toHaveProperty('riskScore');
    expect(copiedCheckData).not.toHaveProperty('riskLevel');
    expect(tx.gwgBeneficialOwner.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          gwgCheckId: NEWER_CHECK_ID,
          fullName: 'Erika Muster',
          ownershipPct: 100,
        }),
      ],
    });
    expect(tx.gwgIdDocument.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          gwgCheckId: NEWER_CHECK_ID,
          type: 'HANDELSREGISTERAUSZUG',
          documentId: 'doc-HANDELSREGISTERAUSZUG',
        }),
      ]),
    });
    expect(tx.gwgCheck.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.update.mock.invocationCallOrder[0]!,
    );
    expect(tx.gwgIdDocument.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      m.evidenceRecord.mock.invocationCallOrder[0]!,
    );
  });

  it('übernimmt nur verwendbare Nachweis-Links und lässt Löschmarker am Altbeleg unverändert', async () => {
    const pending = validDocument('HANDELSREGISTERAUSZUG');
    const deleted = validDocument('TRANSPARENZREGISTER_AUSZUG');
    const previous = completeCheck({
      status: 'REJECTED',
      idDocuments: [
        validDocument('PERSONALAUSWEIS'),
        {
          ...pending,
          document: {
            ...pending.document,
            gwgDestructionRequestedAt: new Date('2026-07-15T14:00:00.000Z'),
          },
        },
        {
          ...deleted,
          document: {
            ...deleted.document,
            deletedAt: new Date('2026-07-15T14:00:00.000Z'),
          },
        },
      ],
    });
    const tx = makeStartCycleTx(previous);
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    const result = await startNewCheckCycleAction(null, data);

    expect(result).toEqual({ ok: true, checkId: NEWER_CHECK_ID });
    const copied = tx.gwgIdDocument.createMany.mock.calls[0]![0].data;
    expect(copied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PERSONALAUSWEIS',
          documentId: 'doc-PERSONALAUSWEIS',
        }),
        expect.objectContaining({ type: 'HANDELSREGISTERAUSZUG', documentId: null }),
        expect.objectContaining({ type: 'TRANSPARENZREGISTER_AUSZUG', documentId: null }),
      ]),
    );
    expect(pending.document.gwgDestructionRequestedAt).toBeNull();
    expect(deleted.document.deletedAt).toBeNull();
  });

  it('vergibt beim Kopieren pro altem Dokumentset genau eine neue check-lokale UUID', async () => {
    const front = validDocument('PERSONALAUSWEIS');
    const back = {
      ...front,
      id: 'id-PERSONALAUSWEIS-back',
      documentId: 'doc-PERSONALAUSWEIS-back',
      document: {
        ...front.document,
        id: 'doc-PERSONALAUSWEIS-back',
      },
    };
    const previous = completeCheck({
      status: 'REJECTED',
      idDocuments: [front, back, validDocument('HANDELSREGISTERAUSZUG')],
    });
    const tx = makeStartCycleTx(previous);
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    expect(await startNewCheckCycleAction(null, data)).toEqual({
      ok: true,
      checkId: NEWER_CHECK_ID,
    });

    const copied = tx.gwgIdDocument.createMany.mock.calls[0]![0].data as Array<{
      type: string;
      documentSetId: string;
    }>;
    const copiedPersonalIds = copied.filter((entry) => entry.type === 'PERSONALAUSWEIS');
    expect(copiedPersonalIds).toHaveLength(2);
    expect(copiedPersonalIds[0]!.documentSetId).toBe(copiedPersonalIds[1]!.documentSetId);
    expect(copiedPersonalIds[0]!.documentSetId).not.toBe(front.documentSetId);
    expect(copiedPersonalIds[0]!.documentSetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('materialisiert einen bereits vernichteten Alt-Snapshot nicht erneut', async () => {
    const tx = makeStartCycleTx(
      completeCheck({
        status: 'EXPIRED',
        destroyedAt: new Date('2026-07-15T14:00:00.000Z'),
      }),
    );
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    const result = await startNewCheckCycleAction(null, data);

    expect(result).toEqual({ ok: true, checkId: NEWER_CHECK_ID });
    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
    expect(tx.gwgBeneficialOwner.createMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.createMany).not.toHaveBeenCalled();
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        after: expect.objectContaining({
          sourceDestroyed: true,
          copiedOwnerCount: 0,
          copiedDocumentCount: 0,
        }),
      }),
    );
  });

  it('weist einen Doppelklick mit veralteter Latest-ID vor dem Create ab', async () => {
    const tx = makeStartCycleTx(
      completeCheck({ id: NEWER_CHECK_ID, status: 'REJECTED', rejectedReason: 'Neuere Ablehnung' }),
    );
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    const result = await startNewCheckCycleAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('zwischenzeitlich geändert');
    expect(tx.gwgCheck.create).not.toHaveBeenCalled();
  });

  it('startet neben einem bereits offenen Snapshot keinen zweiten Zyklus', async () => {
    const tx = makeStartCycleTx(completeCheck({ status: 'DRAFT' }));
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    const result = await startNewCheckCycleAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('bereits eine bearbeitbare GwG-Prüfung');
    expect(tx.gwgCheck.create).not.toHaveBeenCalled();
  });

  it('terminalisiert bei einer Wiederholungsprüfung den verifizierten Altcheck und deaktiviert fail-closed', async () => {
    const tx = makeStartCycleTx(completeCheck({ status: 'VERIFIED' }), {
      invalidated: 1,
      deactivated: 1,
    });
    runWithStaffOn(tx);
    const data = formData();
    data.set('expectedLatestCheckId', CHECK_ID);

    const result = await startNewCheckCycleAction(null, data);

    expect(result).toEqual({ ok: true, checkId: NEWER_CHECK_ID });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        status: { in: ['DRAFT', 'IN_REVIEW', 'VERIFIED'] },
        id: { not: NEWER_CHECK_ID },
      },
      data: { status: 'EXPIRED' },
    });
    expect(tx.client.updateMany).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, tenantId: 'tenant-1', allowActive: true },
      data: { allowActive: false },
    });
    expect(tx.gwgCheck.update).toHaveBeenCalledTimes(1);
    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: NEWER_CHECK_ID },
      data: expect.any(Object),
    });
  });
});

describe('submitCheckForReviewAction', () => {
  it('übergibt einen vollständigen Entwurf nachvollziehbar an den Berufsträger', async () => {
    const tx = makeTx(completeCheck({ status: 'DRAFT' }));
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await submitCheckForReviewAction(null, formData());

    expect(result).toEqual({ ok: true });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'DRAFT' },
      data: expect.objectContaining({ status: 'IN_REVIEW', reviewSubmittedBy: 'staff-1' }),
    });
    expect(m.notifyMany).toHaveBeenCalledWith(
      tx,
      ['staff-1'],
      expect.objectContaining({ resourceId: CHECK_ID }),
    );
    expect(tx.clientResponsibility.findMany).toHaveBeenCalledWith({
      where: {
        clientId: CLIENT_ID,
        role: 'BERUFSTRAEGER',
        staff: { tenantId: 'tenant-1', active: true, roles: { some: {} } },
      },
      select: { staffId: true },
    });
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.findFirst.mock.invocationCallOrder[0]!,
    );
  });

  it('übergibt einen älteren Entwurf bei einem neueren Snapshot nicht mehr', async () => {
    const tx = makeTx(completeCheck({ status: 'DRAFT' }));
    tx.gwgCheck.findFirst
      .mockResolvedValueOnce(completeCheck({ status: 'DRAFT' }))
      .mockResolvedValueOnce({ id: NEWER_CHECK_ID });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await submitCheckForReviewAction(null, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('neuere GwG-Prüfung');
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(m.notifyMany).not.toHaveBeenCalled();
  });

  it('weist einen unvollständigen Entwurf nicht zur Freigabe zu', async () => {
    const tx = makeTx(completeCheck({ status: 'DRAFT', legalForm: null }));
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await submitCheckForReviewAction(null, formData());

    expect(result.ok).toBe(false);
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(m.notifyMany).not.toHaveBeenCalled();
  });
});

describe('verifyCheckAction – Rechtsträger-Gate', () => {
  it('materialisiert bei einem Legacy-IN_REVIEW keine fehlende Übergabe nachträglich', async () => {
    const check = completeCheck({ reviewSubmittedAt: null, reviewSubmittedBy: null });
    const tx = makeTx(check);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, verificationFormData(check));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('dokumentierte Übergabe');
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it('verifiziert keinen unvollständigen Rechtsträger', async () => {
    const check = completeCheck({
      legalForm: null,
      registerNumber: null,
      registerAuthority: null,
      representativeNames: [],
      ownershipStructureNotes: null,
    });
    const tx = makeTx(check);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, verificationFormData(check));

    expect(result.ok).toBe(false);
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it('verifiziert vollständigen Snapshot und aktiviert erst nach atomarem Claim', async () => {
    const check = completeCheck();
    const tx = makeTx(check);
    tx.gwgOnboardingInvite.findMany.mockResolvedValue([{ id: 'invite-1' }]);
    m.isStaffAdmin.mockReturnValue(false);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, verificationFormData(check));

    expect(result).toEqual({ ok: true });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'IN_REVIEW' },
        data: expect.objectContaining({
          status: 'VERIFIED',
          verifiedBy: 'staff-1',
          reviewSubmittedBy: 'staff-1',
        }),
      }),
    );
    expect(tx.client.update).toHaveBeenCalledWith({
      where: { id: CLIENT_ID },
      data: { allowActive: true },
    });
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        readAt: null,
        OR: [
          { resourceType: 'gwg_check', resourceId: CHECK_ID },
          { resourceType: 'gwg_onboarding_invite', resourceId: 'invite-1' },
        ],
      },
      data: { readAt: expect.any(Date) },
    });
    expect(tx.clientResponsibility.findFirst).toHaveBeenCalledWith({
      where: {
        clientId: CLIENT_ID,
        staffId: 'staff-1',
        role: 'BERUFSTRAEGER',
        staff: { tenantId: 'tenant-1', active: true, roles: { some: {} } },
      },
      select: { id: true },
    });
    expect(m.isStaffAdmin).not.toHaveBeenCalled();
    expect(m.organizeGwgDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        documents: expect.arrayContaining([
          expect.objectContaining({
            documentId: 'doc-PERSONALAUSWEIS',
            personName: 'Erika Muster',
          }),
        ]),
      }),
    );
    expect(m.emitN8nEvent).toHaveBeenCalledOnce();
    expect(m.emitN8nEvent).toHaveBeenCalledWith(
      'gwg.verified',
      expect.objectContaining({
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        gwgCheckId: CHECK_ID,
      }),
      { tenantId: 'tenant-1' },
    );
    expect(m.notifyClientContacts).toHaveBeenCalledWith(
      expect.not.objectContaining({ n8nEvent: expect.anything() }),
    );
    expect(tx.gwgCheck.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        id: { not: CHECK_ID },
        verifiedAt: { not: null },
      },
    });
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.findFirst.mock.invocationCallOrder[0]!,
    );
  });

  it('versendet bei einer erneuten GwG-Freigabe keine zweite Willkommensmail', async () => {
    const check = completeCheck();
    const tx = makeTx(check);
    tx.gwgCheck.count.mockResolvedValue(1);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, verificationFormData(check));

    expect(result).toEqual({ ok: true });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledOnce();
    expect(tx.client.update).toHaveBeenCalledWith({
      where: { id: CLIENT_ID },
      data: { allowActive: true },
    });
    expect(m.notifyClientContacts).not.toHaveBeenCalled();
    expect(m.fireAndForget).not.toHaveBeenCalled();
    expect(m.emitN8nEvent).toHaveBeenCalledWith(
      'gwg.verified',
      expect.objectContaining({ gwgCheckId: CHECK_ID }),
      { tenantId: 'tenant-1' },
    );
  });

  it('blockiert eine inaktive oder rollenlose Berufsträger-Zuordnung vor der Entscheidung', async () => {
    const check = completeCheck();
    const tx = makeTx(check);
    tx.clientResponsibility.findFirst.mockResolvedValue(null);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, verificationFormData(check));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('zugeordnete Berufsträger');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it('verifiziert den stale Review A nach einem neuen Invite-Snapshot B nicht mehr', async () => {
    const check = completeCheck();
    const tx = makeTx(check);
    tx.gwgCheck.findFirst
      .mockResolvedValueOnce(completeCheck())
      .mockResolvedValueOnce({ id: NEWER_CHECK_ID });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, verificationFormData(check));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('neuere GwG-Prüfung');
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });
});

describe('rejectCheckAction – aktueller Snapshot', () => {
  it('schließt die Freigabe-Notification nach einer Ablehnung ebenfalls', async () => {
    const tx = makeTx(completeCheck());
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    const data = formData();
    data.set('reason', 'Unterlagen unzureichend');

    const result = await rejectCheckAction(null, data);

    expect(result).toEqual({ ok: true });
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        readAt: null,
        OR: [{ resourceType: 'gwg_check', resourceId: CHECK_ID }],
      },
      data: { readAt: expect.any(Date) },
    });
  });

  it('lehnt den stale Review A nach einem neuen Invite-Snapshot B nicht mehr ab', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      clientResponsibility: {
        findFirst: vi.fn().mockResolvedValue({ id: 'resp-1' }),
      },
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({ id: NEWER_CHECK_ID }),
        updateMany: vi.fn(),
      },
      client: { updateMany: vi.fn() },
      clientContact: { findMany: vi.fn() },
      notification: { updateMany: vi.fn() },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );
    const data = formData();
    data.set('reason', 'Unterlagen unzureichend');

    const result = await rejectCheckAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('neuere GwG-Prüfung');
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.updateMany).not.toHaveBeenCalled();
    expect(tx.notification.updateMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.findFirst.mock.invocationCallOrder[0]!,
    );
  });
});
