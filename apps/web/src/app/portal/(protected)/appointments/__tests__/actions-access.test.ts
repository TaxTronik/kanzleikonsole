import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    portalActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    assertPortalFeature: vi.fn(),
    checkRateLimit: vi.fn(),
    canOtherStaffAccessClientTx: vi.fn(),
    evidenceRecord: vi.fn(),
    notify: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/notifications/service', () => ({ notify: h.notify }));
vi.mock('@/server/settings/portal-features', () => ({
  assertPortalFeature: h.assertPortalFeature,
}));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock('@/server/auth/rbac', () => ({
  canOtherStaffAccessClientTx: h.canOtherStaffAccessClientTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler.',
  }),
}));
vi.mock('@/server/actions/portal-action', () => ({
  ActionError: h.ActionError,
  portalActionGuard: h.portalActionGuard,
  withPortalModule: () => vi.fn(),
}));

import { createAppointmentRequestAction } from '../actions';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const STAFF_ID = '44444444-4444-4444-8444-444444444444';

function formData(): FormData {
  const value = new FormData();
  value.set('subject', 'Nicht vertrauliche Rückfrage');
  value.set('preferredStaffId', STAFF_ID);
  value.set('slot0_starts', '2099-08-25T10:00');
  value.set('slot0_ends', '2099-08-25T11:00');
  return value;
}

describe('Portal-Terminanfrage: serverseitige Zielprüfung', () => {
  const tx = {
    appointmentRequest: { create: vi.fn() },
    clientResponsibility: { findMany: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.portalActionGuard.mockResolvedValue({
      ok: true,
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      clientId: CLIENT_ID,
      ctx: { tenantId: TENANT_ID, actorId: CONTACT_ID, actorType: 'CLIENT_CONTACT' },
    });
    h.checkRateLimit.mockResolvedValue({ ok: true });
    h.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (transaction: typeof tx) => unknown) => run(tx),
    );
    h.assertPortalFeature.mockResolvedValue(undefined);
    h.evidenceRecord.mockResolvedValue(undefined);
    h.notify.mockResolvedValue(undefined);
    tx.appointmentRequest.create.mockResolvedValue({ id: 'request-1' });
  });

  it('lehnt eine manipulierte Person ohne Mandantenzugriff vor Persistenz und Notification ab', async () => {
    h.canOtherStaffAccessClientTx.mockResolvedValue(false);

    await expect(createAppointmentRequestAction(null, formData())).resolves.toEqual({
      ok: false,
      error: 'Die ausgewählte Person ist für diesen Mandanten nicht verfügbar.',
    });

    expect(h.canOtherStaffAccessClientTx).toHaveBeenCalledWith(tx, TENANT_ID, STAFF_ID, CLIENT_ID);
    expect(tx.appointmentRequest.create).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('erlaubt eine von der OPEN-Policy freigegebene aktive Person ohne Zuständigkeitsrelation', async () => {
    h.canOtherStaffAccessClientTx.mockResolvedValue(true);

    await expect(createAppointmentRequestAction(null, formData())).resolves.toEqual({
      ok: true,
      id: 'request-1',
    });

    expect(tx.appointmentRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        preferredStaffId: STAFF_ID,
      }),
    });
    expect(h.notify).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ staffId: STAFF_ID, resourceId: 'request-1' }),
    );
  });
});
