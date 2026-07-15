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
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/mail/dispatch', () => ({ notifyClientContacts: m.notifyClientContacts }));
vi.mock('@/server/notifications/service', () => ({ notifyMany: m.notifyMany }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: m.fireAndForget }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
  staffActionGuard: m.staffActionGuard,
  withStaff: m.withStaff,
}));

import {
  addBeneficialOwnerAction,
  openCheckAction,
  saveLegalEntityDetailsAction,
  saveRiskAnswersAction,
  rejectCheckAction,
  startNewCheckCycleAction,
  submitCheckForReviewAction,
  updateBeneficialOwnerAction,
  verifyCheckAction,
} from '../actions';

const CHECK_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const NEWER_CHECK_ID = '44444444-4444-4444-8444-444444444444';
const DATABASE_NOW = new Date('2026-07-15T15:30:00.000Z');

function validDocument(type: string, ownerName = 'Erika Muster') {
  return {
    id: `id-${type}`,
    type,
    ownerName,
    number: type === 'PERSONALAUSWEIS' ? 'L01X00T47' : null,
    issuedBy: type === 'PERSONALAUSWEIS' ? 'Stadt Berlin' : null,
    issueDate: new Date('2025-01-01T00:00:00Z'),
    expiryDate: type === 'PERSONALAUSWEIS' ? new Date('2099-01-01T00:00:00Z') : null,
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
    },
  };
}

function completeCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECK_ID,
    clientId: CLIENT_ID,
    status: 'IN_REVIEW',
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
    client: { kind: 'JURPERS' },
    beneficialOwners: [
      {
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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    client: {
      findUnique: vi.fn().mockResolvedValue({ kind: 'JURPERS' }),
      update: vi.fn().mockResolvedValue({}),
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
    gwgIdDocument: {
      createMany: vi.fn().mockResolvedValue({ count: latest?.idDocuments.length ?? 0 }),
    },
    client: {
      updateMany: vi.fn().mockResolvedValue({ count: counts.deactivated ?? 0 }),
    },
  };
}

function runWithStaffOn(tx: unknown) {
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
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('parallel geändert');
    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
  });

  it('verwirft auch ein verspätetes Speichern unveränderter Rechtsträgerdaten', async () => {
    const tx = {
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'IN_REVIEW',
          legalForm: 'GbR',
          registerNumber: null,
          registerAuthority: null,
          noRegisterEntry: true,
          representativeNames: ['Erika Muster'],
          ownershipStructureNotes: 'Erika Muster kontrolliert die Gesellschaft.',
          client: { kind: 'PERSGES' },
        }),
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

    const result = await updateBeneficialOwnerAction(null, data);

    expect(result).toEqual({ ok: true });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: CHECK_ID, clientId: CLIENT_ID, status: 'IN_REVIEW' },
      data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
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
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.owner.update',
        resourceId: '33333333-3333-4333-8333-333333333333',
        before: expect.objectContaining({ fullName: 'Erika Alt', isPep: false }),
        after: expect.objectContaining({ fullName: 'Erika Muster', isPep: true }),
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

    const result = await updateBeneficialOwnerAction(null, data);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('parallel geändert');
    expect(tx.gwgBeneficialOwner.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('GwG-Lifecycle-Lock', () => {
  it('nimmt den Mandanten-Lock vor dem Anlegen eines neuen Checks', async () => {
    const tx = makeStartCycleTx(null);
    runWithStaffOn(tx);

    await openCheckAction(formData());

    // startCheckCycle und der Defense-in-Depth-Helper nehmen denselben
    // transaktionsgebundenen Advisory-Lock; PostgreSQL erlaubt das reentrant.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
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

    expect(result).toEqual({ ok: true });
    expect(tx.gwgCheck.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        status: 'DRAFT',
        createdAt: DATABASE_NOW,
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

    expect(result).toEqual({ ok: true });
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

    expect(result).toEqual({ ok: true });
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

    expect(result).toEqual({ ok: true });
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
  it('verifiziert keinen unvollständigen Rechtsträger', async () => {
    const tx = makeTx(
      completeCheck({
        legalForm: null,
        registerNumber: null,
        registerAuthority: null,
        representativeNames: [],
        ownershipStructureNotes: null,
      }),
    );
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, formData());

    expect(result.ok).toBe(false);
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it('verifiziert vollständigen Snapshot und aktiviert erst nach atomarem Claim', async () => {
    const tx = makeTx(completeCheck());
    m.isStaffAdmin.mockReturnValue(false);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, formData());

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
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.findFirst.mock.invocationCallOrder[0]!,
    );
  });

  it('blockiert eine inaktive oder rollenlose Berufsträger-Zuordnung vor der Entscheidung', async () => {
    const tx = makeTx(completeCheck());
    tx.clientResponsibility.findFirst.mockResolvedValue(null);
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('zugeordnete Berufsträger');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it('verifiziert den stale Review A nach einem neuen Invite-Snapshot B nicht mehr', async () => {
    const tx = makeTx(completeCheck());
    tx.gwgCheck.findFirst
      .mockResolvedValueOnce(completeCheck())
      .mockResolvedValueOnce({ id: NEWER_CHECK_ID });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, formData());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('neuere GwG-Prüfung');
    expect(tx.gwgCheck.updateMany).not.toHaveBeenCalled();
    expect(tx.client.update).not.toHaveBeenCalled();
  });
});

describe('rejectCheckAction – aktueller Snapshot', () => {
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
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.findFirst.mock.invocationCallOrder[0]!,
    );
  });
});
