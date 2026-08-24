// Fachkatalog: POA-SIGNER-RETENTION-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  redactPoa: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: m.staffActionGuard }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: vi.fn() }));
vi.mock('@/server/dsgvo/anonymize-contact', () => ({
  anonymizeContactInTx: vi.fn(),
  isAnonymizedContactEmail: vi.fn(),
}));
vi.mock('@/server/dsgvo/anonymize-client-data', () => ({
  anonymizeClientSideTablesInTx: vi.fn(),
  POA_PERSONAL_DATA_PRESENT_WHERE: { OR: [{ signerName: { not: 'Anonymisiert' } }] },
  redactClientPoaPersonalDataInTx: m.redactPoa,
}));

import { confirmPoaSignerAnonymizationAction } from '../actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function makeTx(mandateEndedAt = new Date('2010-06-30T00:00:00.000Z'), kind = 'JURPERS') {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: CLIENT_ID }]),
    client: {
      findFirst: vi.fn().mockResolvedValue({
        id: CLIENT_ID,
        kind,
        mandateEndedAt,
        poaSignerDataRedactedAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    powerOfAttorney: { count: vi.fn().mockResolvedValue(2) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: TENANT_ID,
    staffId: 'staff-1',
    ctx: { tenantId: TENANT_ID, actorId: 'staff-1', actorType: 'STAFF' },
  });
  m.redactPoa.mockResolvedValue(2);
  m.evidenceRecord.mockResolvedValue({});
});

describe('confirmPoaSignerAnonymizationAction', () => {
  it('markiert und redigiert fällige Gesellschafts-PoAs atomar mit Audit', async () => {
    const tx = makeTx();
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    await expect(confirmPoaSignerAnonymizationAction({ clientId: CLIENT_ID })).resolves.toEqual({
      ok: true,
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.client.update).toHaveBeenCalledWith({
      where: { id: CLIENT_ID },
      data: { poaSignerDataRedactedAt: expect.any(Date) },
    });
    expect(tx.client.update.mock.invocationCallOrder[0]).toBeLessThan(
      m.redactPoa.mock.invocationCallOrder[0]!,
    );
    expect(m.redactPoa).toHaveBeenCalledWith(tx, CLIENT_ID);
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'poa.signer.anonymize',
        resourceId: CLIENT_ID,
        after: expect.objectContaining({ poasRedacted: 2 }),
      }),
    );
  });

  it('blockiert vor Fristablauf und verändert keine PoA', async () => {
    const tx = makeTx(new Date());
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmPoaSignerAnonymizationAction({ clientId: CLIENT_ID });

    expect(result.ok).toBe(false);
    expect(tx.client.update).not.toHaveBeenCalled();
    expect(m.redactPoa).not.toHaveBeenCalled();
  });

  it('verändert NATPERS nicht über den Gesellschafts-Signerpfad', async () => {
    const tx = makeTx(new Date('2010-06-30T00:00:00.000Z'), 'NATPERS');
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const result = await confirmPoaSignerAnonymizationAction({ clientId: CLIENT_ID });

    expect(result.ok).toBe(false);
    expect(m.redactPoa).not.toHaveBeenCalled();
  });
});
