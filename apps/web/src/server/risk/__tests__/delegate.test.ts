import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  notify: vi.fn(),
  canOtherStaffAccessClientTx: vi.fn(),
  persistReminderReferencesTx: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', () => ({ ActionError: class extends Error {} }));
vi.mock('@/server/reminders/references', () => ({
  persistReminderReferencesTx: mocks.persistReminderReferencesTx,
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/notifications/service', () => ({ notify: mocks.notify }));
vi.mock('@/server/auth/rbac', () => ({
  canOtherStaffAccessClientTx: mocks.canOtherStaffAccessClientTx,
}));

import type { TenantContext, TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { delegateMarking } from '../delegate';

const ACTOR = '22222222-2222-4222-8222-222222222222';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  actorId: ACTOR,
  actorType: 'STAFF',
};

const session = { user: { staffId: ACTOR, tenantId: ctx.tenantId } } as StaffSession;

const MARKING = {
  id: '33333333-3333-4333-8333-333333333333',
  begriff: 'Verrechnungspreise',
  normAnker: ['§ 1 AStG'],
  start: 100,
  end: 140,
  matchedText: 'streng vertraulicher Wortlaut',
  analysisId: '44444444-4444-4444-8444-444444444444',
  analysis: {
    id: '44444444-4444-4444-8444-444444444444',
    clientId: '55555555-5555-4555-8555-555555555555',
    documentId: null,
  },
};

function mockTx() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    riskMarking: { findUnique: vi.fn().mockResolvedValue(MARKING), update: vi.fn() },
    staffUser: { findFirst: vi.fn().mockResolvedValue({ id: 'assignee' }) },
    clientReminder: { create: vi.fn().mockResolvedValue({ id: 'reminder-1' }) },
  };
  mocks.withTenantContext.mockImplementation(
    (_c: TenantContext, cb: (t: TxClient) => Promise<unknown>) => cb(tx as unknown as TxClient),
  );
  return tx;
}

const input = {
  markingId: MARKING.id,
  createdByStaffId: ACTOR,
  assigneeStaffId: '66666666-6666-4666-8666-666666666666',
};

describe('delegateMarking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canOtherStaffAccessClientTx.mockResolvedValue(true);
  });

  // Fachkatalog: REMINDER-TICKET-001
  it('behält bei erneuter Delegation die Rechercheherkunft am neuen Ticket', async () => {
    const tx = mockTx();
    tx.riskMarking.findUnique.mockResolvedValue({
      ...MARKING,
      reminder: { id: 'previous-ticket', doneAt: new Date() },
    });
    await delegateMarking(ctx, input, session);
    expect(tx.clientReminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ originRiskMarkingId: MARKING.id }),
      }),
    );
    expect(tx.riskMarking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reminderId: 'reminder-1' }) }),
    );
  });

  it('benachrichtigt die zugewiesene Person sofort mit Sprung auf die Markierung', async () => {
    mockTx();
    await delegateMarking(ctx, input, session);

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const [, arg] = mocks.notify.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(arg.staffId).toBe(input.assigneeStaffId);
    expect(arg.kind).toBe('RISK_MARKING_ASSIGNED');
    expect(arg.title).toContain('Verrechnungspreise');
    expect(arg.href).toBe(
      `/staff/clients/${MARKING.analysis.clientId}/subsumtion/${MARKING.analysis.id}?marking=${MARKING.id}`,
    );
  });

  it('traegt den woertlichen Sachverhaltsauszug NICHT in die Benachrichtigung', async () => {
    mockTx();
    await delegateMarking(ctx, input, session);

    const [, arg] = mocks.notify.mock.calls[0] as [unknown, Record<string, unknown>];
    const text = `${arg.title ?? ''} ${arg.body ?? ''}`;
    expect(text).not.toContain(MARKING.matchedText);
  });

  it('verweigert die Delegation an jemanden ohne Mandantenzugriff', async () => {
    const tx = mockTx();
    mocks.canOtherStaffAccessClientTx.mockResolvedValue(false);

    await expect(delegateMarking(ctx, input, session)).rejects.toThrow(/keinen Zugriff/);
    // Weder Wiedervorlage noch Zuweisung noch Benachrichtigung entstehen.
    expect(tx.clientReminder.create).not.toHaveBeenCalled();
    expect(tx.riskMarking.update).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('benachrichtigt nicht, wenn jemand sich selbst zuweist', async () => {
    mockTx();
    await delegateMarking(ctx, { ...input, assigneeStaffId: ACTOR }, session);

    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('legt keine zweite Wiedervorlage an, solange die Delegation offen ist', async () => {
    const tx = mockTx();
    tx.riskMarking.findUnique.mockResolvedValue({
      ...MARKING,
      reminder: { id: 'reminder-open', doneAt: null },
    });

    await expect(delegateMarking(ctx, input, session)).rejects.toThrow(
      /bereits eine Delegation offen/,
    );

    expect(tx.clientReminder.create).not.toHaveBeenCalled();
    expect(tx.riskMarking.update).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
