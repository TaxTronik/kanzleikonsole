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
    filterStaffAccessClientTx: vi.fn(),
    isStaffAdmin: vi.fn().mockReturnValue(false),
    ActionError,
  };
});

vi.mock('@/server/actions/staff-action', () => ({
  withStaff: m.withStaff,
  withStaffModule: () => m.withStaff,
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
  filterStaffAccessClientTx: m.filterStaffAccessClientTx,
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
  archiveReminderAction,
  restoreReminderAction,
  deleteReminderAction,
  addReminderNoteAction,
  setReminderAssigneesAction,
  submitResearchResultAction,
} from '../actions';

const ICH = '11111111-1111-4111-8111-111111111111';
const DELEGIERT_VON = '22222222-2222-4222-8222-222222222222';
const REMINDER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';

/** Bildet withStaff nach: fuehrt den Callback mit Stub-Tx aus. */
function stubWithStaff(reminder: Record<string, unknown> | null) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    clientReminder: {
      findUnique: vi.fn().mockResolvedValue(reminder),
      findFirst: vi
        .fn()
        .mockResolvedValue(
          reminder
            ? { ...reminder, doneAt: new Date(), clientId: reminder['clientId'] ?? null }
            : null,
        ),
      update: vi.fn().mockResolvedValue({}),
    },
    notification: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
  m.filterStaffAccessClientTx.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) => new Set(ids),
  );
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

  it('unterdrueckt auch den Redis-Fallback nach spaeterem Entzug des Mandantenzugriffs', async () => {
    stubWithStaff({
      clientId: CLIENT,
      subject: 'Vertraulicher Inhalt',
      createdByStaff: DELEGIERT_VON,
      doneAt: null,
    });
    m.schedule.mockResolvedValue(false);
    m.filterStaffAccessClientTx.mockResolvedValue(new Set());

    await markReminderDoneAction({ id: REMINDER });

    expect(m.notify).not.toHaveBeenCalled();
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

describe('REMINDER-TICKET-001 / TAX-CONTROL-STATUS-001 — Archiv statt Löschung', () => {
  it.each([archiveReminderAction, restoreReminderAction, deleteReminderAction])(
    'weist ungültige Ticketkennungen mit Feldzuordnung vor dem Zugriff zurück',
    async (action) => {
      const result = await action({ id: 'invalid' });
      expect(result).toMatchObject({ ok: false, errorCode: 'VALIDATION_ERROR' });
      expect(result.fieldErrors?.id).toEqual([expect.any(String)]);
      expect(m.withStaff).not.toHaveBeenCalled();
    },
  );
  const completed = () => ({
    clientId: CLIENT,
    subject: 'Auftrag',
    createdByStaff: ICH,
    assignees: [],
    doneAt: new Date('2026-09-01'),
    doneByStaff: ICH,
    archivedAt: null,
  });

  it.each([{ doneAt: null }, { doneByStaff: null }])(
    'lehnt unvollständigen Abschluss ab: %j',
    async (missing) => {
      const tx = stubWithStaff({ ...completed(), ...missing });
      await expect(archiveReminderAction({ id: REMINDER })).rejects.toThrow(
        'dokumentiertem Abschluss',
      );
      expect(tx.clientReminder.update).not.toHaveBeenCalled();
      expect(m.evidenceRecord).not.toHaveBeenCalled();
    },
  );

  it('sperrt Archiv und Restore für bloß zugewiesene Personen', async () => {
    const tx = stubWithStaff({
      ...completed(),
      createdByStaff: DELEGIERT_VON,
      assignees: [{ staffId: ICH }],
    });
    await expect(archiveReminderAction({ id: REMINDER })).rejects.toThrow(
      'Nur die anlegende Person',
    );
    await expect(restoreReminderAction({ id: REMINDER })).rejects.toThrow(
      'Nur die anlegende Person',
    );
    expect(tx.clientReminder.update).not.toHaveBeenCalled();
  });

  it('Legacy-delete archiviert; Restore behält den ursprünglichen Abschluss', async () => {
    const reminder = completed();
    const tx = stubWithStaff(reminder);
    tx.clientReminder.update.mockImplementation(async ({ data }) => {
      Object.assign(reminder, data);
      return reminder;
    });
    const doneAt = reminder.doneAt;
    await deleteReminderAction({ id: REMINDER });
    expect(reminder.archivedAt).toBeInstanceOf(Date);
    expect(tx.clientReminder.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { archivedAt: expect.any(Date), archivedByStaff: ICH } }),
    );
    await restoreReminderAction({ id: REMINDER });
    expect(reminder.archivedAt).toBeNull();
    expect(reminder.doneAt).toBe(doneAt);
    expect(reminder.doneByStaff).toBe(ICH);
    expect(m.evidenceRecord.mock.calls.map((call) => call[1].action)).toEqual([
      'client_reminder.archive',
      'client_reminder.restore',
    ]);
    expect(m.cancel).toHaveBeenCalledWith(REMINDER);
  });

  it('lässt Admin/Partner fremde erledigte Tickets archivieren', async () => {
    m.isStaffAdmin.mockReturnValue(true);
    const tx = stubWithStaff({ ...completed(), createdByStaff: DELEGIERT_VON });
    await archiveReminderAction({ id: REMINDER });
    expect(tx.clientReminder.update).toHaveBeenCalled();
  });

  it.each([
    ['erledigen', () => markReminderDoneAction({ id: REMINDER })],
    ['öffnen', () => reopenReminderAction({ id: REMINDER })],
    ['priorisieren', () => setReminderPriorityAction({ id: REMINDER, priority: 'HIGH' })],
    ['kommentieren', () => addReminderNoteAction({ id: REMINDER, body: 'Kommentar' })],
    ['zuweisen', () => setReminderAssigneesAction({ id: REMINDER, staffIds: [ICH] })],
    [
      'Recherche abgeben',
      () =>
        submitResearchResultAction({ reminderId: REMINDER, clientId: CLIENT, body: 'Ergebnis' }),
    ],
  ])('Archiv verhindert %s vor jeglicher Mutation', async (_label, action) => {
    const tx = stubWithStaff({ ...completed(), archivedAt: new Date() });
    await expect(action()).rejects.toThrow('Archivierte Tickets');
    expect(tx.clientReminder.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('liest nach einem parallelen Wiederöffnen neu und archiviert den nun offenen Vorgang nicht', async () => {
    const reminder = completed();
    const tx = stubWithStaff(reminder);
    let release!: () => void;
    tx.$queryRaw.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running = archiveReminderAction({ id: REMINDER });
    expect(tx.clientReminder.findUnique).not.toHaveBeenCalled();
    Object.assign(reminder, { doneAt: null, doneByStaff: null });
    const rejected = expect(running).rejects.toThrow('dokumentiertem Abschluss');
    release();
    await rejected;
    expect(tx.clientReminder.update).not.toHaveBeenCalled();
  });
});
