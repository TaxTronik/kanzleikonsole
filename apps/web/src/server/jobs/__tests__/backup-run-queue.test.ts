// P-22: feste jobId je Tenant; BullMQ legt je ID höchstens einen Job an.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getJob: vi.fn(),
  remove: vi.fn(),
  add: vi.fn(),
}));
vi.mock('../bullmq', () => ({
  WEB_QUEUE_TIMEOUT_MS: 2_000,
  getWebQueue: () => ({ getJob: m.getJob, remove: m.remove, add: m.add }),
}));

import { enqueueManualBackup, getManualBackupJobState } from '../backup-run-queue';

beforeEach(() => {
  vi.clearAllMocks();
  m.remove.mockResolvedValue(1);
  m.add.mockResolvedValue({ id: 'backup-run-manual-tenant-1' });
});

describe('enqueueManualBackup', () => {
  it('reiht den Worker-Job backup-run mit fester jobId ein', async () => {
    m.getJob.mockResolvedValue(null);

    expect(await enqueueManualBackup('tenant-1', 'staff-1')).toBe(true);
    expect(m.remove).toHaveBeenCalledWith('backup-run-manual-tenant-1');
    expect(m.add).toHaveBeenCalledWith(
      'backup-run',
      { tenantId: 'tenant-1', requestedByStaffId: 'staff-1' },
      expect.objectContaining({ jobId: 'backup-run-manual-tenant-1', attempts: 1 }),
    );
    expect(m.remove).toHaveBeenCalledBefore(m.add);
  });

  it.each(['waiting', 'delayed', 'active'])('lässt einen %s-Lauf unangetastet', async (state) => {
    m.getJob.mockResolvedValue({ getState: async () => state });

    expect(await enqueueManualBackup('tenant-1', 'staff-1')).toBe(false);
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
  });

  it('ersetzt einen abgeschlossenen Vorlauf', async () => {
    m.getJob.mockResolvedValue({ getState: async () => 'completed' });

    expect(await enqueueManualBackup('tenant-1', 'staff-1')).toBe(true);
    expect(m.add).toHaveBeenCalledOnce();
  });
});

describe('getManualBackupJobState', () => {
  it('liefert null ohne bekannten Lauf', async () => {
    m.getJob.mockResolvedValue(undefined);
    expect(await getManualBackupJobState('tenant-1')).toBeNull();
  });
});
