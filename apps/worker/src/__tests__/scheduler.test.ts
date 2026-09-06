import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const queue = () => ({ upsertJobScheduler: vi.fn().mockResolvedValue(undefined) });
  return {
    mailboxPollQueue: queue(),
    sanctionsRefreshQueue: queue(),
    auditAnchorQueue: queue(),
    evidenceSealQueue: queue(),
    auditVerifyQueue: queue(),
    gwgExpiryQueue: queue(),
    invoiceOverdueQueue: queue(),
    taxDeadlineMaterializeQueue: queue(),
    auditRotateQueue: queue(),
    taxNewsFetchQueue: queue(),
    remindersDailyQueue: queue(),
    n8nOutboxReconcileQueue: queue(),
    workflowN8nDispatchQueue: queue(),
    workflowFeedbackQueue: queue(),
    storageOrphanCleanupQueue: queue(),
    portalInboxCleanupQueue: queue(),
    n8nRetentionQueue: queue(),
    magicLinkCleanupQueue: queue(),
    dsgvoRetentionQueue: queue(),
    poaExpiryQueue: queue(),
    backupRunQueue: queue(),
    backupDrillQueue: queue(),
    healthAlertQueue: queue(),
    logInfo: vi.fn(),
  };
});

vi.mock('../queues', () => ({
  mailboxPollQueue: mocks.mailboxPollQueue,
  sanctionsRefreshQueue: mocks.sanctionsRefreshQueue,
  auditAnchorQueue: mocks.auditAnchorQueue,
  evidenceSealQueue: mocks.evidenceSealQueue,
  auditVerifyQueue: mocks.auditVerifyQueue,
  gwgExpiryQueue: mocks.gwgExpiryQueue,
  invoiceOverdueQueue: mocks.invoiceOverdueQueue,
  taxDeadlineMaterializeQueue: mocks.taxDeadlineMaterializeQueue,
  auditRotateQueue: mocks.auditRotateQueue,
  taxNewsFetchQueue: mocks.taxNewsFetchQueue,
  remindersDailyQueue: mocks.remindersDailyQueue,
  n8nOutboxReconcileQueue: mocks.n8nOutboxReconcileQueue,
  workflowN8nDispatchQueue: mocks.workflowN8nDispatchQueue,
  workflowFeedbackQueue: mocks.workflowFeedbackQueue,
  storageOrphanCleanupQueue: mocks.storageOrphanCleanupQueue,
  portalInboxCleanupQueue: mocks.portalInboxCleanupQueue,
  n8nRetentionQueue: mocks.n8nRetentionQueue,
  magicLinkCleanupQueue: mocks.magicLinkCleanupQueue,
  dsgvoRetentionQueue: mocks.dsgvoRetentionQueue,
  poaExpiryQueue: mocks.poaExpiryQueue,
  backupRunQueue: mocks.backupRunQueue,
  backupDrillQueue: mocks.backupDrillQueue,
  healthAlertQueue: mocks.healthAlertQueue,
}));

vi.mock('../logger', () => ({
  log: { info: mocks.logInfo },
}));

import { JOB_QUEUES, SCHEDULE_LOG_LABELS } from '@taxtronik/config/job-queues';
import { setupSchedules } from '../scheduler';

describe('worker schedule metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers drift-prone schedules from the shared definitions', async () => {
    await setupSchedules();
    expect(mocks.mailboxPollQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.mailboxPoll.schedule.schedulerId,
      JOB_QUEUES.mailboxPoll.schedule.repeat,
      expect.objectContaining({ name: JOB_QUEUES.mailboxPoll.name }),
    );
    expect(mocks.sanctionsRefreshQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.sanctionsRefresh.schedule.schedulerId,
      JOB_QUEUES.sanctionsRefresh.schedule.repeat,
      expect.objectContaining({ name: JOB_QUEUES.sanctionsRefresh.name }),
    );

    expect(mocks.auditAnchorQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.auditAnchor.schedule.schedulerId,
      JOB_QUEUES.auditAnchor.schedule.repeat,
      { name: JOB_QUEUES.auditAnchor.name, data: {} },
    );
    expect(mocks.taxNewsFetchQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.taxNewsFetch.schedule.schedulerId,
      JOB_QUEUES.taxNewsFetch.schedule.repeat,
      expect.objectContaining({ name: JOB_QUEUES.taxNewsFetch.name, data: {} }),
    );
    expect(mocks.n8nOutboxReconcileQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.n8nOutboxReconcile.schedule.schedulerId,
      JOB_QUEUES.n8nOutboxReconcile.schedule.repeat,
      { name: JOB_QUEUES.n8nOutboxReconcile.name, data: {} },
    );
    expect(mocks.workflowFeedbackQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.workflowFeedback.schedule.schedulerId,
      JOB_QUEUES.workflowFeedback.schedule.repeat,
      { name: JOB_QUEUES.workflowFeedback.name, data: {} },
    );
    expect(mocks.portalInboxCleanupQueue.upsertJobScheduler).toHaveBeenCalledWith(
      JOB_QUEUES.portalInboxCleanup.schedule.schedulerId,
      JOB_QUEUES.portalInboxCleanup.schedule.repeat,
      expect.objectContaining({ name: JOB_QUEUES.portalInboxCleanup.name, data: {} }),
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      { schedules: SCHEDULE_LOG_LABELS },
      'scheduler: registered',
    );
  });
});
