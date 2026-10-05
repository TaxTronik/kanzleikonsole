import { describe, expect, it, vi } from 'vitest';

// Real job modules are imported; only their runtime connections are replaced.
const mocks = vi.hoisted(() => ({
  workers: [] as Array<{
    name: string;
    opts: { concurrency?: number } | undefined;
    events: string[];
  }>,
}));

vi.mock('bullmq', () => ({
  Worker: class WorkerMock {
    constructor(
      public name: string,
      _processor: unknown,
      opts?: { concurrency?: number },
    ) {
      mocks.workers.push({ name, opts, events: [] });
    }
    on(event: string) {
      mocks.workers.find((worker) => worker.name === this.name)!.events.push(event);
      return this;
    }
  },
  Queue: class QueueMock {
    constructor(public name: string) {}
  },
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
vi.mock('../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../prisma-owner', () => ({ prismaOwner: {} }));

import { JOB_QUEUES, JOB_QUEUE_KEYS } from '@taxtronik/config/job-queues';
import { ALL_WORKERS, buildWorkerRegistry } from '../worker-registry';

/** Worker concurrency before R-13 (undefined = BullMQ default of 1), plus later queues. */
const LEGACY_CONCURRENCY: Record<string, number | undefined> = {
  'mailbox-poll': 1,
  'sanctions-refresh': 1,
  'audit-anchor': 4,
  'evidence-seal': 1,
  'audit-verify-check': 1,
  'audit-rotate': 1,
  'gwg-expiry-check': 1,
  'invoice-overdue-check': 1,
  'tax-deadline-materialize': 1,
  'tax-news-fetch': 1,
  'reminders-daily': 1,
  'magic-link-cleanup': undefined,
  'dsgvo-retention': undefined,
  'poa-expiry-check': 1,
  'backup-run': 1,
  'backup-drill': 1,
  'health-alert': 1,
  'n8n-deliver': 4,
  'n8n-outbox-reconcile': undefined,
  'workflow-n8n-dispatch': 1,
  'workflow-feedback': 1,
  // F-13: new queue.
  'workflow-auto-resume': 1,
  'storage-orphan-cleanup': 1,
  'portal-inbox-cleanup': 1,
  'n8n-retention': 1,
  'risk-analyse-llm': 1,
  'reminder-done-notify': 4,
};

describe('R-13 worker registry', () => {
  it('holds exactly one worker per JOB_QUEUES entry, in JOB_QUEUES order', () => {
    const names = Object.values(JOB_QUEUES).map((queue) => queue.name);
    expect(ALL_WORKERS.map((worker) => worker.name)).toEqual(names);
    expect(mocks.workers.map((worker) => worker.name).sort()).toEqual([...names].sort());
  });

  it('keeps every worker concurrency unchanged', () => {
    expect(Object.keys(LEGACY_CONCURRENCY).sort()).toEqual(
      Object.values(JOB_QUEUES)
        .map((queue) => queue.name)
        .sort(),
    );
    for (const { name, opts } of mocks.workers) {
      expect({ name, concurrency: opts?.concurrency }).toEqual({
        name,
        concurrency: LEGACY_CONCURRENCY[name],
      });
    }
  });

  it('F-05: builds every worker through createWorker with failed and error logging', () => {
    // Exactly the factory's handlers: no job registers its own, redundant one.
    for (const { name, events } of mocks.workers) {
      expect({ name, events: [...events].sort() }).toEqual({ name, events: ['error', 'failed'] });
    }
  });

  it('rejects a worker registered under the wrong queue key', () => {
    const byQueue = Object.fromEntries(
      JOB_QUEUE_KEYS.map((key) => [key, { name: JOB_QUEUES[key].name }]),
    ) as Record<(typeof JOB_QUEUE_KEYS)[number], { name: string }>;
    expect(buildWorkerRegistry(byQueue).map((worker) => worker.name)).toEqual(
      JOB_QUEUE_KEYS.map((key) => JOB_QUEUES[key].name),
    );

    expect(() =>
      buildWorkerRegistry({ ...byQueue, backupRun: { name: JOB_QUEUES.backupDrill.name } }),
    ).toThrow(/backupRun erwartet Queue "backup-run"/);
  });
});
