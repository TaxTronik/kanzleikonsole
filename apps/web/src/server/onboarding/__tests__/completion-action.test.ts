import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  manualCapture: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/gwg-onboarding/manual-capture', () => ({
  startManualGwgCaptureTx: mocks.manualCapture,
}));
vi.mock('@/server/auth/magic-link', () => ({ requestMagicLink: vi.fn() }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: vi.fn() }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: mocks.emitN8nEvent }));
vi.mock('@/server/gwg-onboarding/service', () => ({
  generateInviteToken: vi.fn(() => ({ raw: 'raw', hash: 'hash' })),
  INVITE_TTL_DAYS: 7,
}));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: mocks.assertClientAccessTx }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
  staffActionGuard: mocks.staffActionGuard,
}));

import {
  onboardingCompleteAction,
  onboardingCaptureGwgInOfficeAction,
} from '@/app/staff/(protected)/clients/onboarding/[id]/actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '22222222-2222-4222-8222-222222222222';

function formData(): FormData {
  const data = new FormData();
  data.set('clientId', CLIENT_ID);
  return data;
}

function makeTx() {
  return {
    client: {
      findUnique: vi.fn().mockResolvedValue({
        allowActive: true,
        onboardingCompletedAt: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    clientContact: { count: vi.fn().mockResolvedValue(1) },
    gwgCheck: {
      findFirst: vi.fn().mockResolvedValue({
        id: CHECK_ID,
        status: 'VERIFIED',
        validUntil: new Date('2030-01-01T00:00:00.000Z'),
        verifiedAt: new Date('2026-07-15T10:00:00.000Z'),
        verifiedBy: 'professional-1',
        reviewSubmittedAt: new Date('2026-07-15T09:00:00.000Z'),
        reviewSubmittedBy: 'staff-1',
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
  });
  mocks.evidenceRecord.mockResolvedValue({});
  mocks.redirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
});

describe('Onboarding-Abschluss', () => {
  it('persistiert den Marker nur mit Kontakt und gueltiger GwG-Freigabe', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(formData())).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.anything(), CLIENT_ID);
    expect(tx.client.updateMany).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, allowActive: true, onboardingCompletedAt: null },
      data: {
        onboardingCompletedAt: expect.any(Date),
        onboardingCompletedBy: 'staff-1',
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'client.onboarding.complete',
        resourceId: CLIENT_ID,
      }),
    );
  });

  it('blockiert den Abschluss ohne aktiven Ansprechpartner', async () => {
    const tx = makeTx();
    tx.clientContact.count.mockResolvedValue(0);
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(formData())).rejects.toThrow(
      'mindestens einem aktiven Ansprechpartner',
    );

    expect(tx.client.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('behandelt einen historischen Abschluss idempotent', async () => {
    const tx = makeTx();
    tx.client.findUnique.mockResolvedValue({
      allowActive: false,
      onboardingCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(formData())).rejects.toThrow('NEXT_REDIRECT');

    expect(tx.clientContact.count).not.toHaveBeenCalled();
    expect(tx.gwgCheck.findFirst).not.toHaveBeenCalled();
    expect(tx.client.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('schreibt bei gleichzeitigem Doppelklick weder Marker noch Audit doppelt', async () => {
    const tx = makeTx();
    tx.client.findUnique
      .mockResolvedValueOnce({ allowActive: true, onboardingCompletedAt: null })
      .mockResolvedValueOnce({ onboardingCompletedAt: new Date('2026-07-15T10:00:00.000Z') });
    tx.client.updateMany.mockResolvedValue({ count: 0 });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(formData())).rejects.toThrow('NEXT_REDIRECT');

    expect(tx.client.updateMany).toHaveBeenCalledOnce();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('GWG-SELF-ONBOARDING-001: manual collection action', () => {
  it('checks client access before switching channel and redirects to the existing GwG editor', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (value: typeof tx) => unknown) => fn(tx),
    );
    await expect(onboardingCaptureGwgInOfficeAction(formData())).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.anything(), CLIENT_ID);
    expect(mocks.manualCapture).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      staffId: 'staff-1',
    });
    expect(mocks.assertClientAccessTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.manualCapture.mock.invocationCallOrder[0]!,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/staff/clients/${CLIENT_ID}/gwg?from=onboarding`);
    expect(tx.client.updateMany).not.toHaveBeenCalled();
  });
  it('cannot be used without a staff session or with denied client access', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce({ ok: false, error: 'unauthorized' });
    await expect(onboardingCaptureGwgInOfficeAction(formData())).rejects.toThrow('unauthorized');
    expect(mocks.manualCapture).not.toHaveBeenCalled();
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (value: typeof tx) => unknown) => fn(tx),
    );
    mocks.assertClientAccessTx.mockRejectedValueOnce(new Error('forbidden'));
    await expect(onboardingCaptureGwgInOfficeAction(formData())).rejects.toThrow('forbidden');
    expect(mocks.manualCapture).not.toHaveBeenCalled();
  });
});
