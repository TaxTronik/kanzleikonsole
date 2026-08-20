import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    currentTx: null as unknown,
    withStaff: vi.fn(),
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    resolveNotificationsTx: vi.fn(),
    evidenceRecord: vi.fn(),
    notify: vi.fn(),
    notifyMany: vi.fn(),
    sendTemplateMail: vi.fn(),
    fireAndForget: vi.fn(),
    assertClientAccessTx: vi.fn(),
    assertClientInTenant: vi.fn(),
    assertStaffInTenant: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/notifications/service', () => ({ notify: h.notify, notifyMany: h.notifyMany }));
vi.mock('@/server/mail/dispatch', () => ({
  sendTemplateMail: h.sendTemplateMail,
}));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: h.fireAndForget }));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: h.assertClientInTenant,
  assertStaffInTenant: h.assertStaffInTenant,
}));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: () => true,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler.',
  }),
  assertClientAccessTx: h.assertClientAccessTx,
}));
vi.mock('@/server/actions/staff-action', () => {
  return {
    ActionError: h.ActionError,
    withStaff: h.withStaff,
    staffActionGuard: h.staffActionGuard,
    parseFormData: (
      schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
      formData: FormData,
    ) => {
      const parsed = schema.safeParse(Object.fromEntries(formData));
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, error: 'Validierungsfehler.' };
    },
  };
});

import {
  cancelVacationAction,
  decideVacationAction,
} from '@/app/staff/(protected)/absences/actions';
import { updateAppointmentAction } from '@/app/staff/(protected)/calendar/actions';
import { updateHandoverStatusAction } from '@/app/staff/(protected)/clients/[id]/handovers/actions';
import { forwardPhoneNoteAction } from '@/app/staff/(protected)/phone-notes/actions';

const UUID = '11111111-1111-4111-8111-111111111111';
const OLD_STAFF = '22222222-2222-4222-8222-222222222222';
const NEW_STAFF = '33333333-3333-4333-8333-333333333333';

function staffContext() {
  return {
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: {},
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  };
}

describe('fachliche Lifecycle-Guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withStaff.mockImplementation(async (run: (tx: unknown, ctx: unknown) => unknown) => {
      try {
        const data = await run(h.currentTx, staffContext());
        return { ok: true, ...(data ?? {}) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Fehler.' };
      }
    });
    h.staffActionGuard.mockResolvedValue({ ok: true, ...staffContext() });
    h.withTenantContext.mockImplementation(async (_ctx: unknown, run: (tx: unknown) => unknown) =>
      run(h.currentTx),
    );
    h.resolveNotificationsTx.mockResolvedValue(1);
    h.evidenceRecord.mockResolvedValue(undefined);
    h.notify.mockResolvedValue(undefined);
    h.sendTemplateMail.mockResolvedValue({ ok: true, sentViaTemplate: true });
  });

  it('entscheidet einen bereits entschiedenen Urlaubsantrag nicht erneut', async () => {
    const tx = {
      vacationRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: UUID,
          tenantId: 'tenant-1',
          staffId: OLD_STAFF,
          status: 'APPROVED',
        }),
        updateMany: vi.fn(),
      },
    };
    h.currentTx = tx;
    const formData = new FormData();
    formData.set('requestId', UUID);
    formData.set('approve', '1');

    await decideVacationAction(formData);

    expect(tx.vacationRequest.updateMany).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('erlaubt die ausdrückliche Rücknahme eines genehmigten Urlaubs', async () => {
    const tx = {
      vacationRequest: {
        findFirst: vi.fn().mockResolvedValue({
          id: UUID,
          tenantId: 'tenant-1',
          staffId: 'staff-1',
          status: 'APPROVED',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    h.currentTx = tx;
    const formData = new FormData();
    formData.set('requestId', UUID);

    await cancelVacationAction(formData);

    expect(tx.vacationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: UUID, status: 'APPROVED' },
      data: { status: 'CANCELLED' },
    });
  });

  it('leitet einen Telefonzettel nicht erneut an dieselbe Person weiter', async () => {
    const tx = {
      phoneNote: {
        findUnique: vi.fn().mockResolvedValue({
          forwardToStaff: NEW_STAFF,
          subject: 'Rückruf',
          callerName: 'Mara',
          callerPhone: null,
          doneAt: null,
          clientId: null,
        }),
        updateMany: vi.fn(),
      },
    };
    h.currentTx = tx;

    const result = await forwardPhoneNoteAction({ id: UUID, toStaffId: NEW_STAFF });

    expect(result.ok).toBe(true);
    expect(tx.phoneNote.updateMany).not.toHaveBeenCalled();
    expect(h.resolveNotificationsTx).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('verschiebt eine Termin-Notification vom alten zum neuen Verantwortlichen', async () => {
    const tx = {
      appointment: {
        findUnique: vi.fn().mockResolvedValue({
          title: 'Besprechung',
          startsAt: new Date('2026-08-21T08:00:00.000Z'),
          endsAt: new Date('2026-08-21T09:00:00.000Z'),
          status: 'CONFIRMED',
          clientId: 'client-1',
          ownerStaffId: OLD_STAFF,
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    h.currentTx = tx;
    const formData = new FormData();
    formData.set('id', UUID);
    formData.set('title', 'Besprechung');
    formData.set('ownerStaffId', NEW_STAFF);
    formData.set('clientId', '44444444-4444-4444-8444-444444444444');
    formData.set('kind', 'CLIENT_MEETING');
    formData.set('status', 'CONFIRMED');
    formData.set('startsAt', '2026-08-21T10:00');
    formData.set('endsAt', '2026-08-21T11:00');

    await updateAppointmentAction(null, formData);

    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ staffIds: [OLD_STAFF] }),
    );
    expect(h.notify).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ staffId: NEW_STAFF, resourceId: UUID }),
    );
  });

  it('versendet die Abholbereitschaft nach einem Statuswechsel nicht ein zweites Mal', async () => {
    const tx = {
      clientHandover: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'IN_PROGRESS',
          clientId: 'client-1',
          label: 'Ordner 2025',
          notifiedContactEmail: 'kontakt@example.de',
          client: {
            name: 'Mandant GmbH',
            contacts: [{ fullName: 'Mara Mandant', email: 'kontakt@example.de' }],
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    h.currentTx = tx;

    const result = await updateHandoverStatusAction({ id: UUID, status: 'READY' });

    expect(result).toEqual({ ok: true });
    expect(tx.clientHandover.updateMany).toHaveBeenCalledTimes(1);
    expect(h.sendTemplateMail).not.toHaveBeenCalled();
  });
});
