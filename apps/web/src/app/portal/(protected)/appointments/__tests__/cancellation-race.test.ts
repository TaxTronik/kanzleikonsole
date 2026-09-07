import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withPortal: vi.fn(),
    resolveNotifications: vi.fn(),
    evidence: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveClientContactNotificationsTx: h.resolveNotifications,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidence } }));
vi.mock('@/server/notifications/service', () => ({ notify: vi.fn() }));
vi.mock('@/server/settings/portal-features', () => ({ assertPortalFeature: vi.fn() }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({
  canOtherStaffAccessClientTx: vi.fn(),
  toActionError: vi.fn(),
}));
vi.mock('@/server/actions/portal-action', () => ({
  ActionError: h.ActionError,
  portalActionGuard: vi.fn(),
  withPortalModule: () => h.withPortal,
}));

import { cancelAppointmentRequestAction } from '../actions';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const context = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  contactId: '44444444-4444-4444-8444-444444444444',
  clientId: CLIENT_ID,
};

type Status = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';

// ACCESS-TENANT-RLS-001 / ACCESS-NOTIFICATION-RECIPIENT-001:
// Exercise the actual action with a stateful persistence boundary. An accepted
// request retains its existing appointment; a losing cancellation emits nothing.
describe('Portal-Terminanfrage: überlappender Abbruch', () => {
  let row: {
    clientId: string;
    status: Status;
    acceptedAppointmentId: string | null;
    decidedAt: Date | null;
  };
  let afterRead: () => void | Promise<void>;
  const write = ({
    where,
    data,
  }: {
    where: { id: string; clientId?: string; status?: Status };
    data: { status: Status; decidedAt: Date };
  }) => {
    if (where.id !== REQUEST_ID || (where.clientId && where.clientId !== row.clientId)) {
      return { count: 0 };
    }
    if (where.status && where.status !== row.status) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  };
  const tx = {
    appointmentRequest: {
      findUnique: vi.fn(async () => {
        const snapshot = { clientId: row.clientId, status: row.status };
        await afterRead();
        return snapshot;
      }),
      update: vi.fn(write),
      updateMany: vi.fn(write),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    row = { clientId: CLIENT_ID, status: 'PENDING', acceptedAppointmentId: null, decidedAt: null };
    afterRead = () => {};
    h.withPortal.mockImplementation(async (run: (tx: unknown, ctx: unknown) => Promise<void>) => {
      try {
        await run(tx, context);
        return { ok: true };
      } catch (error) {
        if (error instanceof h.ActionError) return { ok: false, error: error.message };
        throw error;
      }
    });
  });

  it.each(['ACCEPTED', 'REJECTED', 'CANCELLED'] as const)(
    'überschreibt eine nach dem Lesen abgeschlossene Entscheidung %s nicht',
    async (status) => {
      const decisionTime = new Date('2026-09-07T09:00:00Z');
      afterRead = () => {
        row.status = status;
        row.decidedAt = decisionTime;
        row.acceptedAppointmentId = status === 'ACCEPTED' ? 'existing-appointment' : null;
      };

      await expect(cancelAppointmentRequestAction({ id: REQUEST_ID })).resolves.toEqual({
        ok: false,
        error: 'Anfrage ist nicht mehr offen.',
      });
      expect(row.status).toBe(status);
      expect(row.decidedAt).toBe(decisionTime);
      expect(row.acceptedAppointmentId).toBe(status === 'ACCEPTED' ? 'existing-appointment' : null);
      expect(h.resolveNotifications).not.toHaveBeenCalled();
      expect(h.evidence).not.toHaveBeenCalled();
    },
  );

  it('verbucht zwei gleichzeitig gestartete Abbrüche genau einmal', async () => {
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterRead = async () => {
      if (++reads === 2) release();
      await bothRead;
    };

    const results = await Promise.all([
      cancelAppointmentRequestAction({ id: REQUEST_ID }),
      cancelAppointmentRequestAction({ id: REQUEST_ID }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(row.status).toBe('CANCELLED');
    expect(h.resolveNotifications).toHaveBeenCalledTimes(1);
    expect(h.evidence).toHaveBeenCalledTimes(1);
  });

  it('bricht eine weiterhin offene eigene Anfrage ab und zeichnet den Erfolg auf', async () => {
    await expect(cancelAppointmentRequestAction({ id: REQUEST_ID })).resolves.toEqual({ ok: true });
    expect(row.status).toBe('CANCELLED');
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(h.resolveNotifications).toHaveBeenCalledWith(tx, {
      tenantId: context.tenantId,
      resourceType: 'appointment_request',
      resourceId: REQUEST_ID,
    });
    expect(h.evidence).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: context.contactId,
        action: 'appointment_request.cancel',
        resourceId: REQUEST_ID,
      }),
    );
  });

  it('verändert weder eine fremde noch eine bereits entschiedene Anfrage', async () => {
    row.clientId = 'another-client';
    await expect(cancelAppointmentRequestAction({ id: REQUEST_ID })).resolves.toMatchObject({
      ok: false,
    });
    row.clientId = CLIENT_ID;
    row.status = 'ACCEPTED';
    await expect(cancelAppointmentRequestAction({ id: REQUEST_ID })).resolves.toMatchObject({
      ok: false,
    });
    expect(tx.appointmentRequest.update).not.toHaveBeenCalled();
    expect(tx.appointmentRequest.updateMany).not.toHaveBeenCalled();
    expect(h.evidence).not.toHaveBeenCalled();
  });
});
