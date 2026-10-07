import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Verzögerte „Wiedervorlage erledigt"-Rückmeldung.
//
// Der Job läuft ~10 s nach dem Erledigen. Entscheidend ist der Nachcheck: Wurde
// die Wiedervorlage zwischenzeitlich zurückgeholt, darf NICHTS rausgehen — auch
// wenn der Job bereits gesperrt war und `remove` deshalb nicht mehr griff. Die
// Datenbank ist die Wahrheit, nicht der Job.
//
// S-06 (Folgearbeit): Der Job trägt nur IDs; Betreff, Mandant und den Namen
// der erledigenden Person liest der Worker beim Zustellen. Jobs der Vorversion
// (mit Betreff/Namen) werden weiter verarbeitet, aber mit den DB-Werten.
// =============================================================================

const h = vi.hoisted(() => ({
  notify: vi.fn(),
  findFirst: vi.fn(),
  staffFindFirst: vi.fn(),
  filterStaffAccessClientTx: vi.fn(),
  moduleEnabled: vi.fn(),
  lock: vi.fn(),
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// R-11: der Job schreibt über notify(tx, input).
vi.mock('../../notify', () => ({ notify: h.notify }));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: h.filterStaffAccessClientTx,
}));
// S-01: der Job läuft über die App-Rolle (withSystemContext aus @taxtronik/db).
vi.mock('@taxtronik/db', () => ({
  withSystemContext: (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $queryRaw: h.lock,
      clientReminder: { findFirst: h.findFirst },
      staffUser: { findFirst: h.staffFindFirst },
    }),
}));
vi.mock('../../module-gate', () => ({
  isWorkerTenantModuleEnabled: h.moduleEnabled,
}));

import { processors } from './mocks/bullmq';
import '../reminder-done-notify';

const JOB = { data: { tenantId: 'tenant-1', reminderId: 'rem-1', staffId: 'partner-1' } };
/** Auftrag der Vorversion: Betreff und Name lagen in Redis. */
const LEGACY_JOB = {
  data: {
    ...JOB.data,
    clientId: 'client-1',
    subject: 'Alter Betreff aus Redis',
    doneByName: 'Alter Name aus Redis',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.moduleEnabled.mockResolvedValue(true);
  h.filterStaffAccessClientTx.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) => new Set(ids),
  );
  h.staffFindFirst.mockResolvedValue({ fullName: 'Maria Mitarbeiterin' });
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
    expect(h.notify).not.toHaveBeenCalled();
  });
  it('überspringt den direkten Job-Einstieg bei deaktivierten Wiedervorlagen', async () => {
    h.moduleEnabled.mockResolvedValue(false);

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('stellt zu, wenn die Wiedervorlage noch erledigt ist (Betreff und Name aus der DB)', async () => {
    h.findFirst.mockResolvedValue({
      doneAt: new Date(),
      doneByStaff: 'staff-done',
      clientId: 'client-current',
      subject: 'Aktueller Titel',
    });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.staffFindFirst).toHaveBeenCalledWith({
      where: { id: 'staff-done', tenantId: 'tenant-1' },
      select: { fullName: true },
    });
    expect(h.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'CLIENT_REMINDER_DONE',
        staffId: 'partner-1',
        resourceId: 'rem-1',
        href: '/staff/clients/client-current',
        title: 'Wiedervorlage erledigt: Aktueller Titel',
        body: 'Maria Mitarbeiterin hat die von dir delegierte Wiedervorlage abgeschlossen.',
      }),
    );
  });

  it('verarbeitet einen Auftrag der Vorversion mit den aktuellen DB-Werten', async () => {
    h.findFirst.mockResolvedValue({
      doneAt: new Date(),
      doneByStaff: 'staff-done',
      clientId: null,
      subject: 'Aktueller Betreff',
    });

    await processors.get('reminder-done-notify')!(LEGACY_JOB);

    const written = JSON.stringify(h.notify.mock.calls[0]![1]);
    expect(written).toContain('Aktueller Betreff');
    expect(written).toContain('Maria Mitarbeiterin');
    expect(written).not.toContain('aus Redis');
    expect(h.notify.mock.calls[0]![1]).toMatchObject({
      staffId: 'partner-1',
      href: '/staff/reminders',
    });
  });

  it('nennt ohne bekannten Bearbeiter neutral „Ein Mitarbeiter"', async () => {
    h.findFirst.mockResolvedValue({
      doneAt: new Date(),
      doneByStaff: null,
      clientId: null,
      subject: 'X',
    });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.staffFindFirst).not.toHaveBeenCalled();
    expect(h.notify.mock.calls[0]![1]).toMatchObject({
      body: 'Ein Mitarbeiter hat die von dir delegierte Wiedervorlage abgeschlossen.',
    });
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
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('stellt NICHT zu, wenn zwischenzeitlich zurückgeholt wurde', async () => {
    h.findFirst.mockResolvedValue({ doneAt: null, clientId: 'client-1', subject: 'Test' });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.notify).not.toHaveBeenCalled();
  });

  it('stellt NICHT zu, wenn die Wiedervorlage gelöscht wurde', async () => {
    h.findFirst.mockResolvedValue(null);

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.notify).not.toHaveBeenCalled();
  });
});
