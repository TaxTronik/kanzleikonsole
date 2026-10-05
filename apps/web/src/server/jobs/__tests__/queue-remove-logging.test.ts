// F-05: Ein gescheitertes queue.remove() (Job läuft noch oder Redis langsam)
// wird protokolliert statt verschluckt; der Ablauf bleibt derselbe.
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
  cancelReminderDoneNotification,
  scheduleReminderDoneNotification,
} from '../reminder-done-queue';
import { enqueueTaxDeadlineMaterialize } from '../tax-deadline-materialize-queue';

const locked = new Error('Job is locked');

beforeEach(() => {
  vi.clearAllMocks();
  h.add.mockResolvedValue({ id: 'job' });
  h.remove.mockRejectedValue(locked);
});

describe('F-05: queue.remove-Fehler werden protokolliert', () => {
  it('tax-deadline-materialize: loggt und reiht trotzdem idempotent ein', async () => {
    await enqueueTaxDeadlineMaterialize('tenant-1');

    expect(h.log.warn).toHaveBeenCalledWith(
      { component: 'tax-deadline-materialize-queue', tenantId: 'tenant-1', err: 'Job is locked' },
      expect.stringContaining('nicht entfernt'),
    );
    expect(h.add).toHaveBeenCalledWith(
      'tax-deadline-materialize',
      { tenantId: 'tenant-1' },
      expect.objectContaining({ jobId: 'tax-deadline-manual-tenant-1' }),
    );
  });

  it('reminder-done: Einplanen loggt den Vorgänger-Fehler und plant trotzdem ein', async () => {
    await expect(
      scheduleReminderDoneNotification({
        tenantId: 'tenant-1',
        reminderId: 'reminder-1',
        staffId: 'staff-1',
        clientId: 'client-1',
        subject: 'Betreff',
        doneByName: 'Erika',
      }),
    ).resolves.toBe(true);

    expect(h.log.warn).toHaveBeenCalledWith(
      { component: 'reminder-done-queue', reminderId: 'reminder-1', err: 'Job is locked' },
      expect.stringContaining('nicht entfernt'),
    );
    expect(h.add).toHaveBeenCalledOnce();
  });

  it('reminder-done: Rücknahme bleibt best-effort, der Fehler wird protokolliert', async () => {
    await expect(cancelReminderDoneNotification('reminder-1')).resolves.toBeUndefined();

    expect(h.log.warn).toHaveBeenCalledWith(
      { component: 'reminder-done-queue', reminderId: 'reminder-1', err: 'Job is locked' },
      expect.stringContaining('nicht zurückgenommen'),
    );
  });
});
