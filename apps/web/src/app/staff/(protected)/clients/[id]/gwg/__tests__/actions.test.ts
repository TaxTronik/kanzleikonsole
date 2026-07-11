import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  isStaffAdmin: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
  notifyClientContacts: vi.fn(),
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
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: m.fireAndForget }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
  staffActionGuard: m.staffActionGuard,
  withStaff: vi.fn(),
}));

import { verifyCheckAction } from '../actions';

const CHECK_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

function validDocument(type: string, ownerName = 'Erika Muster') {
  return {
    id: `id-${type}`,
    type,
    ownerName,
    number: type === 'PERSONALAUSWEIS' ? 'L01X00T47' : null,
    issuedBy: type === 'PERSONALAUSWEIS' ? 'Stadt Berlin' : null,
    expiryDate: type === 'PERSONALAUSWEIS' ? new Date('2099-01-01T00:00:00Z') : null,
    documentId: `doc-${type}`,
    document: { clientId: CLIENT_ID, classification: 'GWG_EVIDENCE', deletedAt: null },
  };
}

function completeCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECK_ID,
    clientId: CLIENT_ID,
    status: 'IN_REVIEW',
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
    beneficialOwners: [{ isPep: false }],
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
    clientResponsibility: { findFirst: vi.fn().mockResolvedValue({ id: 'resp-1' }) },
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
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await verifyCheckAction(null, formData());

    expect(result).toEqual({ ok: true });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CHECK_ID, clientId: CLIENT_ID, status: { in: ['DRAFT', 'IN_REVIEW'] } },
        data: expect.objectContaining({ status: 'VERIFIED', verifiedBy: 'staff-1' }),
      }),
    );
    expect(tx.client.update).toHaveBeenCalledWith({
      where: { id: CLIENT_ID },
      data: { allowActive: true },
    });
  });
});
