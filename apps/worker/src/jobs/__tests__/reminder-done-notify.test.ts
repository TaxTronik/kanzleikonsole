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
  findUnique: vi.fn(),
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db/notification', () => ({
  upsertNotificationTx: h.upsertNotificationTx,
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ clientReminder: { findUnique: h.findUnique } }),
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

beforeEach(() => vi.clearAllMocks());

describe('reminder-done-notify', () => {
  it('stellt zu, wenn die Wiedervorlage noch erledigt ist', async () => {
    h.findUnique.mockResolvedValue({ doneAt: new Date() });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.upsertNotificationTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'CLIENT_REMINDER_DONE',
        staffId: 'partner-1',
        resourceId: 'rem-1',
        href: '/staff/clients/client-1',
      }),
    );
  });

  it('stellt NICHT zu, wenn zwischenzeitlich zurückgeholt wurde', async () => {
    h.findUnique.mockResolvedValue({ doneAt: null });

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });

  it('stellt NICHT zu, wenn die Wiedervorlage gelöscht wurde', async () => {
    h.findUnique.mockResolvedValue(null);

    await processors.get('reminder-done-notify')!(JOB);

    expect(h.upsertNotificationTx).not.toHaveBeenCalled();
  });
});
