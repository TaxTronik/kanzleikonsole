import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  guard: vi.fn(),
  context: vi.fn(),
  record: vi.fn(),
  anonymizeContact: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.context }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.record } }));
vi.mock('@/server/actions/staff-action', async () => ({
  staffActionGuard: m.guard,
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(m.guard),
}));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: vi.fn() }));
vi.mock('@/server/dsgvo/anonymize-contact', () => ({
  anonymizeContactInTx: m.anonymizeContact,
  isAnonymizedContactEmail: vi.fn(),
}));
vi.mock('@/server/dsgvo/anonymize-client-data', () => ({
  anonymizeClientSideTablesInTx: vi.fn().mockResolvedValue({}),
  POA_PERSONAL_DATA_PRESENT_WHERE: {},
  redactClientPoaPersonalDataInTx: vi.fn(),
}));
import { confirmClientAnonymizationAction } from '../actions';
const clientId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  m.guard.mockResolvedValue({ ok: true, tenantId: 'tenant', staffId: 'staff', ctx: {} });
});
describe('DSGVO-MANDATE-ANONYMIZATION-001 / TAX-MASTER-DATA-001 tax redaction', () => {
  it('redacts legacy, active and archived tax master data without rewriting retained ELSTER snapshots', async () => {
    const tx = {
      $queryRaw: vi.fn(),
      client: {
        findFirst: vi.fn().mockResolvedValue({
          id: clientId,
          kind: 'NATPERS',
          mandateEndedAt: new Date('2010-01-01'),
          anonymizedAt: null,
          contacts: [{ id: 'synthetic-contact', email: 'synthetic@example.test' }],
          _count: { documents: 0, gwgChecks: 0 },
        }),
        update: vi.fn(),
      },
      clientTaxRegistration: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      clientCustomFieldValue: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      clientMasterChangeRequest: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      elsterKontoabfrage: { updateMany: vi.fn(), deleteMany: vi.fn() },
    };
    m.context.mockImplementation(async (_ctx, fn) => fn(tx));
    expect(await confirmClientAnonymizationAction({ clientId })).toEqual({ ok: true });
    // RISK-ARCHIVE-SNAPSHOT-001: Client and Risk locks precede contact Audit.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      m.anonymizeContact.mock.invocationCallOrder[0]!,
    );
    expect(tx.client.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vatId: null, steuernummer: null }),
      }),
    );
    expect(tx.clientTaxRegistration.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant', clientId },
      data: {
        label: 'Anonymisiert',
        stateCode: null,
        numberElster: null,
        taxOfficeName: '',
        taxOfficeCode: null,
        isPrimary: false,
        archivedAt: expect.any(Date),
      },
    });
    expect(tx.elsterKontoabfrage.updateMany).not.toHaveBeenCalled();
    expect(tx.elsterKontoabfrage.deleteMany).not.toHaveBeenCalled();
    expect(m.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ after: expect.objectContaining({ taxRegistrationsRedacted: 3 }) }),
    );
  });
});
