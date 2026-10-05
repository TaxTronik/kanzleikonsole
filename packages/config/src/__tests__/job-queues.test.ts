import { describe, expect, it } from 'vitest';

import {
  JOB_QUEUES,
  JOB_QUEUE_KEYS,
  QUEUE_HEALTH,
  QUEUE_STATUS_HISTORY_RETENTION_SECONDS,
  REMINDER_DONE_NOTIFY_JOB_OPTIONS,
  RISK_ANALYSE_LLM_JOB_OPTIONS,
  SCHEDULE_LOG_LABELS,
  scheduleLogLabel,
  type QueueJobDataByName,
  type QueueScheduleDefinition,
} from '../job-queues';

describe('shared BullMQ metadata', () => {
  it('keeps queue names unique and includes every definition in health metadata', () => {
    const names = Object.values(JOB_QUEUES).map((queue) => queue.name);

    expect(new Set(names).size).toBe(names.length);
    expect(QUEUE_HEALTH.map((queue) => queue.name)).toEqual(names);
  });

  it('lists the queue keys in declaration order for generated queues and schedulers', () => {
    expect(JOB_QUEUE_KEYS).toEqual(Object.keys(JOB_QUEUES));
    expect(Object.isFrozen(JOB_QUEUE_KEYS)).toBe(true);
  });

  it('models the real tax-news daytime cadence and overnight health gap', () => {
    expect(JOB_QUEUES.taxNewsFetch.schedule).toMatchObject({
      schedulerId: 'daily-tax-news-fetch',
      repeat: { pattern: '30 6-20/2 * * *', tz: 'Europe/Berlin' },
      expectedMaxGapMs: 10 * 60 * 60 * 1_000,
    });
    expect(SCHEDULE_LOG_LABELS).toContain('tax-news-fetch @ every 2 h, 06:30-20:30 Berlin');
  });

  it('health-checks frequent scheduled queues while leaving event queues unstaled', () => {
    const health = new Map(QUEUE_HEALTH.map((queue) => [queue.name, queue]));

    expect(JOB_QUEUES.auditAnchor.schedule.repeat).toEqual({ every: 2_000 });
    expect(health.get(JOB_QUEUES.auditAnchor.name)?.staleAfterMs).toBe(30_000);
    expect(health.get(JOB_QUEUES.n8nOutboxReconcile.name)?.staleAfterMs).toBe(7.5 * 60 * 1_000);
    expect(health.get(JOB_QUEUES.workflowN8nDispatch.name)?.staleAfterMs).toBe(1.5 * 60 * 1_000);
    expect(health.get(JOB_QUEUES.n8nDeliver.name)?.staleAfterMs).toBeNull();
    expect(health.get(JOB_QUEUES.riskAnalyseLlm.name)?.staleAfterMs).toBeNull();
  });

  it('retains a success marker beyond the longest stale window', () => {
    const longestStaleWindowMs = Math.max(
      ...QUEUE_HEALTH.flatMap((queue) => (queue.staleAfterMs == null ? [] : [queue.staleAfterMs])),
    );

    expect(QUEUE_STATUS_HISTORY_RETENTION_SECONDS * 1_000).toBeGreaterThan(longestStaleWindowMs);
  });

  it('keys producer-consumer contracts by their canonical queue names', () => {
    const riskJob = {
      tenantId: 'tenant-1',
      analysisId: 'analysis-1',
      sourceHash: 'a'.repeat(64),
    } satisfies QueueJobDataByName[typeof JOB_QUEUES.riskAnalyseLlm.name];
    const reminderJob = {
      tenantId: 'tenant-1',
      reminderId: 'reminder-1',
      staffId: 'staff-1',
    } satisfies QueueJobDataByName[typeof JOB_QUEUES.reminderDoneNotify.name];

    expect(riskJob.analysisId).toBe('analysis-1');
    expect(reminderJob.reminderId).toBe('reminder-1');
  });

  it('F-17 names an explicit time zone for every cron schedule', () => {
    const zones = Object.values(JOB_QUEUES).flatMap((queue) => {
      const schedule: QueueScheduleDefinition | null = queue.schedule;
      return schedule != null && 'pattern' in schedule.repeat
        ? [[queue.name, schedule.repeat.tz]]
        : [];
    });
    expect(Object.fromEntries(zones)).toEqual({
      'sanctions-refresh': 'Europe/Berlin',
      'evidence-seal': 'UTC',
      'audit-verify-check': 'UTC',
      'audit-rotate': 'UTC',
      'gwg-expiry-check': 'Europe/Berlin',
      'invoice-overdue-check': 'Europe/Berlin',
      'tax-deadline-materialize': 'Europe/Berlin',
      'tax-news-fetch': 'Europe/Berlin',
      'reminders-daily': 'Europe/Berlin',
      'magic-link-cleanup': 'UTC',
      'dsgvo-retention': 'UTC',
      'poa-expiry-check': 'Europe/Berlin',
      'backup-run': 'UTC',
      'backup-drill': 'UTC',
      'n8n-retention': 'UTC',
    });
  });

  it('F-17 derives the log labels from the registered repeat options', () => {
    expect(SCHEDULE_LOG_LABELS).toEqual([
      'mailbox-poll @ every 5 min',
      'sanctions-refresh @ 05:15 Berlin daily',
      'audit-anchor @ every 2 sec, per tenant >= 60 sec unless invoice/gwg',
      'evidence-seal @ 02:30 UTC daily',
      'audit-verify-check @ 02:45 UTC daily',
      'audit-rotate @ 03:00 UTC sundays',
      'gwg-expiry-check @ 07:00 Berlin daily',
      'invoice-overdue-check @ 07:15 Berlin daily',
      'tax-deadline-materialize @ 07:30 Berlin daily',
      'tax-news-fetch @ every 2 h, 06:30-20:30 Berlin',
      'reminders-daily @ 07:45 Berlin daily',
      'magic-link-cleanup @ 03:30 UTC daily',
      'dsgvo-retention @ 04:00 UTC daily',
      'poa-expiry-check @ 07:20 Berlin daily',
      'backup-run @ 01:00 UTC daily',
      'backup-drill @ 05:00 UTC 1st of month',
      'health-alert @ every 5 min',
      'n8n-outbox-reconcile @ every 5 min',
      'workflow-n8n-dispatch @ every 1 min',
      'workflow-feedback @ every 1 min',
      'workflow-auto-resume @ every 5 min',
      'storage-orphan-cleanup @ every 6 h',
      'portal-inbox-cleanup @ every 6 h',
      'n8n-retention @ 03:45 UTC daily',
    ]);

    const schedule = (repeat: QueueScheduleDefinition['repeat']): QueueScheduleDefinition => ({
      schedulerId: 'probe',
      repeat,
      expectedMaxGapMs: 1,
    });
    // A changed time zone or pattern changes the label with it.
    expect(
      scheduleLogLabel('probe', schedule({ pattern: '30 2 * * *', tz: 'Europe/Berlin' })),
    ).toBe('probe @ 02:30 Berlin daily');
    expect(scheduleLogLabel('probe', schedule({ pattern: '5 */4 * * 1-5', tz: 'UTC' }))).toBe(
      'probe @ cron "5 */4 * * 1-5" UTC',
    );
  });

  it('S-06 keeps LLM jobs without facts and bounds their history by age and count', () => {
    const riskJob: QueueJobDataByName[typeof JOB_QUEUES.riskAnalyseLlm.name] = {
      tenantId: 'tenant-1',
      analysisId: 'analysis-1',
      sourceHash: 'b'.repeat(64),
    };
    expect(Object.keys(riskJob).sort()).toEqual(['analysisId', 'sourceHash', 'tenantId']);
    expect(RISK_ANALYSE_LLM_JOB_OPTIONS).toEqual({
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
    });
  });

  it('S-06 keeps reminder-done jobs to ids and bounds their history by age and count', () => {
    const doneJob: QueueJobDataByName[typeof JOB_QUEUES.reminderDoneNotify.name] = {
      tenantId: 'tenant-1',
      reminderId: 'reminder-1',
      staffId: 'staff-1',
    };
    expect(Object.keys(doneJob).sort()).toEqual(['reminderId', 'staffId', 'tenantId']);
    expect(REMINDER_DONE_NOTIFY_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
    });
  });
});
