// Fachkatalog: REMINDER-TICKET-001
// S-06 (Folgearbeit): Die verzögerte Erledigt-Benachrichtigung legt nur IDs in
// Redis ab und begrenzt die Job-Historie nach Alter und Anzahl.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../bullmq', () => ({
  WEB_QUEUE_TIMEOUT_MS: 2_000,
  getWebQueue: vi.fn(() => ({ add: h.add, remove: h.remove })),
}));
vi.mock('@/server/logger', () => ({ log: h.log }));

import {
  REMINDER_DONE_NOTIFY_DELAY_MS,
  scheduleReminderDoneNotification,
} from '../reminder-done-queue';

beforeEach(() => {
  vi.clearAllMocks();
  h.add.mockResolvedValue({ id: 'reminder-done-reminder-1' });
  h.remove.mockResolvedValue(1);
});

describe('S-06 reminder-done job payload', () => {
  it('reiht nur IDs ein, mit Rücknahme-Verzögerung und altersbegrenzter Historie', async () => {
    // Ein Aufrufer mit Altfeldern darf sie nicht nach Redis durchreichen.
    const legacyShaped = {
      tenantId: 'tenant-1',
      reminderId: 'reminder-1',
      staffId: 'staff-1',
      subject: 'Vertraulicher Betreff',
      doneByName: 'Erika Beispiel',
    };

    await expect(scheduleReminderDoneNotification(legacyShaped)).resolves.toBe(true);

    expect(h.remove).toHaveBeenCalledWith('reminder-done-reminder-1');
    expect(h.add).toHaveBeenCalledWith(
      'notify',
      { tenantId: 'tenant-1', reminderId: 'reminder-1', staffId: 'staff-1' },
      {
        jobId: 'reminder-done-reminder-1',
        delay: REMINDER_DONE_NOTIFY_DELAY_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 86_400, count: 100 },
        removeOnFail: { age: 604_800, count: 200 },
      },
    );
    expect(JSON.stringify(h.add.mock.calls)).not.toMatch(/Vertraulicher|Erika/);
  });
});
