import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Verzögerte „Wiedervorlage erledigt"-Rückmeldung.
//
// Der Job läuft ~10 s nach dem Erledigen. Entscheidend ist der Nachcheck: Wurde
// die Wiedervorlage zwischenzeitlich zurückgeholt, darf NICHTS rausgehen — auch
// wenn der Job bereits gesperrt war und `remove` deshalb nicht mehr griff. Die
// Datenbank ist die Wahrheit, nicht der Job.
// =============================================================================

const h = vi.hoisted(() => ({
  upsertNotificationTx: vi.fn(),
  findFirst: vi.fn(),
  filterStaffAccessClientTx: vi.fn(),
  moduleEnabled: vi.fn(),
  lock: vi.fn(),
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db/notification', () => ({
  upsertNotificationTx: h.upsertNotificationTx,
}));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: h.filterStaffAccessClientTx,
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: h.lock, clientReminder: { findFirst: h.findFirst } }),
}));
vi.mock('../../module-gate', () => ({
  isWorkerTenantModuleEnabled: h.moduleEnabled,
}));

import { processors } from './mocks/bullmq';
import '../reminder-done-notify';

const JOB = {
  data: {
    tenantId: 'tenant-1',
    reminderId: 'rem-1',
    staffId: 'partner-1',
    clientId: 'client-1',
    subject: 'Risiko-Recherche: Bargeschäfte',
    doneByName: 'Maria Mitarbeiterin',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.moduleEnabled.mockResolvedValue(true);
  h.filterStaffAccessClientTx.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) => new Set(ids),
  );
});

describe('reminder-done-notify', () => {
  it('REMINDER-TICKET-001: liest nach dem Archiv-Lock neu und unterdrückt überholte Jobs', async () => {
    let release!: () => void;
    h.lock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running = processors.get('reminder-done-notify')!(JOB);
    await vi.waitFor(() => expect(h.lock).toHaveBeenCalled());
    expect(h.findFirst).not.toHaveBeenCalled();
    h.findFirst.mockResolvedValue({
      doneAt: new Date(),
      archivedAt: new Date(),
      clientId: 'client-1',
      subject: 'Archiv',
    });
    release();
    await running;
    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });
  it('überspringt den direkten Job-Einstieg bei deaktivierten Wiedervorlagen', async () => {
    h.moduleEnabled.mockResolvedValue(false);

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });

  it('stellt zu, wenn die Wiedervorlage noch erledigt ist', async () => {
    h.findFirst.mockResolvedValue({
      doneAt: new Date(),
      clientId: 'client-current',
      subject: 'Aktueller Titel',
    });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.upsertNotificationTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'CLIENT_REMINDER_DONE',
        staffId: 'partner-1',
        resourceId: 'rem-1',
        href: '/staff/clients/client-current',
        title: 'Wiedervorlage erledigt: Aktueller Titel',
      }),
    );
  });

  it('verwirft einen gequeueten Empfaenger nach OPEN→RESTRICTED/Vertraulich-Umschaltung', async () => {
    h.findFirst.mockResolvedValue({
      doneAt: new Date(),
      clientId: 'client-1',
      subject: 'Vertraulicher Titel',
    });
    h.filterStaffAccessClientTx.mockResolvedValue(new Set());

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.filterStaffAccessClientTx).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      ['partner-1'],
      'client-1',
    );
    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });

  it('stellt NICHT zu, wenn zwischenzeitlich zurückgeholt wurde', async () => {
    h.findFirst.mockResolvedValue({ doneAt: null, clientId: 'client-1', subject: 'Test' });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });

  it('stellt NICHT zu, wenn die Wiedervorlage gelöscht wurde', async () => {
    h.findFirst.mockResolvedValue(null);

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });
});
