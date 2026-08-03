import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Erledigen / Zurückholen / Priorität.
//
// Kern der Änderung: Die Checkbox war eine Einbahnstraße. Jetzt geht die
// Rückmeldung an die delegierende Person VERZÖGERT raus (Job), und das
// Zurückholen nimmt sie zurück — im Fenster erfährt niemand davon.
// =============================================================================

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    withStaff: vi.fn(),
    evidenceRecord: vi.fn(),
    notify: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
    assertClientAccessTx: vi.fn(),
    isStaffAdmin: vi.fn().mockReturnValue(false),
    ActionError,
  };
});

vi.mock('@/server/actions/staff-action', () => ({
  withStaff: m.withStaff,
  ActionError: m.ActionError,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/notifications/service', () => ({ notify: m.notify }));
vi.mock('@/server/jobs/reminder-done-queue', () => ({
  scheduleReminderDoneNotification: m.schedule,
  cancelReminderDoneNotification: m.cancel,
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  isStaffAdmin: m.isStaffAdmin,
}));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: vi.fn(),
  assertStaffInTenant: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  markReminderDoneAction,
  reopenReminderAction,
  setReminderPriorityAction,
} from '../actions';

const ICH = '11111111-1111-4111-8111-111111111111';
const DELEGIERT_VON = '22222222-2222-4222-8222-222222222222';
const REMINDER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';

/** Bildet withStaff nach: fuehrt den Callback mit Stub-Tx aus. */
function stubWithStaff(reminder: Record<string, unknown> | null) {
  const tx = {
    clientReminder: {
      findUnique: vi.fn().mockResolvedValue(reminder),
      update: vi.fn().mockResolvedValue({}),
    },
    staffUser: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Maria Mitarbeiterin' }) },
  };
  m.withStaff.mockImplementation(async (fn: (t: unknown, c: unknown) => Promise<unknown>) => {
    const data = await fn(tx, {
      tenantId: 'tenant',
      staffId: ICH,
      session: { user: { staffId: ICH } },
    });
    return { ok: true, ...(data ?? {}) };
  });
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.schedule.mockResolvedValue(true);
  m.isStaffAdmin.mockReturnValue(false);
});

describe('markReminderDoneAction', () => {
  it('plant die Rückmeldung VERZÖGERT ein statt sofort zu benachrichtigen', async () => {
    const tx = stubWithStaff({
      clientId: CLIENT,
      subject: 'Risiko-Recherche: Bargeschäfte',
      createdByStaff: DELEGIERT_VON,
      doneAt: null,
    });

    await markReminderDoneAction({ id: REMINDER });

    expect(tx.clientReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ doneByStaff: ICH }) }),
    );
    expect(m.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: REMINDER, staffId: DELEGIERT_VON }),
    );
    // Nichts geht sofort raus — sonst waere das Zurueckholen wertlos.
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('benachrichtigt sofort, wenn das Einplanen scheitert (Redis weg)', async () => {
    stubWithStaff({
      clientId: CLIENT,
      subject: 'Test',
      createdByStaff: DELEGIERT_VON,
      doneAt: null,
    });
    m.schedule.mockResolvedValue(false);

    await markReminderDoneAction({ id: REMINDER });

    // Die Rueckmeldung still zu verlieren waere schlimmer als eine sofortige.
    expect(m.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'CLIENT_REMINDER_DONE', staffId: DELEGIERT_VON }),
    );
  });

  it('schickt keine Rückmeldung, wenn man die eigene Notiz abhakt', async () => {
    stubWithStaff({ clientId: CLIENT, subject: 'Eigene Notiz', createdByStaff: ICH, doneAt: null });

    await markReminderDoneAction({ id: REMINDER });

    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('ist idempotent — bereits erledigt schreibt nicht erneut', async () => {
    const tx = stubWithStaff({
      clientId: CLIENT,
      subject: 'Test',
      createdByStaff: DELEGIERT_VON,
      doneAt: new Date(),
    });

    await markReminderDoneAction({ id: REMINDER });

    expect(tx.clientReminder.update).not.toHaveBeenCalled();
    expect(m.schedule).not.toHaveBeenCalled();
  });
});

describe('reopenReminderAction', () => {
  it('setzt zurück und nimmt die eingeplante Rückmeldung mit', async () => {
    const tx = stubWithStaff({ clientId: CLIENT, doneAt: new Date() });

    await reopenReminderAction({ id: REMINDER });

    expect(tx.clientReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { doneAt: null, doneByStaff: null } }),
    );
    expect(m.cancel).toHaveBeenCalledWith(REMINDER);
  });

  it('ist idempotent — eine offene Wiedervorlage bleibt unberührt', async () => {
    const tx = stubWithStaff({ clientId: CLIENT, doneAt: null });

    await reopenReminderAction({ id: REMINDER });

    expect(tx.clientReminder.update).not.toHaveBeenCalled();
  });
});

describe('setReminderPriorityAction', () => {
  it('lässt die delegierende Person hochstufen', async () => {
    const tx = stubWithStaff({ clientId: CLIENT, createdByStaff: ICH, priority: 'NORMAL' });

    const r = await setReminderPriorityAction({ id: REMINDER, priority: 'URGENT' });

    expect(r.ok).toBe(true);
    expect(tx.clientReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { priority: 'URGENT' } }),
    );
  });

  it('verweigert es der zugewiesenen Person — sonst stuft sie sich selbst herunter', async () => {
    const tx = stubWithStaff({
      clientId: CLIENT,
      createdByStaff: DELEGIERT_VON,
      priority: 'URGENT',
    });

    await expect(
      setReminderPriorityAction({ id: REMINDER, priority: 'LOW' }),
    ).rejects.toBeInstanceOf(m.ActionError);
    expect(tx.clientReminder.update).not.toHaveBeenCalled();
  });

  it('erlaubt Admin/Partner auch fremde Aufträge', async () => {
    m.isStaffAdmin.mockReturnValue(true);
    const tx = stubWithStaff({
      clientId: CLIENT,
      createdByStaff: DELEGIERT_VON,
      priority: 'NORMAL',
    });

    await setReminderPriorityAction({ id: REMINDER, priority: 'HIGH' });

    expect(tx.clientReminder.update).toHaveBeenCalled();
  });
});
