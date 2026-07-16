import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const INVITE_ID = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    staffActionGuard: vi.fn(),
    withStaff: vi.fn(),
    withTenantContext: vi.fn(),
    assertClientAccessTx: vi.fn(),
    assertClientInTenant: vi.fn(),
    prepareBinding: vi.fn(),
    prepareIssue: vi.fn(),
    lockLifecycle: vi.fn(),
    evidenceRecord: vi.fn(),
    revalidatePath: vi.fn(),
    emitN8nEvent: vi.fn(),
    sendTemplateMail: vi.fn(),
    fireAndForget: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: m.sendTemplateMail }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: m.fireAndForget }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/gwg-onboarding/service', () => ({
  generateInviteToken: () => ({ raw: 'raw-token', hash: 'token-hash' }),
  INVITE_TTL_DAYS: 14,
}));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({
  prepareGwgInviteIssueTx: m.prepareIssue,
}));
vi.mock('@/server/gwg-onboarding/invite-binding', () => ({
  prepareGwgInviteBindingTx: m.prepareBinding,
}));
vi.mock('@/server/gwg/reverification', () => ({
  lockGwgCheckLifecycleTx: m.lockLifecycle,
}));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: m.assertClientInTenant,
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler.',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: m.staffActionGuard,
  withStaff: m.withStaff,
  ActionError: m.ActionError,
}));

import { cancelInviteAction, sendInviteAction } from '../invite-actions';

const staffContext = {
  tenantId: 'tenant-1',
  staffId: 'staff-1',
  session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    ...staffContext,
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
});

describe('GwG-Einladungen — mandanteninterne Zugriffskontrolle', () => {
  it('sendet bei gleichem Tenant ohne Mandantenzugriff keine Einladung', async () => {
    const tx = {
      gwgOnboardingInvite: { create: vi.fn() },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (transaction: typeof tx) => unknown) => callback(tx),
    );
    m.assertClientAccessTx.mockRejectedValueOnce(new Error('Kein Zugriff auf diesen Mandanten.'));

    const result = await sendInviteAction({
      clientId: CLIENT_ID,
      inviteName: 'Rey Koxha',
      inviteEmail: 'rey@example.test',
    });

    expect(result).toEqual({ ok: false, error: 'Kein Zugriff auf diesen Mandanten.' });
    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, staffContext.session, CLIENT_ID);
    expect(m.assertClientInTenant).not.toHaveBeenCalled();
    expect(m.prepareBinding).not.toHaveBeenCalled();
    expect(tx.gwgOnboardingInvite.create).not.toHaveBeenCalled();
  });

  it('zieht bei gleichem Tenant ohne Mandantenzugriff keine Einladung zurück', async () => {
    const tx = {
      gwgOnboardingInvite: {
        findUnique: vi.fn().mockResolvedValue({ id: INVITE_ID, clientId: CLIENT_ID }),
        updateMany: vi.fn(),
      },
    };
    m.withStaff.mockImplementation(
      async (callback: (transaction: typeof tx, context: typeof staffContext) => unknown) => {
        try {
          await callback(tx, staffContext);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    );
    m.assertClientAccessTx.mockRejectedValueOnce(new Error('Kein Zugriff auf diesen Mandanten.'));

    const result = await cancelInviteAction({ id: INVITE_ID });

    expect(result).toEqual({ ok: false, error: 'Kein Zugriff auf diesen Mandanten.' });
    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, staffContext.session, CLIENT_ID);
    expect(m.lockLifecycle).not.toHaveBeenCalled();
    expect(tx.gwgOnboardingInvite.updateMany).not.toHaveBeenCalled();
  });

  it('wartet den Outbox-Write ab und koppelt ihn nicht an den best-effort Mailversand', async () => {
    let resolveOutbox!: (value: {
      eventId: string;
      status: 'PENDING';
      deliveryCount: number;
    }) => void;
    const outboxPending = new Promise<{
      eventId: string;
      status: 'PENDING';
      deliveryCount: number;
    }>((resolve) => {
      resolveOutbox = resolve;
    });
    m.emitN8nEvent.mockReturnValue(outboxPending);
    m.sendTemplateMail.mockResolvedValue({ ok: false, sentViaTemplate: false });
    m.prepareBinding.mockResolvedValue({
      ok: true,
      gwgCheckId: null,
      boundCheckRevision: null,
      boundClientRevision: 'client-revision',
    });
    m.prepareIssue.mockResolvedValue({ createdAt: new Date(), supersededInviteCount: 0 });
    const tx = {
      gwgOnboardingInvite: {
        create: vi.fn().mockResolvedValue({ id: INVITE_ID }),
      },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (transaction: typeof tx) => unknown) => callback(tx),
    );

    let settled = false;
    const action = sendInviteAction({
      clientId: CLIENT_ID,
      inviteName: 'Rey Koxha',
      inviteEmail: 'rey@example.test',
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(m.emitN8nEvent).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(m.sendTemplateMail).not.toHaveBeenCalled();

    resolveOutbox({ eventId: 'event-1', status: 'PENDING', deliveryCount: 1 });
    await expect(action).resolves.toEqual({
      ok: true,
      link: expect.stringContaining('/gwg-onboarding?token='),
    });
    expect(m.emitN8nEvent).toHaveBeenCalledWith(
      'gwg.invite.created',
      {
        tenantId: 'tenant-1',
        clientId: CLIENT_ID,
        gwgInviteId: INVITE_ID,
        gwgCheckId: null,
      },
      { tenantId: 'tenant-1' },
    );
    expect(m.fireAndForget).toHaveBeenCalledOnce();
  });
});
