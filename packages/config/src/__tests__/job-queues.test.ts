import { describe, expect, it } from 'vitest';

import {
  JOB_QUEUES,
  QUEUE_HEALTH,
  QUEUE_STATUS_HISTORY_RETENTION_SECONDS,
  SCHEDULE_LOG_LABELS,
  type QueueJobDataByName,
} from '../job-queues';

describe('shared BullMQ metadata', () => {
  it('keeps queue names unique and includes every definition in health metadata', () => {
    const names = Object.values(JOB_QUEUES).map((queue) => queue.name);

    expect(new Set(names).size).toBe(names.length);
    expect(QUEUE_HEALTH.map((queue) => queue.name)).toEqual(names);
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
      sourceText: 'Sachverhalt',
      optionen: { mitLLM: true },
    } satisfies QueueJobDataByName[typeof JOB_QUEUES.riskAnalyseLlm.name];
    const reminderJob = {
      tenantId: 'tenant-1',
      reminderId: 'reminder-1',
      staffId: 'staff-1',
      clientId: null,
      subject: 'Wiedervorlage',
      doneByName: 'Erika Muster',
    } satisfies QueueJobDataByName[typeof JOB_QUEUES.reminderDoneNotify.name];

    expect(riskJob.analysisId).toBe('analysis-1');
    expect(reminderJob.clientId).toBeNull();
  });
});
