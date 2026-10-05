import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upserts: new Map<string, ReturnType<typeof vi.fn>>(),
  logInfo: vi.fn(),
}));

vi.mock('../queues', async () => {
  const { JOB_QUEUE_KEYS } = await import('@taxtronik/config/job-queues');
  const queues: Record<string, { upsertJobScheduler: ReturnType<typeof vi.fn> }> = {};
  for (const key of JOB_QUEUE_KEYS) {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    mocks.upserts.set(key, upsertJobScheduler);
    queues[key] = { upsertJobScheduler };
  }
  return { queues };
});

vi.mock('../logger', () => ({
  log: { info: mocks.logInfo },
}));

import { JOB_QUEUES, JOB_QUEUE_KEYS, SCHEDULE_LOG_LABELS } from '@taxtronik/config/job-queues';
import { setupSchedules } from '../scheduler';

const MINUTE = 60_000;
const DAILY_RETRY = { attempts: 3, backoff: { type: 'exponential', delay: 5 * MINUTE } };
const BACKUP_RETRY = { attempts: 2, backoff: { type: 'exponential', delay: 30 * MINUTE } };
const BERLIN = 'Europe/Berlin';
// F-17: the eight nightly jobs that had no `tz` now name UTC explicitly.
const UTC = 'UTC';

/**
 * Frozen copy of the 23 hand-written upsertJobScheduler calls that existed before
 * R-13 (scheduler ID, repeat options, retry options). The generated scheduler
 * must register exactly these; the only change since is the explicit `tz` (F-17).
 */
const LEGACY_SCHEDULES: Record<string, [string, object, object | undefined]> = {
  mailboxPoll: ['periodic-mailbox-poll', { every: 5 * MINUTE }, undefined],
  sanctionsRefresh: ['daily-sanctions-refresh', { pattern: '15 5 * * *', tz: BERLIN }, DAILY_RETRY],
  auditAnchor: ['rolling-audit-anchor', { every: 2_000 }, undefined],
  evidenceSeal: ['daily-seal', { pattern: '30 2 * * *', tz: UTC }, DAILY_RETRY],
  auditVerify: ['daily-audit-verify', { pattern: '45 2 * * *', tz: UTC }, DAILY_RETRY],
  auditRotate: ['weekly-audit-rotate', { pattern: '0 3 * * 0', tz: UTC }, DAILY_RETRY],
  gwgExpiry: ['daily-gwg-expiry', { pattern: '0 7 * * *', tz: BERLIN }, DAILY_RETRY],
  invoiceOverdue: ['daily-invoice-overdue', { pattern: '15 7 * * *', tz: BERLIN }, DAILY_RETRY],
  taxDeadlineMaterialize: [
    'daily-tax-deadline-materialize',
    { pattern: '30 7 * * *', tz: BERLIN },
    DAILY_RETRY,
  ],
  taxNewsFetch: ['daily-tax-news-fetch', { pattern: '30 6-20/2 * * *', tz: BERLIN }, DAILY_RETRY],
  remindersDaily: ['daily-reminders', { pattern: '45 7 * * *', tz: BERLIN }, DAILY_RETRY],
  magicLinkCleanup: ['daily-magic-link-cleanup', { pattern: '30 3 * * *', tz: UTC }, DAILY_RETRY],
  dsgvoRetention: ['daily-dsgvo-retention', { pattern: '0 4 * * *', tz: UTC }, DAILY_RETRY],
  poaExpiry: ['daily-poa-expiry', { pattern: '20 7 * * *', tz: BERLIN }, DAILY_RETRY],
  backupRun: ['daily-backup-run', { pattern: '0 1 * * *', tz: UTC }, BACKUP_RETRY],
  backupDrill: ['monthly-backup-drill', { pattern: '0 5 1 * *', tz: UTC }, BACKUP_RETRY],
  healthAlert: ['health-alert', { every: 5 * MINUTE }, undefined],
  n8nOutboxReconcile: ['n8n-outbox-reconcile', { every: 5 * MINUTE }, undefined],
  workflowN8nDispatch: ['workflow-n8n-dispatch-reconcile', { every: MINUTE }, undefined],
  workflowFeedback: ['workflow-feedback', { every: MINUTE }, undefined],
  storageOrphanCleanup: ['storage-orphan-cleanup', { every: 6 * 60 * MINUTE }, DAILY_RETRY],
  portalInboxCleanup: ['portal-inbox-cleanup', { every: 6 * 60 * MINUTE }, DAILY_RETRY],
  n8nRetention: ['daily-n8n-retention', { pattern: '45 3 * * *', tz: UTC }, DAILY_RETRY],
};

describe('R-13 generated repeat schedulers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupSchedules();
  });

  it('registers one scheduler per scheduled JOB_QUEUES entry and none for event queues', () => {
    const scheduled = JOB_QUEUE_KEYS.filter((key) => JOB_QUEUES[key].schedule != null);
    expect(scheduled).toEqual(Object.keys(LEGACY_SCHEDULES));
    for (const key of JOB_QUEUE_KEYS) {
      expect(mocks.upserts.get(key)!).toHaveBeenCalledTimes(scheduled.includes(key) ? 1 : 0);
    }
  });

  it('keeps scheduler IDs, repeat options, job names and retry options unchanged', () => {
    for (const [key, [schedulerId, repeat, opts]] of Object.entries(LEGACY_SCHEDULES)) {
      const name = JOB_QUEUES[key as keyof typeof JOB_QUEUES].name;
      const [id, actualRepeat, template] = mocks.upserts.get(key)!.mock.calls[0]!;
      expect(id).toBe(schedulerId);
      expect(actualRepeat).toStrictEqual(repeat);
      expect(template).toStrictEqual(opts ? { name, data: {}, opts } : { name, data: {} });
    }
  });

  it('logs the shared schedule labels once all schedulers are registered', () => {
    expect(mocks.logInfo).toHaveBeenCalledWith(
      { schedules: SCHEDULE_LOG_LABELS },
      'scheduler: registered',
    );
  });
});
